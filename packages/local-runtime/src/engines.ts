import { constants, type BigIntStats } from 'node:fs';
import {
  chmod,
  copyFile,
  lstat as nodeLstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  rmdir,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { arch, platform } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import {
  AppError,
  engineInstallSchema,
  managedEngineSchema,
  type EngineAsset,
  type EngineCatalog,
  type EngineInstallation,
  type EngineInstallInput,
  type EngineManagerSnapshot,
} from '@lodex/contracts';
import { archivePath, extractEngineArchive, type EngineFile } from './engine-archive';
import { allowedAssetResponse, EngineReleases } from './engine-releases';

const manifestSchema = z.strictObject({
  version: z.literal(1),
  engine: managedEngineSchema,
  files: z
    .array(
      z.strictObject({
        path: z.string().min(1).max(1000),
        bytes: z.number().int().nonnegative().max(2_147_483_648),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
        executable: z.boolean(),
      }),
    )
    .min(1)
    .max(40000),
});
type Manifest = z.infer<typeof manifestSchema>;
type References = { path: string; name: string; running: boolean }[];
type Job = { state: EngineInstallation; controller: AbortController; promise: Promise<void> };
const lstat = (path: string) => nodeLstat(path, { bigint: true });
const uuidPattern = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const samePath = (a: string, b: string) =>
  process.platform === 'win32'
    ? resolve(a).toLowerCase() === resolve(b).toLowerCase()
    : resolve(a) === resolve(b);

export class EngineManager {
  private manifests = new Map<string, Manifest>();
  private jobs = new Map<string, Job>();
  private ready: Promise<void>;
  private closing = new AbortController();
  private source: EngineReleases;
  private host: { platform: string; architecture: string };
  private canonicalRoot: string | undefined;
  private rootIdentity: BigIntStats | undefined;
  constructor(
    private root: string | undefined,
    private fetcher: typeof fetch = fetch,
    host = { platform: platform(), architecture: arch() },
  ) {
    this.source = new EngineReleases(fetcher);
    this.host = host;
    this.ready = this.restore();
  }
  private folder(id: string) {
    if (!this.root || !uuidPattern.test(id))
      throw new AppError('ENGINE_PATH', '관리 엔진 폴더가 설정되지 않았습니다.');
    return join(this.canonicalRoot!, 'versions', id);
  }
  private async restore() {
    if (!this.root) return;
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    this.canonicalRoot = await realpath(this.root);
    this.rootIdentity = await lstat(this.canonicalRoot);
    const versions = join(this.canonicalRoot, 'versions');
    await this.secureDirectory(versions, true);
    for (const name of await readdir(versions)) {
      if (!uuidPattern.test(name)) continue;
      try {
        const folder = this.folder(name);
        await this.secureDirectory(folder);
        if ((await lstat(folder)).isSymbolicLink()) continue;
        const path = join(folder, 'managed-engine.json');
        const stat = await lstat(path);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8_388_608) continue;
        const data = manifestSchema.parse(JSON.parse(await readFile(path, 'utf8')));
        if (data.engine.id !== name) continue;
        archivePath(data.engine.engineRelativePath);
        for (const file of data.files) archivePath(file.path);
        if (!data.files.some((file) => file.path === data.engine.engineRelativePath)) continue;
        this.manifests.set(name, data);
      } catch {
        /* Unknown or edited directories are not managed or removed. */
      }
    }
  }
  private async secureDirectory(path: string, create = false) {
    const root = this.canonicalRoot;
    const invalid = () =>
      new AppError('ENGINE_PATH', '엔진 관리 경로가 변경되었거나 링크를 가리킵니다.');
    if (!root || !this.rootIdentity || !this.root || (await realpath(this.root)) !== root)
      throw invalid();
    const stat = await lstat(root);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      stat.ino !== this.rootIdentity.ino ||
      stat.dev !== this.rootIdentity.dev
    )
      throw invalid();
    const suffix = relative(root, path);
    if (suffix === '..' || suffix.startsWith('..' + sep) || resolve(root, suffix) !== path)
      throw invalid();
    let current = root;
    for (const part of suffix ? suffix.split(sep) : []) {
      current = join(current, part);
      if (create)
        await mkdir(current, { mode: 0o700 }).catch((error) => {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        });
      const info = await lstat(current);
      if (!info.isDirectory() || info.isSymbolicLink() || (await realpath(current)) !== current)
        throw invalid();
    }
  }
  async snapshot(references: References = []): Promise<EngineManagerSnapshot> {
    await this.ready;
    return {
      ...this.host,
      installed: [...this.manifests.values()]
        .map(({ engine }) => {
          const enginePath = join(this.folder(engine.id), engine.engineRelativePath);
          const refs = references.filter((item) => samePath(item.path, enginePath));
          return {
            ...engine,
            enginePath,
            referencedBy: refs.map((item) => item.name),
            running: refs.some((item) => item.running),
          };
        })
        .sort((a, b) => b.installedAt.localeCompare(a.installedAt)),
      installations: [...this.jobs.values()].map(({ state }) => ({ ...state })),
    };
  }
  catalog(channel: EngineCatalog['channel']) {
    return this.source.catalog(
      channel,
      AbortSignal.any([this.closing.signal, AbortSignal.timeout(30000)]),
    );
  }
  async install(value: EngineInstallInput) {
    await this.ready;
    this.closing.signal.throwIfAborted();
    if (!this.root)
      throw new AppError('ENGINE_DISABLED', '이 실행 환경에는 엔진 설치 폴더가 없습니다.');
    await this.secureDirectory(this.canonicalRoot!);
    const input = engineInstallSchema.parse(value);
    const release = await this.source.byTag(
      input.releaseTag,
      AbortSignal.any([this.closing.signal, AbortSignal.timeout(30000)]),
    );
    this.closing.signal.throwIfAborted();
    const asset = release.variants.find((asset) => asset.id === input.assetId);
    if (!asset)
      throw new AppError('ENGINE_ASSET', '공식 릴리스의 지원되는 엔진 파일을 찾을 수 없습니다.');
    if (asset.unavailableReason) throw new AppError('ENGINE_ASSET', asset.unavailableReason);
    if (asset.platform !== this.host.platform || asset.architecture !== this.host.architecture)
      throw new AppError(
        'ENGINE_PLATFORM',
        '현재 운영체제와 CPU 아키텍처에 맞는 엔진을 선택하세요.',
      );
    if (
      [...this.manifests.values()].some(
        ({ engine }) =>
          engine.assets[0]?.id === asset.id && engine.assets[0].sha256 === asset.sha256,
      )
    )
      throw new AppError('ENGINE_INSTALLED', '같은 엔진 버전이 이미 설치되어 있습니다.', 409);
    if (
      [...this.jobs.values()].some(({ state }) =>
        ['downloading', 'extracting'].includes(state.status),
      )
    )
      throw new AppError(
        'ENGINE_INSTALL_BUSY',
        '진행 중인 엔진 설치를 먼저 마치거나 취소하세요.',
        409,
      );
    const id = randomUUID(),
      assets = [asset, ...asset.dependencies];
    const state: EngineInstallation = {
      id,
      releaseTag: release.releaseTag,
      assetId: asset.id,
      assetName: asset.name,
      status: 'downloading',
      downloadedBytes: 0,
      totalBytes: assets.reduce((sum, asset) => sum + asset.size, 0),
    };
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, this.closing.signal]);
    const promise = this.perform(id, release, asset, assets, state, signal).catch((error) => {
      state.status = signal.aborted ? 'cancelled' : 'failed';
      state.error = signal.aborted
        ? '엔진 설치를 취소했습니다.'
        : error instanceof Error
          ? error.message
          : '엔진 설치에 실패했습니다.';
    });
    this.jobs.set(id, { state, controller, promise });
    return { ...state };
  }
  private async download(
    asset: EngineAsset,
    path: string,
    state: EngineInstallation,
    signal: AbortSignal,
  ) {
    if (!asset.sha256)
      throw new AppError('ENGINE_DIGEST', '공식 SHA-256이 없는 엔진은 자동 설치하지 않습니다.');
    const response = await this.fetcher(asset.url, {
      signal,
      redirect: 'follow',
      headers: { 'Accept-Encoding': 'identity', 'User-Agent': 'Lodex/0.1' },
    });
    try {
      allowedAssetResponse(response, asset.url);
    } catch (error) {
      await response.body?.cancel();
      throw error;
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new AppError('ENGINE_DOWNLOAD', `엔진 다운로드 실패 (HTTP ${response.status}).`);
    }
    await this.secureDirectory(dirname(path));
    const output = await open(path, 'wx', 0o600),
      hash = createHash('sha256'),
      reader = response.body.getReader();
    let bytes = 0;
    const abort = () => {
      void reader.cancel().catch(() => undefined);
    };
    signal.addEventListener('abort', abort, { once: true });
    try {
      while (true) {
        signal.throwIfAborted();
        const part = await reader.read();
        signal.throwIfAborted();
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > asset.size)
          throw new AppError('ENGINE_SIZE', '엔진 파일 크기가 공식 릴리스와 다릅니다.');
        await output.writeFile(part.value);
        hash.update(part.value);
        state.downloadedBytes += part.value.byteLength;
      }
      await output.sync();
    } finally {
      signal.removeEventListener('abort', abort);
      await reader.cancel().catch(() => undefined);
      await output.close();
    }
    if (bytes !== asset.size || hash.digest('hex') !== asset.sha256)
      throw new AppError(
        'ENGINE_DIGEST',
        '엔진 파일의 크기 또는 SHA-256이 공식 릴리스와 일치하지 않습니다.',
      );
  }
  private async perform(
    id: string,
    release: EngineCatalog,
    variant: EngineCatalog['variants'][number],
    assets: EngineAsset[],
    state: EngineInstallation,
    signal: AbortSignal,
  ) {
    const stagingRoot = join(this.canonicalRoot!, '.staging'),
      stage = join(stagingRoot, id),
      payload = join(stage, 'payload');
    await this.secureDirectory(stagingRoot, true);
    await mkdir(stage, { mode: 0o700 });
    try {
      let files: EngineFile[] = [],
        engineRelativePath = '';
      for (const [index, asset] of assets.entries()) {
        signal.throwIfAborted();
        state.status = 'downloading';
        const archive = join(stage, `archive-${index}`);
        await this.secureDirectory(stage);
        await this.download(asset, archive, state, signal);
        await this.secureDirectory(stage);
        state.status = 'extracting';
        const destination = index === 0 ? payload : join(stage, `runtime-${index}`);
        const extracted = await extractEngineArchive(
          archive,
          destination,
          asset.name.endsWith('.zip') ? 'zip' : 'tar.gz',
          signal,
        );
        if (index === 0) {
          files = extracted;
          const matches = files.filter(
            (file) =>
              basename(file.path) ===
              (variant.platform === 'win32' ? 'llama-server.exe' : 'llama-server'),
          );
          if (matches.length !== 1)
            throw new AppError(
              'ENGINE_EXECUTABLE',
              '압축 파일에서 단일 llama-server 실행 파일을 찾지 못했습니다.',
            );
          engineRelativePath = matches[0]!.path;
          const executable = join(payload, engineRelativePath),
            handle = await open(executable, 'r'),
            magic = Buffer.alloc(4);
          try {
            await handle.read(magic, 0, 4, 0);
          } finally {
            await handle.close();
          }
          const valid =
            variant.platform === 'win32'
              ? magic.subarray(0, 2).toString('ascii') === 'MZ'
              : variant.platform === 'linux'
                ? magic.toString('hex') === '7f454c46'
                : [
                    'cffaedfe',
                    'cefaedfe',
                    'feedface',
                    'feedfacf',
                    'cafebabe',
                    'bebafeca',
                    'cafebabf',
                    'bfbafeca',
                  ].includes(magic.toString('hex'));
          if (!valid)
            throw new AppError(
              'ENGINE_EXECUTABLE',
              '실행 파일의 형식이 선택한 운영체제와 다릅니다.',
            );
          await chmod(executable, 0o700);
          matches[0]!.executable = true;
        } else {
          const runtimeFiles = extracted.filter((file) =>
            /(?:\.dll|\.so(?:\.\d+)*)$/i.test(file.path),
          );
          if (!runtimeFiles.length)
            throw new AppError(
              'ENGINE_CUDA_RUNTIME',
              'CUDA 런타임 압축에 필요한 라이브러리가 없습니다.',
            );
          for (const file of runtimeFiles) {
            const path = relative(
              payload,
              join(dirname(join(payload, engineRelativePath)), basename(file.path)),
            )
              .split(sep)
              .join('/');
            if (files.some((current) => current.path.toLowerCase() === path.toLowerCase()))
              throw new AppError(
                'ENGINE_ARCHIVE_DUPLICATE',
                'CUDA 런타임 파일이 엔진 파일과 충돌합니다.',
              );
            await copyFile(
              join(destination, file.path),
              join(payload, path),
              constants.COPYFILE_EXCL,
            );
            files.push({ ...file, path });
          }
        }
      }
      signal.throwIfAborted();
      const manifest: Manifest = {
        version: 1,
        engine: {
          id,
          releaseTag: release.releaseTag,
          releaseUrl: release.releaseUrl,
          prerelease: release.prerelease,
          platform: variant.platform,
          architecture: variant.architecture,
          backend: variant.backend,
          assets: assets.map(({ id, name, size, sha256, url }) => ({
            id,
            name,
            size,
            sha256,
            url,
          })),
          installedAt: new Date().toISOString(),
          engineRelativePath,
        },
        files,
      };
      await writeFile(join(payload, 'managed-engine.json'), JSON.stringify(manifest), {
        flag: 'wx',
        mode: 0o600,
      });
      await this.secureDirectory(payload);
      await this.secureDirectory(dirname(this.folder(id)));
      await rename(payload, this.folder(id));
      this.manifests.set(id, manifest);
      state.status = 'completed';
    } finally {
      await this.removeOwnedStage(stage);
    }
  }
  private async removeOwnedStage(path: string) {
    await this.secureDirectory(path);
    const root = this.canonicalRoot!;
    const target = await realpath(path);
    if (!target.startsWith(join(root, '.staging') + sep) || !uuidPattern.test(basename(target)))
      throw new AppError('ENGINE_PATH', '엔진 임시 경로를 확인할 수 없습니다.');
    await rm(target, { recursive: true, force: true });
  }
  async action(id: string, action: 'cancel' | 'remove', references: References = []) {
    await this.ready;
    if (!uuidPattern.test(id)) throw new AppError('ENGINE_PATH', '엔진 ID가 올바르지 않습니다.');
    if (action === 'cancel') {
      const job = this.jobs.get(id);
      if (!job || !['downloading', 'extracting'].includes(job.state.status))
        throw new AppError('ENGINE_INSTALL_FINISHED', '진행 중인 엔진 설치가 아닙니다.', 409);
      job.controller.abort();
      await job.promise;
      return;
    }
    const manifest = this.manifests.get(id);
    if (!manifest)
      throw new AppError('ENGINE_NOT_FOUND', '관리하는 엔진 버전을 찾을 수 없습니다.', 404);
    const folder = this.folder(id),
      enginePath = join(folder, manifest.engine.engineRelativePath);
    if (references.some((reference) => samePath(reference.path, enginePath)))
      throw new AppError(
        'ENGINE_IN_USE',
        '프로필에서 사용하거나 실행 중인 엔진 버전은 제거할 수 없습니다. 먼저 다른 엔진으로 프로필을 변경하세요.',
        409,
      );
    await this.secureDirectory(folder);
    const root = this.canonicalRoot!;
    if (
      (await lstat(folder)).isSymbolicLink() ||
      !(await realpath(folder)).startsWith(join(root, 'versions') + sep)
    )
      throw new AppError('ENGINE_PATH', '관리 엔진 경로가 변경되었습니다.');
    const expected = new Map(manifest.files.map((file) => [file.path, file]));
    const verified: { path: string; identity: BigIntStats }[] = [];
    const directories = new Set<string>();
    for (const file of manifest.files) {
      let parent = dirname(file.path).split(sep).join('/');
      while (parent !== '.') {
        directories.add(parent);
        parent = dirname(parent).split(sep).join('/');
      }
    }
    const walk = async (path: string) => {
      await this.secureDirectory(path);
      for (const entry of await readdir(path, { withFileTypes: true })) {
        const full = join(path, entry.name),
          name = relative(folder, full).split(sep).join('/');
        if (entry.isSymbolicLink())
          throw new AppError('ENGINE_CHANGED', '엔진 폴더에 링크가 추가되어 제거하지 않았습니다.');
        if (entry.isDirectory()) {
          if (!directories.has(name))
            throw new AppError(
              'ENGINE_CHANGED',
              '엔진 폴더에 사용자 폴더가 추가되어 제거하지 않았습니다.',
            );
          await walk(full);
          continue;
        }
        if (name === 'managed-engine.json') {
          const info = await lstat(full);
          if (
            !info.isFile() ||
            info.isSymbolicLink() ||
            (await readFile(full, 'utf8')) !== JSON.stringify(manifest)
          )
            throw new AppError('ENGINE_CHANGED', '엔진 설치 기록이 변경되어 제거하지 않았습니다.');
          verified.push({ path: full, identity: info });
          continue;
        }
        const file = expected.get(name);
        if (!entry.isFile() || !file || (await lstat(full)).size !== BigInt(file.bytes))
          throw new AppError(
            'ENGINE_CHANGED',
            '엔진 폴더에 추가되거나 변경된 파일이 있어 제거하지 않았습니다.',
          );
        const hash = createHash('sha256');
        const before = await lstat(full);
        if (before.isSymbolicLink())
          throw new AppError('ENGINE_PATH', '엔진 파일이 링크로 변경되었습니다.');
        const handle = await open(full, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        let identity: BigIntStats;
        try {
          identity = await handle.stat({ bigint: true });
          if (identity.ino !== before.ino || identity.dev !== before.dev)
            throw new AppError('ENGINE_CHANGED', '엔진 파일이 변경되었습니다.');
          for await (const chunk of handle.createReadStream({ autoClose: false }))
            hash.update(chunk);
          const after = await handle.stat({ bigint: true });
          if (
            identity.size !== after.size ||
            identity.mtimeNs !== after.mtimeNs ||
            identity.ctimeNs !== after.ctimeNs
          )
            throw new AppError('ENGINE_CHANGED', '엔진 파일이 변경되었습니다.');
        } finally {
          await handle.close();
        }
        if (hash.digest('hex') !== file.sha256)
          throw new AppError('ENGINE_CHANGED', '엔진 파일이 변경되어 제거하지 않았습니다.');
        expected.delete(name);
        verified.push({ path: full, identity });
      }
    };
    await walk(folder);
    if (expected.size)
      throw new AppError('ENGINE_CHANGED', '엔진 파일 일부가 없어 자동으로 제거하지 않았습니다.');
    // Delete only the exact verified files. A newly added user file makes rmdir fail
    // instead of being swept up by a recursive directory deletion.
    for (const file of verified) {
      await this.secureDirectory(dirname(file.path));
      const info = await lstat(file.path);
      if (
        info.isSymbolicLink() ||
        info.ino !== file.identity.ino ||
        info.dev !== file.identity.dev ||
        info.size !== file.identity.size ||
        info.mtimeNs !== file.identity.mtimeNs ||
        info.ctimeNs !== file.identity.ctimeNs
      )
        throw new AppError('ENGINE_CHANGED', '엔진 파일이 변경되어 제거를 중단했습니다.');
      await unlink(file.path);
    }
    for (const path of [...directories].sort((a, b) => b.split('/').length - a.split('/').length)) {
      const full = join(folder, path);
      await this.secureDirectory(full);
      await rmdir(full);
    }
    await this.secureDirectory(folder);
    await rmdir(folder);
    this.manifests.delete(id);
  }
  async close() {
    this.closing.abort();
    await this.ready;
    await Promise.allSettled([...this.jobs.values()].map((job) => job.promise));
  }
}
