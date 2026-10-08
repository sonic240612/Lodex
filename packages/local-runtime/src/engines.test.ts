import { afterEach, expect, it, vi } from 'vitest';
import {
  mkdtemp,
  readFile,
  writeFile,
  readdir,
  rm,
  unlink,
  rename,
  symlink,
  lstat,
} from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { crc32, gzipSync } from 'node:zlib';
import { pack } from 'tar-stream';
import { EngineManager } from './engines';
import { EngineReleases, parseEngineRelease } from './engine-releases';
import { archivePath, extractEngineArchive } from './engine-archive';

const dirs: string[] = [],
  managers: EngineManager[] = [];
afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.close();
  for (const path of dirs.splice(0)) {
    if (dirname(resolve(path)) !== resolve(tmpdir())) throw new Error('Unsafe cleanup');
    await rm(path, { recursive: true, force: true });
  }
});
async function directory() {
  const path = await mkdtemp(join(tmpdir(), 'lodex-engine-install-'));
  dirs.push(path);
  return path;
}
const digest = (data: Buffer) => createHash('sha256').update(data).digest('hex');
function zip(entries: { name: string; data: Buffer; mode?: number }[]) {
  const locals: Buffer[] = [],
    central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name),
      checksum = crc32(entry.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(entry.data.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const index = Buffer.alloc(46);
    index.writeUInt32LE(0x02014b50);
    index.writeUInt16LE((3 << 8) | 20, 4);
    index.writeUInt16LE(20, 6);
    index.writeUInt32LE(checksum, 16);
    index.writeUInt32LE(entry.data.length, 20);
    index.writeUInt32LE(entry.data.length, 24);
    index.writeUInt16LE(name.length, 28);
    index.writeUInt32LE(((entry.mode ?? 0o100644) << 16) >>> 0, 38);
    index.writeUInt32LE(offset, 42);
    locals.push(local, name, entry.data);
    central.push(index, name);
    offset += local.length + name.length + entry.data.length;
  }
  const dir = Buffer.concat(central),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dir, end]);
}
async function tar(
  entries: { name: string; data?: Buffer; linkname?: string; type?: 'file' | 'symlink' | 'link' }[],
) {
  const archive = pack(),
    chunks: Buffer[] = [];
  const reading = (async () => {
    for await (const part of archive) chunks.push(Buffer.from(part as Uint8Array));
  })();
  for (const entry of entries)
    archive.entry(
      {
        name: entry.name,
        type: entry.type ?? 'file',
        mode: 0o755,
        ...(entry.linkname ? { linkname: entry.linkname } : {}),
      },
      entry.data ?? Buffer.alloc(0),
    );
  archive.finalize();
  await reading;
  return gzipSync(Buffer.concat(chunks));
}
function asset(tag: string, name: string, data: Buffer, id = 1) {
  return {
    id,
    name,
    size: data.length,
    digest: 'sha256:' + digest(data),
    browser_download_url: `https://github.com/ggml-org/llama.cpp/releases/download/${tag}/${name}`,
  };
}
function release(tag: string, assets: ReturnType<typeof asset>[]) {
  return {
    tag_name: tag,
    html_url: `https://github.com/ggml-org/llama.cpp/releases/tag/${tag}`,
    published_at: '2026-10-01T00:00:00.000Z',
    prerelease: tag.startsWith('b'),
    draft: false,
    assets,
  };
}
const windowsArchive = (value = 'version1') =>
  zip([
    { name: 'llama/llama-server.exe', data: Buffer.from('MZ' + value) },
    { name: 'llama/LICENSE', data: Buffer.from('test fixture') },
  ]);

