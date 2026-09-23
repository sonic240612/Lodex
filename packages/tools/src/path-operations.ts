import { createHash } from 'node:crypto';
import { lstat, mkdir, opendir, readFile, rename, rm, rmdir, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, sep } from 'node:path';
import { z } from 'zod';
import { AppError, type Project } from '@lodex/contracts';
import { resolveTarget, withProjectWrite } from './index';

const relativePath = z.string().min(1).max(4096);
const fingerprint = z.string().regex(/^[a-f0-9]{64}$/);
export const pathOperationSchemas = {
  inspect_path: z.strictObject({ path: relativePath }),
  make_directory: z.strictObject({ path: relativePath }),
  move_path: z.strictObject({
    source: relativePath,
    destination: relativePath,
    expectedFingerprint: fingerprint,
  }),
  delete_path: z.strictObject({
    path: relativePath,
    expectedFingerprint: fingerprint,
    recursive: z.boolean().default(false),
  }),
};

const absent = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT';
const blockedName = (name: string) =>
  [
    '.git',
    '.ssh',
    '.aws',
    '.gnupg',
    '.codex',
    'node_modules',
    '.venv',
    'venv',
    'target',
    'dist',
    'build',
    'secrets',
    'credentials',
  ].includes(name.toLowerCase()) ||
  ['secrets.json', 'credentials.json'].includes(name.toLowerCase()) ||
  /^\.env(?:\.|$)|^\.lodex-edit-|\.(?:pem|key|p12|pfx)$/i.test(name);

async function missingDestination(project: Project, path: string) {
  if (isAbsolute(path) || path.includes(':') || /[\x00-\x1f\x7f]/.test(path))
    throw new AppError('PATH_DENIED', '프로젝트 내부 상대 경로만 사용할 수 있습니다.');
  try {
    await resolveTarget(project, path);
    throw new AppError('PATH_EXISTS', '대상 경로가 이미 존재합니다.');
  } catch (error) {
    if (!absent(error)) throw error;
  }
  const portable = path.replaceAll('\\', '/');
  const leaf = basename(portable);
  if (!leaf || leaf === '.' || leaf === '..' || blockedName(leaf))
    throw new AppError('PATH_DENIED', '제외 폴더·비밀 파일 경로는 만들 수 없습니다.');
  const parent = await resolveTarget(project, dirname(portable));
  if (!parent.info.isDirectory())
    throw new AppError('NOT_DIRECTORY', '기존 프로젝트 폴더 안의 대상 경로가 필요합니다.');
  return join(parent.path, leaf);
}

type PathInspection = {
  path: string;
  kind: 'file' | 'directory';
  fingerprint: string;
  entries: number;
  bytes: number;
};

async function inspect(
  project: Project,
  path: string,
  signal: AbortSignal,
): Promise<PathInspection> {
  signal.throwIfAborted();
  const target = await resolveTarget(project, path);
  const root = await resolveTarget(project, '.');
  if (target.path === root.path)
    throw new AppError('PROJECT_ROOT', '프로젝트 루트 자체는 이동하거나 삭제할 수 없습니다.');
  const hash = createHash('sha256');
  let entries = 0;
  let bytes = 0;
  const walk = async (absolute: string, portable: string): Promise<void> => {
    signal.throwIfAborted();
    const info = await lstat(absolute);
    if (info.isSymbolicLink())
      throw new AppError('PATH_DENIED', '심볼릭 링크·junction이 포함된 경로는 변경할 수 없습니다.');
    if (++entries > 2000)
      throw new AppError('PATH_LIMIT', '한 번에 확인할 수 있는 파일·폴더 수를 초과했습니다.');
    if (info.isFile()) {
      if (info.size > 8 * 1024 * 1024 || bytes + info.size > 32 * 1024 * 1024)
        throw new AppError('PATH_LIMIT', '이동·삭제할 경로의 확인 크기 제한을 초과했습니다.');
      const content = await readFile(absolute);
      signal.throwIfAborted();
      const after = await lstat(absolute);
      if (after.dev !== info.dev || after.ino !== info.ino || after.size !== info.size)
        throw new AppError('PATH_CHANGED', '확인하는 동안 파일이 변경되었습니다.');
      bytes += content.byteLength;
      hash.update(`f\0${portable}\0${content.byteLength}\0`);
      hash.update(content);
      return;
    }
    if (!info.isDirectory())
      throw new AppError('PATH_UNSUPPORTED', '일반 파일과 폴더만 이동하거나 삭제할 수 있습니다.');
    hash.update(`d\0${portable}\0`);
    const children: string[] = [];
    for await (const entry of await opendir(absolute)) children.push(entry.name);
    children.sort((a, b) => a.localeCompare(b));
    for (const name of children) {
      if (blockedName(name))
        throw new AppError(
          'PATH_DENIED',
          '비밀 파일이나 제외 폴더가 포함된 경로는 이동하거나 삭제할 수 없습니다.',
        );
      await walk(join(absolute, name), portable ? `${portable}/${name}` : name);
    }
  };
  await walk(target.path, '');
  return {
    path,
    kind: target.info.isDirectory() ? 'directory' : 'file',
    fingerprint: hash.digest('hex'),
    entries,
    bytes,
  };
}

