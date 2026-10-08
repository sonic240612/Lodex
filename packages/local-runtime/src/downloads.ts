import { constants, type BigIntStats } from 'node:fs';
import {
  lstat as nodeLstat,
  mkdir,
  rename,
  open,
  unlink,
  link,
  realpath,
  type FileHandle,
} from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join, relative, resolve, sep } from 'node:path';
import {
  AppError,
  modelDownloadInputSchema,
  modelDownloadSchema,
  type ModelDownload,
  type ModelDownloadInput,
  type ModelDownloadPart,
} from '@lodex/contracts';
import { splitModelFiles } from './model-files';

const maximumBytes = 1_099_511_627_776;
// NTFS file IDs exceed Number's exact range. Never round identity checks.
const lstat = (path: string) => nodeLstat(path, { bigint: true });
type DownloadJob = { controller: AbortController; promise: Promise<void> };
type Verify = (path: string) => Promise<unknown>;
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
const strongEtag = (value: string | null) =>
  value && /^"[^"\r\n]{1,1000}"$/.test(value) ? value : undefined;

export class ModelDownloads {
  private records = new Map<string, ModelDownload>();
  private jobs = new Map<string, DownloadJob>();
  private ready: Promise<void>;
  private manifestQueue: Promise<unknown> = Promise.resolve();
  private closing = false;
  private canonicalRoot: string | undefined;
  private rootIdentity: BigIntStats | undefined;
  constructor(
    private root: string | undefined,
    private fetcher: typeof fetch,
    private verify: Verify,
  ) {
    this.ready = this.restore();
  }
  async snapshot() {
    await this.ready;
    return [...this.records.values()]
      .map((record) => structuredClone(record))
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }
  private manifestPath() {
    return this.canonicalRoot ? join(this.canonicalRoot, '.downloads.json') : undefined;
  }
  private persist() {
    const path = this.manifestPath();
    if (!path) return Promise.resolve();
    const document = JSON.stringify({ version: 1, downloads: [...this.records.values()] });
    const task = this.manifestQueue.then(async () => {
      await this.secureParent(path);
      const temporary = path + '.' + randomUUID() + '.tmp';
      const handle = await open(temporary, 'wx', 0o600);
      try {
        await handle.writeFile(document, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      try {
        await this.secureParent(path);
        const existing = await lstat(path).catch((error) => {
          if (!missing(error)) throw error;
          return undefined;
        });
        if (existing && (!existing.isFile() || existing.isSymbolicLink())) throw this.pathError();
        await rename(temporary, path);
      } finally {
        await this.safeUnlink(temporary).catch(() => undefined);
      }
    });
    this.manifestQueue = task.catch(() => undefined);
    return task;
  }
  private destination(input: Pick<ModelDownloadInput, 'repository' | 'file'>) {
    if (!this.root)
      throw new AppError(
        'MODEL_DOWNLOAD_DISABLED',
        '모델 다운로드 폴더가 설정되지 않았습니다.',
        503,
      );
    const base = this.canonicalRoot!;
    const destination = resolve(
      base,
      input.repository.replace('/', '--'),
      ...input.file.split(/[\\/]/),
    );
    if (!destination.startsWith(base + sep))
      throw new AppError('MODEL_DOWNLOAD_PATH', '모델 저장 경로가 올바르지 않습니다.');
    return destination;
  }
  private path(record: ModelDownload, part: ModelDownloadPart) {
    return this.destination({ ...record, file: part.file });
  }
  private temporary(record: ModelDownload, part: ModelDownloadPart) {
    return this.path(record, part) + '.' + record.id + '.part';
  }
  private aggregate(record: ModelDownload) {
    record.downloadedBytes = record.parts!.reduce((sum, part) => sum + part.downloadedBytes, 0);
    record.totalBytes = record.parts!.every((part) => part.totalBytes !== null)
      ? record.parts!.reduce((sum, part) => sum + part.totalBytes!, 0)
      : null;
  }
  private async restore() {
    if (!this.root) return;
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    this.canonicalRoot = await realpath(this.root);
    this.rootIdentity = await lstat(this.canonicalRoot);
    const path = this.manifestPath()!;
    let source: unknown;
    try {
      const handle = await this.safeOpen(path, false);
      try {
        if ((await handle.stat()).size > 16_777_216) return;
        source = JSON.parse(await handle.readFile('utf8'));
      } finally {
        await handle.close();
      }
    } catch {
      return;
    }
    if (!source || typeof source !== 'object' || (source as { version?: number }).version !== 1)
      return;
    const records = (source as { downloads?: unknown }).downloads;
    if (!Array.isArray(records) || records.length > 10000) return;
    for (const value of records) {
      const parsed = modelDownloadSchema.safeParse(value);
      if (!parsed.success || this.records.has(parsed.data.id)) continue;
      const record = parsed.data;
      try {
        const files = splitModelFiles(record.file);
        record.parts ??= [
          {
            file: record.file,
            downloadedBytes: record.downloadedBytes,
            totalBytes: record.totalBytes,
            ...(record.sha256 ? { sha256: record.sha256 } : {}),
          },
        ];
        if (
          record.parts.length !== files.length ||
          record.parts.some((part, index) => part.file !== files[index])
        )
          continue;
        record.modelPath = this.path(record, record.parts[0]!);
        for (const part of record.parts) {
          await this.secureParent(this.path(record, part));
          if (!part.sha256 && part.verifiedSha256) {
            const recovered = await this.digest(
              this.path(record, part),
              new AbortController().signal,
            ).catch(() => undefined);
            if (recovered?.sha256 === part.verifiedSha256) {
              part.sha256 = recovered.sha256;
              delete part.verifiedSha256;
              await this.safeUnlink(this.temporary(record, part));
            }
          }
          const savedPath = part.sha256 ? this.path(record, part) : this.temporary(record, part);
          try {
            const info = await lstat(savedPath);
            if (!info.isFile() || info.isSymbolicLink()) throw new Error('invalid file');
            if (part.sha256 && info.size !== BigInt(part.downloadedBytes))
              throw new Error('changed file');
            if (info.size > BigInt(maximumBytes)) throw new Error('invalid file size');
            part.downloadedBytes = Number(info.size);
          } catch {
            if (part.sha256) {
              record.status = 'failed';
              record.error =
                '다운로드한 파일이 없어졌거나 변경되었습니다. 파일을 확인하고 다시 시도하세요.';
            }
            part.downloadedBytes = 0;
            delete part.sha256;
          }
        }
        if (record.status === 'downloading') {
          record.status = 'cancelled';
          record.finishedAt = new Date().toISOString();
          record.error = '앱 종료로 일시 중지되었습니다. 이어받기를 눌러 계속하세요.';
        }
        this.aggregate(record);
        this.records.set(record.id, record);
      } catch {
        /* Invalid manifests cannot select arbitrary filesystem targets. */
      }
    }
    await this.persist();
  }
  private pathError() {
    return new AppError(
      'MODEL_DOWNLOAD_PATH',
      '다운로드 폴더나 파일의 경로가 변경되었거나 링크를 가리킵니다.',
    );
  }
  private sameFile(a: BigIntStats, b: BigIntStats) {
    return a.dev === b.dev && a.ino === b.ino;
  }
  private async secureParent(path: string, create = false) {
    const root = this.canonicalRoot;
    if (!root || !this.rootIdentity || !this.root) throw this.pathError();
    if ((await realpath(this.root)) !== root) throw this.pathError();
    const rootStat = await lstat(root);
    if (
      !rootStat.isDirectory() ||
      rootStat.isSymbolicLink() ||
      !this.sameFile(rootStat, this.rootIdentity)
    )
      throw this.pathError();
    const child = relative(root, dirname(path));
    if (child === '..' || child.startsWith('..' + sep) || resolve(root, child) !== dirname(path))
      throw this.pathError();
    let current = root;
    for (const segment of child ? child.split(sep) : []) {
      current = join(current, segment);
      if (create)
        await mkdir(current, { mode: 0o700 }).catch((error) => {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        });
      const info = await lstat(current);
      if (!info.isDirectory() || info.isSymbolicLink() || (await realpath(current)) !== current)
        throw this.pathError();
    }
  }
  private async safeOpen(path: string, writable: boolean): Promise<FileHandle> {
    await this.secureParent(path);
    const before = await lstat(path);
    if (!before.isFile() || before.isSymbolicLink() || (writable && before.nlink !== 1n))
      throw this.pathError();
    const handle = await open(
      path,
      (writable ? constants.O_RDWR : constants.O_RDONLY) | (constants.O_NOFOLLOW ?? 0),
    );
    try {
      const actual = await handle.stat({ bigint: true });
      await this.secureParent(path);
      const after = await lstat(path);
      if (
        !actual.isFile() ||
        !this.sameFile(before, actual) ||
        !this.sameFile(actual, after) ||
        after.isSymbolicLink() ||
        (writable && actual.nlink !== 1n)
      )
        throw this.pathError();
      return handle;
    } catch (error) {
      await handle.close();
      throw error;
    }
  }
  private async safeUnlink(path: string, expected?: BigIntStats) {
    await this.secureParent(path);
    const info = await lstat(path).catch((error) => {
      if (!missing(error)) throw error;
      return undefined;
    });
    if (!info) return;
    if (!info.isFile() || info.isSymbolicLink() || (expected && !this.sameFile(info, expected)))
      throw this.pathError();
    await unlink(path);
  }
  async start(value: ModelDownloadInput) {
    await this.ready;
    if (this.closing)
      throw new AppError('MODEL_DOWNLOAD_CLOSED', '앱 종료 중에는 다운로드를 시작할 수 없습니다.');
    const input = modelDownloadInputSchema.parse(value);
    const files = splitModelFiles(input.file);
    if (input.expectedSha256 && input.file !== files[0])
      throw new AppError(
        'MODEL_DOWNLOAD_HASH_FILE',
        '분할 모델의 SHA-256 검증값은 첫 번째 파일 기준으로 입력하세요.',
      );
    const paths = files.map((file) => this.destination({ ...input, file }));
    for (const record of this.records.values())
      if (record.parts!.some((part) => paths.includes(this.path(record, part))))
        throw new AppError(
          'MODEL_DOWNLOAD_EXISTS',
          '같은 모델 파일이 이미 목록에 있습니다. 기존 작업에서 이어받기를 사용하세요.',
          409,
        );
    for (const path of paths) {
      await this.secureParent(path, true);
      try {
        await lstat(path);
        throw new AppError(
          'MODEL_DOWNLOAD_EXISTS',
          '같은 모델 파일이 이미 저장되어 있습니다.',
          409,
        );
      } catch (error) {
        if (!missing(error)) throw error;
      }
    }
    const record: ModelDownload = {
      id: randomUUID(),
      repository: input.repository,
      file: files[0]!,
      revision: input.revision,
      ...(input.expectedSha256 ? { expectedSha256: input.expectedSha256 } : {}),
      status: 'downloading',
      downloadedBytes: 0,
      totalBytes: null,
      startedAt: new Date().toISOString(),
      modelPath: paths[0],
      parts: files.map((file) => ({ file, downloadedBytes: 0, totalBytes: null })),
    };
    this.records.set(record.id, record);
    await this.persist();
    this.launch(record);
    return structuredClone(record);
  }
  private launch(record: ModelDownload) {
    const controller = new AbortController();
    record.status = 'downloading';
    delete record.error;
    delete record.finishedAt;
    const promise = this.download(record, controller.signal)
      .catch((error) => {
        record.status = controller.signal.aborted ? 'cancelled' : 'failed';
        record.error = controller.signal.aborted
          ? '다운로드를 일시 중지했습니다. 이어받기로 계속할 수 있습니다.'
          : error instanceof AppError
            ? error.message
            : '모델 다운로드에 실패했습니다. 이어받기로 다시 시도하세요.';
        record.finishedAt = new Date().toISOString();
      })
      .finally(async () => {
        this.aggregate(record);
        await this.persist();
        this.jobs.delete(record.id);
      });
    // Catch persistence errors as well; do not leave an unhandled background rejection.
    const tracked = promise.catch(() => {
      record.status = 'failed';
      record.error = '다운로드 기록을 저장하지 못했습니다.';
      this.jobs.delete(record.id);
    });
    this.jobs.set(record.id, { controller, promise: tracked });
  }
  private async pinRevision(record: ModelDownload, signal: AbortSignal) {
    if (record.resolvedRevision || record.parts!.length < 2) return;
    if (/^[a-f0-9]{40,64}$/.test(record.revision)) record.resolvedRevision = record.revision;
    else {
      const response = await this.fetcher(
        `https://huggingface.co/api/models/${record.repository}/revision/${encodeURIComponent(record.revision)}`,
        { signal, redirect: 'error' },
      );
      if (!response.ok) {
        await response.body?.cancel();
        throw new AppError(
          'MODEL_REVISION',
          `분할 모델 버전을 확인하지 못했습니다 (HTTP ${response.status}).`,
        );
      }
      const reader = response.body?.getReader();
      if (!reader) throw new AppError('MODEL_REVISION', '모델 저장소 응답이 비어 있습니다.');
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          signal.throwIfAborted();
          const part = await reader.read();
          if (part.done) break;
          size += part.value.byteLength;
          if (size > 4_194_304)
            throw new AppError('MODEL_REVISION', '모델 저장소 응답이 너무 큽니다.');
          chunks.push(part.value);
        }
      } finally {
        await reader.cancel().catch(() => undefined);
      }
      const text = Buffer.concat(chunks).toString('utf8');
      const sha: unknown = (JSON.parse(text) as { sha?: unknown }).sha;
      if (typeof sha !== 'string' || !/^[a-f0-9]{40,64}$/.test(sha))
        throw new AppError('MODEL_REVISION', '분할 모델의 고정 버전을 확인하지 못했습니다.');
      record.resolvedRevision = sha;
    }
    await this.persist();
  }
  private async digest(path: string, signal: AbortSignal, expected?: BigIntStats) {
    const handle = await this.safeOpen(path, false);
    try {
      const before = await handle.stat({ bigint: true });
      if (expected && !this.unchanged(before, expected)) throw this.pathError();
      const hash = createHash('sha256');
      for await (const chunk of handle.createReadStream({ signal, autoClose: false }))
        hash.update(chunk);
      const after = await handle.stat({ bigint: true });
      await this.secureParent(path);
      const linked = await lstat(path);
      if (
        !this.unchanged(before, after) ||
        !this.unchanged(after, linked) ||
        linked.isSymbolicLink()
      )
        throw this.pathError();
      return { sha256: hash.digest('hex'), info: after };
    } finally {
      await handle.close();
    }
  }
  private unchanged(a: BigIntStats, b: BigIntStats) {
    return (
      this.sameFile(a, b) && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs
    );
  }
  private async download(record: ModelDownload, signal: AbortSignal) {
    await this.pinRevision(record, signal);
    for (const [index, part] of record.parts!.entries()) {
      signal.throwIfAborted();
      if (part.sha256) {
        if ((await this.digest(this.path(record, part), signal)).sha256 !== part.sha256)
          throw new AppError(
            'MODEL_DOWNLOAD_CHANGED',
            '완료된 분할 파일이 변경되었습니다. 목록에서 제거한 뒤 다시 받으세요.',
          );
        continue;
      }
      await this.downloadPart(
        record,
        part,
        index === 0 ? record.expectedSha256 : undefined,
        signal,
      );
    }
    await this.verify(record.modelPath!);
    signal.throwIfAborted();
    record.status = 'completed';
    record.sha256 = record.parts![0]!.sha256;
    record.finishedAt = new Date().toISOString();
    this.aggregate(record);
  }
  private async downloadPart(
    record: ModelDownload,
    part: ModelDownloadPart,
    expectedSha: string | undefined,
    signal: AbortSignal,
  ) {
    const destination = this.path(record, part),
      temporary = this.temporary(record, part);
    await this.secureParent(destination);
    let offset = 0;
    let partialInfo: BigIntStats | undefined;
    try {
      const stat = await lstat(temporary);
      if (!stat.isFile() || stat.isSymbolicLink())
        throw new AppError('MODEL_DOWNLOAD_PATH', '다운로드 임시 파일이 일반 파일이 아닙니다.');
      if (stat.size > BigInt(maximumBytes)) throw this.pathError();
      offset = Number(stat.size);
      partialInfo = stat;
    } catch (error) {
      if (!missing(error)) throw error;
    }
    const source = `https://huggingface.co/${record.repository}/resolve/${(record.resolvedRevision ?? record.revision).split('/').map(encodeURIComponent).join('/')}/${part.file.split(/[\\/]/).map(encodeURIComponent).join('/')}?download=true`;
    const canResume = offset > 0 && !!strongEtag(part.etag ?? null);
    if (!canResume) offset = 0;
    let response: Response | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      response = await this.fetcher(source, {
        headers: {
          Accept: 'application/octet-stream',
          'Accept-Encoding': 'identity',
          'User-Agent': 'Lodex/0.1',
          ...(offset ? { Range: `bytes=${offset}-`, 'If-Range': part.etag! } : {}),
        },
        redirect: 'follow',
        signal,
      });
      const finalUrl = new URL(response.url || source);
      if (finalUrl.protocol !== 'https:' || finalUrl.username || finalUrl.password) {
        await response.body?.cancel();
        throw new AppError(
          'MODEL_DOWNLOAD_REDIRECT',
          '안전하지 않은 다운로드 주소로 이동했습니다.',
        );
      }
      if (response.status === 206) {
        const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(
          response.headers.get('content-range') ?? '',
        );
        const etag = strongEtag(response.headers.get('etag'));
        const start = Number(range?.[1]),
          end = Number(range?.[2]),
          total = Number(range?.[3]);
        if (
          !range ||
          start !== offset ||
          !Number.isSafeInteger(total) ||
          end < start ||
          end !== total - 1 ||
          total > maximumBytes ||
          (offset > 0 &&
            (!etag ||
              etag !== part.etag ||
              (part.totalBytes !== null && part.totalBytes !== total)))
        ) {
          await response.body?.cancel();
          if (!offset || attempt === 1)
            throw new AppError('MODEL_DOWNLOAD_RANGE', '서버의 이어받기 응답이 일치하지 않습니다.');
          offset = 0;
          continue;
        }
        part.totalBytes = total;
      } else if (response.status === 200) {
        offset = 0;
        const length = response.headers.get('content-length');
        part.totalBytes = length !== null && /^\d+$/.test(length) ? Number(length) : null;
      } else if (response.status === 416 && offset && attempt === 0) {
        await response.body?.cancel();
        offset = 0;
        continue;
      } else {
        await response.body?.cancel();
        throw new AppError(
          'MODEL_DOWNLOAD_HTTP',
          `모델 다운로드 실패 (HTTP ${response.status}). 저장소·revision·파일 이름을 확인하세요.`,
          502,
        );
      }
      break;
    }
    if (!response?.body) throw new AppError('MODEL_DOWNLOAD_BODY', '모델 파일 내용이 없습니다.');
    if (
      part.totalBytes !== null &&
      (!Number.isSafeInteger(part.totalBytes) || part.totalBytes > maximumBytes)
    ) {
      await response.body.cancel();
      throw new AppError('MODEL_DOWNLOAD_SIZE', '모델 파일 크기가 허용 범위를 초과합니다.');
    }
    const encoding = response.headers.get('content-encoding');
    if (encoding && encoding !== 'identity') {
      await response.body.cancel();
      throw new AppError(
        'MODEL_DOWNLOAD_ENCODING',
        '서버가 압축된 응답을 보내 안전하게 이어받을 수 없습니다.',
      );
    }
    const etag = strongEtag(response.headers.get('etag'));
    if (etag) part.etag = etag;
    else delete part.etag;
    part.downloadedBytes = offset;
    delete part.verifiedSha256;
    this.aggregate(record);
    await this.persist(); // Persist the exact validator before any resumable bytes.
    const reader = response.body.getReader();
    const abort = () => {
      void reader.cancel().catch(() => undefined);
    };
    signal.addEventListener('abort', abort, { once: true });
    let position = offset;
    let output: FileHandle | undefined;
    let writtenInfo: BigIntStats | undefined;
    try {
      await this.secureParent(temporary);
      output = partialInfo
        ? await this.safeOpen(temporary, true)
        : await open(temporary, 'wx', 0o600);
      if (partialInfo && !this.unchanged(partialInfo, await output.stat({ bigint: true })))
        throw this.pathError();
      if (!offset) await output.truncate(0);
      while (true) {
        signal.throwIfAborted();
        const chunk = await reader.read();
        signal.throwIfAborted();
        if (chunk.done) break;
        if (
          position + chunk.value.length > maximumBytes ||
          (part.totalBytes !== null && position + chunk.value.length > part.totalBytes)
        )
          throw new AppError('MODEL_DOWNLOAD_SIZE', '모델 파일 크기가 서버 안내와 다릅니다.');
        let written = 0;
        while (written < chunk.value.length) {
          const result = await output.write(
            chunk.value,
            written,
            chunk.value.length - written,
            position,
          );
          if (!result.bytesWritten) throw new Error('File write did not advance');
          written += result.bytesWritten;
          position += result.bytesWritten;
        }
        part.downloadedBytes = position;
        this.aggregate(record);
      }
      await output.sync();
      writtenInfo = await output.stat({ bigint: true });
    } finally {
      signal.removeEventListener('abort', abort);
      await reader.cancel().catch(() => undefined);
      await output?.close();
    }
    if (part.totalBytes !== null && position !== part.totalBytes)
      throw new AppError(
        'MODEL_DOWNLOAD_TRUNCATED',
        '파일이 끝까지 전송되지 않았습니다. 이어받기로 계속하세요.',
      );
    const { sha256, info } = await this.digest(temporary, signal, writtenInfo);
    if (expectedSha && sha256 !== expectedSha) {
      await this.safeUnlink(temporary, info);
      part.downloadedBytes = 0;
      delete part.etag;
      throw new AppError(
        'MODEL_DOWNLOAD_HASH',
        '모델의 SHA-256이 입력한 값과 다릅니다. 이어받기를 누르면 처음부터 다시 받습니다.',
      );
    }
    signal.throwIfAborted();
    part.verifiedSha256 = sha256;
    await this.persist();
    // Publish without overwriting an independently created file.
    await this.secureParent(temporary);
    const publishing = await lstat(temporary);
    if (publishing.isSymbolicLink() || !this.unchanged(publishing, info)) throw this.pathError();
    await link(temporary, destination);
    await this.safeUnlink(temporary, info);
    part.sha256 = sha256;
    delete part.verifiedSha256;
    part.totalBytes = position;
    await this.persist();
  }
  async action(id: string, action: 'cancel' | 'remove' | 'resume', protectedPaths: string[] = []) {
    await this.ready;
    const record = this.records.get(id);
    if (!record)
      throw new AppError('MODEL_DOWNLOAD_NOT_FOUND', '다운로드 작업을 찾을 수 없습니다.', 404);
    const job = this.jobs.get(id);
    if (action === 'cancel') {
      if (!job) throw new AppError('MODEL_DOWNLOAD_FINISHED', '이미 끝난 다운로드입니다.', 409);
      job.controller.abort();
      await job.promise;
      return;
    }
    if (job) throw new AppError('MODEL_DOWNLOAD_ACTIVE', '다운로드를 먼저 중지하세요.', 409);
    for (const part of record.parts!) await this.secureParent(this.path(record, part));
    if (action === 'resume') {
      if (this.closing || record.status === 'completed')
        throw new AppError('MODEL_DOWNLOAD_FINISHED', '이 다운로드는 이어받을 수 없습니다.', 409);
      this.launch(record);
      await this.persist();
      return;
    }
    const paths = record.parts!.map((part) => this.path(record, part));
    if (paths.some((path) => protectedPaths.includes(path)))
      throw new AppError(
        'MODEL_DOWNLOAD_REGISTERED',
        '등록된 모델이 사용하는 파일입니다. 프로필을 먼저 제거하세요.',
        409,
      );
    for (const part of record.parts!) {
      let verifiedInfo: BigIntStats | undefined;
      if (
        part.sha256 &&
        (await this.digest(this.path(record, part), new AbortController().signal)
          .then((verified) => {
            verifiedInfo = verified.info;
            return verified.sha256;
          })
          .catch((error) => (missing(error) ? part.sha256 : ''))) !== part.sha256
      )
        throw new AppError(
          'MODEL_DOWNLOAD_CHANGED',
          '다운로드 파일이 변경되어 자동으로 제거하지 않았습니다. 파일을 직접 확인하세요.',
          409,
        );
      for (const path of [
        ...(part.sha256 ? [this.path(record, part)] : []),
        this.temporary(record, part),
      ]) {
        await this.safeUnlink(path, path === this.path(record, part) ? verifiedInfo : undefined);
      }
    }
    this.records.delete(id);
    await this.persist();
  }
  async close() {
    this.closing = true;
    await this.ready;
    for (const job of this.jobs.values()) job.controller.abort();
    await Promise.allSettled([...this.jobs.values()].map((job) => job.promise));
    await this.manifestQueue;
  }
}
