import { constants, createReadStream, createWriteStream } from 'node:fs';
import { chmod, copyFile, mkdir } from 'node:fs/promises';
import { dirname, isAbsolute, join, posix, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import { extract as extractTar } from 'tar-stream';
import { open as openZip, type ZipFile } from 'yauzl';
import { AppError } from '@lodex/contracts';

export interface EngineFile {
  path: string;
  bytes: number;
  sha256: string;
  executable: boolean;
}
export function archivePath(value: string) {
  const path = value.replace(/\/$/, '').replace(/^\.\//, '');
  if (
    !path ||
    path.length > 1000 ||
    isAbsolute(path) ||
    /^[A-Za-z]:/.test(path) ||
    /[\\\0-\x1f:]/.test(path) ||
    path
      .split('/')
      .some(
        (part) =>
          !part ||
          part === '.' ||
          part === '..' ||
          /[. ]$/.test(part) ||
          /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
      )
  )
    throw new AppError('ENGINE_ARCHIVE_PATH', '압축 파일에 안전하지 않은 경로가 있습니다.');
  return path;
}
export async function extractEngineArchive(
  archive: string,
  root: string,
  format: 'zip' | 'tar.gz',
  signal: AbortSignal,
  limits = { bytes: 8_589_934_592, entries: 20000 },
) {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const files = new Map<string, EngineFile>();
  const names = new Set<string>();
  const links: { path: string; target: string }[] = [];
  let bytes = 0,
    count = 0;
  const claim = (name: string, directory: boolean) => {
    if (++count > limits.entries)
      throw new AppError('ENGINE_ARCHIVE_SIZE', '압축 파일의 항목 수가 너무 많습니다.');
    const path = archivePath(name);
    const canonical = path.toLowerCase();
    if (!directory && names.has(canonical))
      throw new AppError('ENGINE_ARCHIVE_DUPLICATE', '중복된 압축 파일 경로입니다.');
    names.add(canonical);
    return path;
  };
  const write = async (
    path: string,
    size: number,
    executable: boolean,
    input: AsyncIterable<unknown>,
  ) => {
    if (
      !Number.isSafeInteger(size) ||
      size < 0 ||
      size > 2_147_483_648 ||
      bytes + size > limits.bytes
    )
      throw new AppError('ENGINE_ARCHIVE_SIZE', '압축 해제 크기가 허용 범위를 초과합니다.');
    await mkdir(dirname(join(root, path)), { recursive: true, mode: 0o700 });
    const hash = createHash('sha256');
    let written = 0;
    const bound = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        written += chunk.length;
        bytes += chunk.length;
        if (written > size || bytes > limits.bytes)
          done(new AppError('ENGINE_ARCHIVE_SIZE', '압축 해제 크기가 안내된 값과 다릅니다.'));
        else {
          hash.update(chunk);
          done(null, chunk);
        }
      },
    });
    await pipeline(
      input,
      bound,
      createWriteStream(join(root, path), { flags: 'wx', mode: executable ? 0o700 : 0o600 }),
      { signal },
    );
    if (written !== size) throw new AppError('ENGINE_ARCHIVE_SIZE', '압축 파일이 잘렸습니다.');
    files.set(path, { path, bytes: size, sha256: hash.digest('hex'), executable });
  };
  const addLink = (path: string, target: string, hard = false) => {
    if (!target || /[\\\0-\x1f:]/.test(target) || posix.isAbsolute(target))
      throw new AppError('ENGINE_ARCHIVE_LINK', '압축 파일의 링크 대상이 안전하지 않습니다.');
    const resolved = posix.normalize(hard ? target : posix.join(posix.dirname(path), target));
    const safe = archivePath(resolved);
    links.push({ path, target: safe });
  };
  if (format === 'tar.gz') {
    const extractor = extractTar();
    extractor.on('entry', (header, stream, next) => {
      void (async () => {
        signal.throwIfAborted();
        const directory = header.type === 'directory';
        // The root marker carries no user-selectable filesystem path.
        if ((header.name === '.' || header.name === './') && directory) {
          stream.resume();
          return;
        }
        const path = claim(header.name, directory);
        if (directory) {
          await mkdir(join(root, path), { recursive: true, mode: 0o700 });
          stream.resume();
        } else if (header.type === 'symlink' || header.type === 'link') {
          addLink(path, header.linkname ?? '', header.type === 'link');
          stream.resume();
        } else if (header.type === 'file' || header.type === undefined || header.type === null)
          await write(path, header.size ?? 0, !!((header.mode ?? 0) & 0o111), stream);
        else
          throw new AppError(
            'ENGINE_ARCHIVE_TYPE',
            '장치·특수 파일은 엔진 압축에 사용할 수 없습니다.',
          );
      })().then(
        () => next(),
        (error) => next(error),
      );
    });
    await pipeline(createReadStream(archive), createGunzip(), extractor, { signal });
  } else {
    const zip = await new Promise<ZipFile>((yes, no) =>
      openZip(
        archive,
        { lazyEntries: true, validateEntrySizes: true, strictFileNames: true },
        (error, file) => (error || !file ? no(error ?? new Error('ZIP open failed')) : yes(file)),
      ),
    );
    try {
      await new Promise<void>((yes, no) => {
        zip.on('error', no);
        zip.on('end', yes);
        zip.on('entry', (entry) => {
          void (async () => {
            signal.throwIfAborted();
            const mode = entry.externalFileAttributes >>> 16;
            const kind = mode & 0o170000;
            const directory = entry.fileName.endsWith('/');
            const path = claim(entry.fileName, directory);
            if (entry.isEncrypted())
              throw new AppError('ENGINE_ARCHIVE_TYPE', '암호화된 엔진 압축은 지원하지 않습니다.');
            if (directory) {
              await mkdir(join(root, path), { recursive: true, mode: 0o700 });
              return;
            }
            if (kind && kind !== 0o100000 && kind !== 0o120000)
              throw new AppError('ENGINE_ARCHIVE_TYPE', '압축 파일에 특수 파일이 있습니다.');
            const stream = await new Promise<Readable>((resolve, reject) =>
              zip.openReadStream(entry, (error, stream) =>
                error || !stream ? reject(error ?? new Error('ZIP entry failed')) : resolve(stream),
              ),
            );
            if (kind === 0o120000) {
              if (entry.uncompressedSize > 1000) {
                stream.destroy();
                throw new AppError('ENGINE_ARCHIVE_LINK', '압축 링크가 너무 깁니다.');
              }
              const chunks: Buffer[] = [];
              let total = 0;
              for await (const chunk of stream) {
                signal.throwIfAborted();
                total += chunk.length;
                if (total > 1000)
                  throw new AppError('ENGINE_ARCHIVE_LINK', '압축 링크가 너무 깁니다.');
                chunks.push(chunk);
              }
              addLink(path, Buffer.concat(chunks).toString('utf8'));
            } else await write(path, entry.uncompressedSize, !!(mode & 0o111), stream);
          })().then(() => zip.readEntry(), no);
        });
        zip.readEntry();
      });
    } finally {
      zip.close();
    }
  }
  // Materialize only links to verified in-archive regular files. No symlinks remain on disk.
  const materialize = async (link: { path: string; target: string }, visited: Set<string>) => {
    signal.throwIfAborted();
    if (visited.has(link.path) || visited.size > 16)
      throw new AppError('ENGINE_ARCHIVE_LINK', '순환 압축 링크는 사용할 수 없습니다.');
    let target = files.get(link.target);
    if (!target) {
      const next = links.find((item) => item.path === link.target);
      if (!next)
        throw new AppError(
          'ENGINE_ARCHIVE_LINK',
          '압축 파일 밖을 가리키거나 없는 파일을 가리키는 링크입니다.',
        );
      await materialize(next, new Set([...visited, link.path]));
      target = files.get(link.target)!;
    }
    if (files.has(link.path)) return;
    bytes += target.bytes;
    if (bytes > limits.bytes)
      throw new AppError('ENGINE_ARCHIVE_SIZE', '링크를 포함한 압축 해제 크기가 너무 큽니다.');
    const destination = resolve(root, link.path);
    if (!destination.startsWith(resolve(root) + sep))
      throw new AppError('ENGINE_ARCHIVE_PATH', '잘못된 압축 대상입니다.');
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await copyFile(join(root, target.path), destination, constants.COPYFILE_EXCL);
    await chmod(destination, target.executable ? 0o700 : 0o600);
    files.set(link.path, { ...target, path: link.path });
  };
  for (const link of links) await materialize(link, new Set());
  return [...files.values()];
}