export async function runPathOperation(
  project: Project,
  name: keyof typeof pathOperationSchemas,
  value: unknown,
  signal: AbortSignal,
  authorize?: (paths: string[], destructive: boolean) => Promise<boolean>,
) {
  if (name === 'inspect_path') {
    const args = pathOperationSchemas.inspect_path.parse(value);
    return inspect(project, args.path, signal);
  }
  if (name === 'make_directory') {
    const args = pathOperationSchemas.make_directory.parse(value);
    if (!(await authorize?.([args.path], false))) return { status: 'rejected' };
    return withProjectWrite(project, async () => {
      const destination = await missingDestination(project, args.path);
      signal.throwIfAborted();
      await mkdir(destination, { recursive: false, mode: 0o755 });
      const created = await resolveTarget(project, args.path);
      if (!created.info.isDirectory())
        throw new AppError('PATH_CHANGED', '생성된 경로가 폴더가 아닙니다.');
      return { status: 'created', path: args.path };
    });
  }
  if (name === 'move_path') {
    const args = pathOperationSchemas.move_path.parse(value);
    if (!(await authorize?.([args.source, args.destination], false))) return { status: 'rejected' };
    return withProjectWrite(project, async () => {
      const before = await inspect(project, args.source, signal);
      if (before.fingerprint !== args.expectedFingerprint)
        throw new AppError('PATH_CHANGED', '검토 후 원본 경로가 변경되었습니다.', 409);
      const source = await resolveTarget(project, args.source);
      const destination = await missingDestination(project, args.destination);
      if (source.path.toLowerCase() === destination.toLowerCase())
        throw new AppError('PATH_SAME', '원본과 대상 경로가 같습니다.');
      if (source.info.isDirectory() && destination.startsWith(source.path + sep))
        throw new AppError('PATH_CHILD', '폴더를 자기 하위 경로로 이동할 수 없습니다.');
      signal.throwIfAborted();
      await rename(source.path, destination);
      const moved = await inspect(project, args.destination, signal);
      if (moved.fingerprint !== before.fingerprint)
        throw new AppError('PATH_OUTCOME_UNKNOWN', '이동 후 경로 내용을 확인하지 못했습니다.');
      return { status: 'moved', source: args.source, destination: args.destination };
    });
  }
  const args = pathOperationSchemas.delete_path.parse(value);
  if (!(await authorize?.([args.path], true))) return { status: 'rejected' };
  return withProjectWrite(project, async () => {
    const before = await inspect(project, args.path, signal);
    if (before.fingerprint !== args.expectedFingerprint)
      throw new AppError('PATH_CHANGED', '검토 후 삭제 대상이 변경되었습니다.', 409);
    const target = await resolveTarget(project, args.path);
    if (before.kind === 'directory' && before.entries > 1 && !args.recursive)
      throw new AppError(
        'DIRECTORY_NOT_EMPTY',
        '비어 있지 않은 폴더 삭제에는 recursive=true가 필요합니다.',
      );
    signal.throwIfAborted();
    if (before.kind === 'directory') {
      if (args.recursive) await rm(target.path, { recursive: true, force: false, maxRetries: 0 });
      else await rmdir(target.path);
    } else await unlink(target.path);
    try {
      await lstat(target.path);
      throw new AppError('PATH_OUTCOME_UNKNOWN', '삭제 후에도 대상 경로가 남아 있습니다.');
    } catch (error) {
      if (!absent(error)) throw error;
    }
    return { status: 'deleted', path: args.path, entries: before.entries, bytes: before.bytes };
  });
}