it('pins the managed root and refuses to delete or install through a replaced versions directory', async () => {
  const root = await directory(),
    outside = await directory(),
    bytes = windowsArchive();
  const metadata = release('b123', [asset('b123', 'llama-b123-bin-win-cpu-x64.zip', bytes)]);
  const fetcher = vi.fn(async (url: string | URL | Request) =>
    String(url).includes('api.github.com') ? Response.json(metadata) : new Response(bytes),
  );
  const instance = new EngineManager(root, fetcher as typeof fetch, {
    platform: 'win32',
    architecture: 'x64',
  });
  managers.push(instance);
  await instance.install({ releaseTag: 'b123', assetId: 1 });
  await expect.poll(async () => (await instance.snapshot()).installed.length).toBe(1);
  const installed = (await instance.snapshot()).installed[0]!;
  await rename(join(root, 'versions'), join(root, 'saved-versions'));
  await writeFile(join(outside, 'private.txt'), 'keep me');
  await symlink(outside, join(root, 'versions'), process.platform === 'win32' ? 'junction' : 'dir');
  await expect(instance.action(installed.id, 'remove')).rejects.toMatchObject({
    code: 'ENGINE_PATH',
  });
  expect(await readFile(join(outside, 'private.txt'), 'utf8')).toBe('keep me');
  await expect(lstat(join(outside, installed.id))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('discovers actual cross-platform variants and pairs matching CUDA runtime assets without inventing unsupported builds', () => {
  const tag = 'b123',
    bytes = Buffer.from('fixture');
  const names = [
    `llama-${tag}-bin-win-cpu-x64.zip`,
    `llama-${tag}-bin-win-cuda-12.4-x64.zip`,
    `cudart-llama-bin-win-cuda-12.4-x64.zip`,
    `llama-${tag}-bin-macos-arm64.tar.gz`,
    `llama-${tag}-bin-macos-x64.tar.gz`,
    `llama-${tag}-bin-ubuntu-x64.tar.gz`,
    `llama-${tag}-bin-ubuntu-vulkan-arm64.tar.gz`,
    `llama-${tag}-bin-win-rocm-10.0-x64.zip`,
  ];
  const catalog = parseEngineRelease(
    release(
      tag,
      names.map((name, i) => asset(tag, name, bytes, i + 1)),
    ),
  );
  expect(catalog.variants).toHaveLength(6);
  expect(catalog.variants.find((item) => item.backend === 'cuda')).toMatchObject({
    platform: 'win32',
    backendVersion: '12.4',
    dependencies: [{ name: names[2] }],
  });
  expect(catalog.variants.filter((item) => item.platform === 'darwin')).toHaveLength(2);
  expect(
    catalog.variants.find((item) => item.platform === 'linux' && item.backend === 'vulkan')
      ?.architecture,
  ).toBe('arm64');
  const missing = parseEngineRelease(release(tag, [asset(tag, names[1]!, bytes)]));
  expect(missing.variants[0]?.unavailableReason).toContain('CUDA 런타임');
});

it('resolves the stable release pointer only after checking its official SHA-256', async () => {
  const pointer = Buffer.from('b123\n'),
    body = windowsArchive(),
    item = asset('b123', 'llama-b123-bin-win-cpu-x64.zip', body);
  const fetcher = vi.fn(async (url: string | URL | Request) =>
    String(url).endsWith('/releases/latest')
      ? Response.json(release('v0.6.0', [asset('v0.6.0', 'nightly-tag.txt', pointer)]))
      : String(url).endsWith('/nightly-tag.txt')
        ? new Response(pointer)
        : Response.json(release('b123', [item])),
  );
  const source = new EngineReleases(fetcher as typeof fetch);
  expect(await source.catalog('stable', new AbortController().signal)).toMatchObject({
    channel: 'stable',
    releaseTag: 'b123',
    variants: [{ id: 1 }],
  });
  expect(fetcher).toHaveBeenCalledTimes(3);
});

it('installs immutable versions, restores their source records, and blocks removing referenced engines or user files', async () => {
  const dir = await directory(),
    root = join(dir, 'engines'),
    one = windowsArchive(),
    two = windowsArchive('version2');
  const firstAsset = asset('b123', 'llama-b123-bin-win-cpu-x64.zip', one, 1),
    secondAsset = asset('b124', 'llama-b124-bin-win-cpu-x64.zip', two, 2);
  const fetcher = vi.fn(async (url: string | URL | Request) => {
    const address = String(url);
    if (address.includes('/releases/tags/'))
      return Response.json(
        address.endsWith('/b123') ? release('b123', [firstAsset]) : release('b124', [secondAsset]),
      );
    return new Response(address === firstAsset.browser_download_url ? one : two);
  });
  const manager = new EngineManager(root, fetcher as typeof fetch, {
    platform: 'win32',
    architecture: 'x64',
  });
  managers.push(manager);
  await manager.install({ releaseTag: 'b123', assetId: 1 });
  await expect
    .poll(async () => (await manager.snapshot()).installations[0]?.status)
    .toBe('completed');
  const initial = (await manager.snapshot()).installed[0]!;
  expect(await readFile(initial.enginePath, 'utf8')).toBe('MZversion1');
  await manager.install({ releaseTag: 'b124', assetId: 2 });
  await expect.poll(async () => (await manager.snapshot()).installed.length).toBe(2);
  expect(await readFile(initial.enginePath, 'utf8')).toBe('MZversion1');
  await expect(
    manager.action(initial.id, 'remove', [
      { path: initial.enginePath, name: 'Existing model', running: false },
    ]),
  ).rejects.toMatchObject({ code: 'ENGINE_IN_USE' });
  await expect(
    manager.action(initial.id, 'remove', [
      { path: initial.enginePath, name: 'Running model', running: true },
    ]),
  ).rejects.toMatchObject({ code: 'ENGINE_IN_USE' });
  await manager.close();
  const restored = new EngineManager(root, fetcher as typeof fetch, {
    platform: 'win32',
    architecture: 'x64',
  });
  managers.push(restored);
  expect(
    (await restored.snapshot()).installed.find((item) => item.id === initial.id),
  ).toMatchObject({
    releaseTag: 'b123',
    assets: [{ sha256: digest(one) }],
    enginePath: initial.enginePath,
  });
  const userFile = join(dirname(initial.enginePath), 'user-notes.txt');
  await writeFile(userFile, 'keep this');
  await expect(restored.action(initial.id, 'remove')).rejects.toMatchObject({
    code: 'ENGINE_CHANGED',
  });
  expect(await readFile(userFile, 'utf8')).toBe('keep this');
  await unlink(userFile); // Only the test-created file is removed by the fixture.
  await restored.action(initial.id, 'remove');
  expect((await restored.snapshot()).installed).toHaveLength(1);
  await expect(readFile(initial.enginePath)).rejects.toMatchObject({ code: 'ENOENT' });
});

it.each(['darwin', 'linux'] as const)(
  'installs %s tar assets and materializes bundled library links without executing binaries',
  async (platform) => {
    const root = await directory();
    const bytes = await tar([
      {
        name: 'build/llama-server',
        data: Buffer.from(platform === 'darwin' ? 'cffaedfe01020304' : '7f454c4601020304', 'hex'),
      },
      { name: 'build/libggml.1.so', data: Buffer.from('small fixture') },
      { name: 'build/libggml.so', type: 'symlink', linkname: 'libggml.1.so' },
    ]);
    const name = `llama-b123-bin-${platform === 'darwin' ? 'macos' : 'ubuntu'}-arm64.tar.gz`;
    const source = asset('b123', name, bytes);
    const fetcher = vi.fn(async (url: string | URL | Request) =>
      String(url).includes('api.github.com')
        ? Response.json(release('b123', [source]))
        : new Response(bytes),
    );
    const instance = new EngineManager(root, fetcher as typeof fetch, {
      platform,
      architecture: 'arm64',
    });
    managers.push(instance);
    await instance.install({ releaseTag: 'b123', assetId: 1 });
    await expect
      .poll(async () => (await instance.snapshot()).installations[0]?.status)
      .toBe('completed');
    const installed = (await instance.snapshot()).installed[0]!;
    expect(installed.platform).toBe(platform);
    const library = join(dirname(installed.enginePath), 'libggml.so');
    expect((await lstat(library)).isSymbolicLink()).toBe(false);
    expect(await readFile(library, 'utf8')).toBe('small fixture');
    await instance.action(installed.id, 'remove');
    expect((await instance.snapshot()).installed).toEqual([]);
  },
);

it('verifies and installs the matching CUDA dependency archive next to the server', async () => {
  const root = await directory(),
    main = windowsArchive(),
    runtime = zip([{ name: 'runtime/cudart64_12.dll', data: Buffer.from('CUDA fixture') }]);
  const a = asset('b123', 'llama-b123-bin-win-cuda-12.4-x64.zip', main, 1),
    b = asset('b123', 'cudart-llama-bin-win-cuda-12.4-x64.zip', runtime, 2);
  const fetcher = vi.fn(async (url: string | URL | Request) =>
    String(url).includes('api.github.com')
      ? Response.json(release('b123', [a, b]))
      : new Response(String(url) === a.browser_download_url ? main : runtime),
  );
  const instance = new EngineManager(root, fetcher as typeof fetch, {
    platform: 'win32',
    architecture: 'x64',
  });
  managers.push(instance);
  await instance.install({ releaseTag: 'b123', assetId: 1 });
  await expect
    .poll(async () => (await instance.snapshot()).installations[0]?.status)
    .toBe('completed');
  const installed = (await instance.snapshot()).installed[0]!;
  expect(installed.assets).toHaveLength(2);
  expect(await readFile(join(dirname(installed.enginePath), 'cudart64_12.dll'), 'utf8')).toBe(
    'CUDA fixture',
  );
});

it('fails a mismatched digest without publishing an engine or modifying external files', async () => {
  const dir = await directory(),
    root = join(dir, 'engines'),
    content = windowsArchive();
  const item = {
    ...asset('b123', 'llama-b123-bin-win-cpu-x64.zip', content),
    digest: 'sha256:' + '0'.repeat(64),
  };
  const outside = join(dir, 'keep.txt');
  await writeFile(outside, 'original');
  const fetcher = vi.fn(async (url: string | URL | Request) =>
    String(url).includes('/releases/tags/')
      ? Response.json(release('b123', [item]))
      : new Response(content),
  );
  const manager = new EngineManager(root, fetcher as typeof fetch, {
    platform: 'win32',
    architecture: 'x64',
  });
  managers.push(manager);
  await manager.install({ releaseTag: 'b123', assetId: 1 });
  await expect.poll(async () => (await manager.snapshot()).installations[0]?.status).toBe('failed');
  expect((await manager.snapshot()).installed).toEqual([]);
  expect(await readdir(join(root, 'versions'))).toEqual([]);
  expect(await readFile(outside, 'utf8')).toBe('original');
});

it('cancels a pending archive download and does not retry failed metadata requests in a loop', async () => {
  const root = await directory(),
    content = windowsArchive(),
    item = asset('b123', 'llama-b123-bin-win-cpu-x64.zip', content);
  const fetcher = vi.fn(async (url: string | URL | Request) =>
    String(url).includes('/releases/tags/')
      ? Response.json(release('b123', [item]))
      : String(url).endsWith('/releases/latest')
        ? new Response('', { status: 429 })
        : new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(content.subarray(0, 10));
              },
            }),
          ),
  );
  const manager = new EngineManager(root, fetcher as typeof fetch, {
    platform: 'win32',
    architecture: 'x64',
  });
  managers.push(manager);
  await expect(manager.catalog('stable')).rejects.toThrow('429');
  expect(fetcher).toHaveBeenCalledTimes(1);
  const job = await manager.install({ releaseTag: 'b123', assetId: 1 });
  await expect
    .poll(async () => (await manager.snapshot()).installations[0]?.downloadedBytes)
    .toBe(10);
  await manager.action(job.id, 'cancel');
  expect((await manager.snapshot()).installations[0]?.status).toBe('cancelled');
  expect((await manager.snapshot()).installed).toEqual([]);
});

it.each(['zip', 'tar.gz'] as const)(
  'extracts bounded regular files and internal library links from %s',
  async (format) => {
    const dir = await directory(),
      file = join(dir, 'archive'),
      output = join(dir, 'output');
    const bytes =
      format === 'zip'
        ? zip([
            { name: 'lib/libtest.so.1', data: Buffer.from('library') },
            { name: 'lib/libtest.so', data: Buffer.from('libtest.so.1'), mode: 0o120777 },
          ])
        : await tar([
            { name: 'lib/libtest.so.1', data: Buffer.from('library') },
            { name: 'lib/libtest.so', type: 'symlink', linkname: 'libtest.so.1' },
          ]);
    await writeFile(file, bytes);
    const extracted = await extractEngineArchive(
      file,
      output,
      format,
      new AbortController().signal,
    );
    expect(extracted.map((item) => item.path)).toEqual(['lib/libtest.so.1', 'lib/libtest.so']);
    expect(await readFile(join(output, 'lib/libtest.so'), 'utf8')).toBe('library');
  },
);

it('rejects traversal, escaping links, duplicate names and expansion limits', async () => {
  for (const path of [
    '../outside',
    'C:/Windows/file',
    '\\server\share',
    'safe/../escape',
    'safe/NUL',
    'safe/file:stream',
    'safe/trailing.',
  ])
    expect(() => archivePath(path)).toThrow();
  const dir = await directory();
  const fixtures = [
    { format: 'zip' as const, bytes: zip([{ name: '../outside', data: Buffer.from('bad') }]) },
    {
      format: 'tar.gz' as const,
      bytes: await tar([{ name: 'link', type: 'symlink', linkname: '../outside' }]),
    },
    {
      format: 'zip' as const,
      bytes: zip([
        { name: 'file', data: Buffer.from('1') },
        { name: 'FILE', data: Buffer.from('2') },
      ]),
    },
    { format: 'tar.gz' as const, bytes: await tar([{ name: 'large', data: Buffer.alloc(100) }]) },
  ];
  for (const [index, item] of fixtures.entries()) {
    const archive = join(dir, `archive${index}`);
    await writeFile(archive, item.bytes);
    await expect(
      extractEngineArchive(
        archive,
        join(dir, `output${index}`),
        item.format,
        new AbortController().signal,
        { bytes: 16, entries: 10 },
      ),
    ).rejects.toThrow();
  }
  await expect(readFile(join(dir, 'outside'))).rejects.toMatchObject({ code: 'ENOENT' });
});
