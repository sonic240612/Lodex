import { afterEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import {
  mkdtemp,
  readFile,
  writeFile,
  rm,
  mkdir,
  rename,
  symlink,
  link,
  lstat,
} from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { ModelDownloads } from './downloads';
import { inspectModelGroup } from './index';
import { splitModelFiles } from './model-files';

const dirs: string[] = [],
  managers: ModelDownloads[] = [];
afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.close();
  for (const dir of dirs.splice(0)) {
    if (dirname(resolve(dir)) !== resolve(tmpdir())) throw new Error('Unsafe cleanup');
    await rm(dir, { recursive: true, force: true });
  }
});
async function directory() {
  const path = await mkdtemp(join(tmpdir(), 'lodex-download-test-'));
  dirs.push(path);
  return path;
}
function manager(root: string, fetcher: typeof fetch) {
  const instance = new ModelDownloads(root, fetcher, inspectModelGroup);
  managers.push(instance);
  return instance;
}
function gguf(index?: number, count = 2, total = 2, tensors = 1) {
  const string = (value: string) => {
    const bytes = Buffer.from(value),
      n = Buffer.alloc(8);
    n.writeBigUInt64LE(BigInt(bytes.length));
    return Buffer.concat([n, bytes]);
  };
  const int = (key: string, value: number, type = 2) => {
    const typeBytes = Buffer.alloc(4);
    typeBytes.writeUInt32LE(type);
    const bytes = Buffer.alloc(type === 2 ? 2 : 4);
    if (type === 2) bytes.writeUInt16LE(value);
    else bytes.writeInt32LE(value);
    return Buffer.concat([string(key), typeBytes, bytes]);
  };
  const parts =
    index === undefined
      ? []
      : [int('split.no', index), int('split.count', count), int('split.tensors.count', total, 5)];
  const header = Buffer.alloc(24);
  header.write('GGUF');
  header.writeUInt32LE(3, 4);
  header.writeBigUInt64LE(BigInt(tensors), 8);
  header.writeBigUInt64LE(BigInt(parts.length), 16);
  return Buffer.concat([header, ...parts, Buffer.alloc(128, 7)]);
}
const input = { repository: 'owner/model', file: 'model.gguf', revision: 'main' };
const hash = (data: Buffer) => createHash('sha256').update(data).digest('hex');
function pausedResponse(data: Buffer, etag = '"v1"') {
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(data.subarray(0, 40));
      },
    }),
    {
      headers: { 'content-length': String(data.length), ...(etag ? { etag } : {}) },
    },
  );
}
async function pause(instance: ModelDownloads, id: string) {
  await expect.poll(async () => (await instance.snapshot())[0]?.downloadedBytes).toBe(40);
  await instance.action(id, 'cancel');
}

it.each(['failed', 'completed'] as const)(
  'waits for %s manifest persistence before accepting the next action',
  async (terminal) => {
    const root = await directory(),
      data = gguf();
    let requests = 0;
    const instance = manager(root, (async () => {
      requests += 1;
      return terminal === 'failed' && requests === 1
        ? new Response('', { status: 503 })
        : new Response(data);
    }) as typeof fetch);
    // Delay only the final durable write, after snapshot() exposes terminal state.
    // This reproduces a slow filesystem without depending on OS timings or sleeps.
    const persistence = instance as unknown as { persist(): Promise<void> };
    const persist = persistence.persist.bind(instance);
    let entered!: () => void, release!: () => void;
    const terminalWrite = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let delayed = false;
    const spy = vi.spyOn(persistence, 'persist').mockImplementation(async () => {
      if (!delayed && (await instance.snapshot())[0]?.status === terminal) {
        delayed = true;
        entered();
        await blocked;
      }
      await persist();
    });
    try {
      const started = await instance.start(input);
      await terminalWrite;
      expect((await instance.snapshot())[0]?.status).toBe(terminal);
      let outcome = 'pending';
      const action = instance.action(started.id, terminal === 'failed' ? 'resume' : 'remove');
      void action.then(
        () => {
          outcome = 'resolved';
        },
        () => {
          outcome = 'rejected';
        },
      );
      // Let the action reach the persistence barrier in this event-loop turn.
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(outcome).toBe('pending');
      expect(requests).toBe(1);
      release();
      await action;
      if (terminal === 'completed') {
        expect(await instance.snapshot()).toEqual([]);
        expect(JSON.parse(await readFile(join(root, '.downloads.json'), 'utf8')).downloads).toEqual(
          [],
        );
      } else {
        await expect.poll(async () => (await instance.snapshot())[0]?.status).toBe('completed');
        expect(requests).toBe(2);
      }
    } finally {
      release();
      await instance.close();
      spy.mockRestore();
    }
  },
);

it('keeps partial files and SHA expectations across restart, then resumes at the exact byte with If-Range', async () => {
  const root = await directory(),
    data = gguf();
  const first = manager(root, vi.fn(async () => pausedResponse(data)) as typeof fetch);
  const download = await first.start({ ...input, expectedSha256: hash(data) });
  await pause(first, download.id);
  await first.close();
  const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
    expect(new Headers(init?.headers).get('Range')).toBe('bytes=40-');
    expect(new Headers(init?.headers).get('If-Range')).toBe('"v1"');
    return new Response(data.subarray(40), {
      status: 206,
      headers: {
        etag: '"v1"',
        'content-range': `bytes 40-${data.length - 1}/${data.length}`,
        'content-length': String(data.length - 40),
      },
    });
  });
  const second = manager(root, fetcher as typeof fetch);
  expect((await second.snapshot())[0]).toMatchObject({
    status: 'cancelled',
    downloadedBytes: 40,
    expectedSha256: hash(data),
  });
  await second.action(download.id, 'resume');
  await expect.poll(async () => (await second.snapshot())[0]?.status).toBe('completed');
  const completed = (await second.snapshot())[0]!;
  expect(completed.sha256).toBe(hash(data));
  expect(await readFile(completed.modelPath!)).toEqual(data);
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it.each(['changed-etag', 'ignored-range', 'missing-etag'] as const)(
  'restarts safely instead of appending a different revision (%s)',
  async (kind) => {
    const root = await directory(),
      original = gguf(),
      changed = Buffer.from(original);
    changed[changed.length - 1] = 9;
    let calls = 0;
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
      calls++;
      if (calls === 1) return pausedResponse(original, kind === 'missing-etag' ? '' : '"v1"');
      const range = new Headers(init?.headers).get('Range');
      if (kind === 'changed-etag' && calls === 2) {
        expect(range).toBe('bytes=40-');
        return new Response(changed.subarray(40), {
          status: 206,
          headers: {
            etag: '"v2"',
            'content-range': `bytes 40-${changed.length - 1}/${changed.length}`,
          },
        });
      }
      if (kind !== 'ignored-range') expect(range).toBeNull();
      return new Response(changed, {
        headers: { etag: '"v2"', 'content-length': String(changed.length) },
      });
    });
    const instance = manager(root, fetcher as typeof fetch);
    const started = await instance.start(input);
    await pause(instance, started.id);
    await instance.action(started.id, 'resume');
    await expect.poll(async () => (await instance.snapshot())[0]?.status).toBe('completed');
    expect(await readFile((await instance.snapshot())[0]!.modelPath!)).toEqual(changed);
    expect(calls).toBe(kind === 'changed-etag' ? 3 : 2);
  },
);

it('pins a split group to one repository commit, resumes only missing parts, and protects every registered shard', async () => {
  const root = await directory(),
    commit = 'a'.repeat(40);
  const files = ['model-00001-of-00002.gguf', 'model-00002-of-00002.gguf'];
  const payload = [gguf(0, 2, 2, 0), gguf(1, 2, 2, 2)];
  let allowSecond = false;
  const fetcher = vi.fn(async (url: string | URL | Request) => {
    const address = String(url);
    if (address.includes('/api/models/')) return Response.json({ sha: commit });
    expect(address).toContain(`/resolve/${commit}/`);
    const index = address.includes(files[0]!) ? 0 : 1;
    if (index === 1 && !allowSecond) return new Response('', { status: 503 });
    return new Response(payload[index], {
      headers: { 'content-length': String(payload[index]!.length), etag: `"part${index}"` },
    });
  });
  const instance = manager(root, fetcher as typeof fetch);
  const started = await instance.start({ ...input, file: files[1]! });
  await expect.poll(async () => (await instance.snapshot())[0]?.status).toBe('failed');
  const failed = (await instance.snapshot())[0]!;
  expect(failed.parts!.map((part) => !!part.sha256)).toEqual([true, false]);
  await expect(inspectModelGroup(failed.modelPath!)).rejects.toMatchObject({
    code: 'GGUF_SPLIT_MISSING',
  });
  allowSecond = true;
  await instance.action(started.id, 'resume');
  await expect.poll(async () => (await instance.snapshot())[0]?.status).toBe('completed');
  const inspection = await inspectModelGroup(failed.modelPath!);
  expect(inspection.files).toHaveLength(2);
  expect(inspection.size).toBe(payload[0]!.length + payload[1]!.length);
  expect(fetcher.mock.calls.filter(([url]) => String(url).includes(files[0]!))).toHaveLength(1);
  await expect(
    instance.action(started.id, 'remove', [inspection.files[1]!.path]),
  ).rejects.toMatchObject({ code: 'MODEL_DOWNLOAD_REGISTERED' });
  await instance.action(started.id, 'remove');
  expect(await instance.snapshot()).toEqual([]);
  await expect(readFile(inspection.files[1]!.path)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('rejects mixed split metadata and unsupported shard names', async () => {
  const root = await directory();
  const first = join(root, 'model-00001-of-00002.gguf');
  const second = join(root, 'model-00002-of-00002.gguf');
  await writeFile(first, gguf(0));
  await writeFile(second, gguf(0));
  await expect(inspectModelGroup(first)).rejects.toMatchObject({ code: 'GGUF_SPLIT_MISMATCH' });
  await writeFile(second, gguf(1, 2, 3));
  await expect(inspectModelGroup(first)).rejects.toMatchObject({ code: 'GGUF_SPLIT_MISMATCH' });
  expect(() => splitModelFiles('model-00001-of-99999.gguf')).toThrow();
});

it('preserves the expected hash after failure and restarts a bad partial download from zero', async () => {
  const root = await directory(),
    correct = gguf(),
    wrong = Buffer.from(correct);
  wrong[wrong.length - 1] = 4;
  const fetcher = vi
    .fn()
    .mockImplementationOnce(async () => new Response(wrong, { headers: { etag: '"wrong"' } }))
    .mockImplementationOnce(async (_url, init) => {
      expect(new Headers(init.headers).get('Range')).toBeNull();
      return new Response(correct);
    });
  const instance = manager(root, fetcher as typeof fetch);
  const started = await instance.start({ ...input, expectedSha256: hash(correct) });
  await expect.poll(async () => (await instance.snapshot())[0]?.status).toBe('failed');
  expect((await instance.snapshot())[0]?.downloadedBytes).toBe(0);
  await instance.action(started.id, 'resume');
  await expect.poll(async () => (await instance.snapshot())[0]?.status).toBe('completed');
});

it('recovers a crash between publishing the verified file and marking the download complete', async () => {
  const root = await directory(),
    data = gguf();
  const first = manager(root, (async () => new Response(data)) as typeof fetch);
  const started = await first.start(input);
  await expect.poll(async () => (await first.snapshot())[0]?.status).toBe('completed');
  await first.close();
  const path = join(root, '.downloads.json');
  const manifest = JSON.parse(await readFile(path, 'utf8'));
  const record = manifest.downloads[0];
  record.status = 'downloading';
  record.parts[0].verifiedSha256 = record.parts[0].sha256;
  delete record.parts[0].sha256;
  await writeFile(path, JSON.stringify(manifest));
  const fetcher = vi.fn(async () => {
    throw new Error('Verified file must not be downloaded again');
  });
  const restored = manager(root, fetcher as typeof fetch);
  expect((await restored.snapshot())[0]).toMatchObject({
    status: 'cancelled',
    downloadedBytes: data.length,
    parts: [{ sha256: hash(data) }],
  });
  await restored.action(started.id, 'resume');
  await expect.poll(async () => (await restored.snapshot())[0]?.status).toBe('completed');
  expect(fetcher).not.toHaveBeenCalled();
});

it('never recovers or unlinks files through a replaced repository folder during restart', async () => {
  const root = await directory(),
    outside = await directory(),
    data = gguf();
  const first = manager(root, (async () => new Response(data)) as typeof fetch);
  const started = await first.start(input);
  await expect.poll(async () => (await first.snapshot())[0]?.status).toBe('completed');
  await first.close();
  const manifestPath = join(root, '.downloads.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.downloads[0].parts[0].verifiedSha256 = hash(data);
  delete manifest.downloads[0].parts[0].sha256;
  await writeFile(manifestPath, JSON.stringify(manifest));
  await rename(join(root, 'owner--model'), join(root, 'saved-repository'));
  await writeFile(join(outside, input.file), data);
  const temporary = join(outside, input.file + '.' + started.id + '.part');
  await writeFile(temporary, 'outside private file');
  await symlink(
    outside,
    join(root, 'owner--model'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  const second = manager(root, vi.fn() as typeof fetch);
  expect(await second.snapshot()).toEqual([]);
  expect(await readFile(temporary, 'utf8')).toBe('outside private file');
  expect(await readFile(join(outside, input.file))).toEqual(data);
});

it('checks repository parents before resume/removal and never creates nested paths through links', async () => {
  const root = await directory(),
    outside = await directory(),
    data = gguf();
  const instance = manager(root, (async () => new Response(data)) as typeof fetch);
  const started = await instance.start(input);
  await expect.poll(async () => (await instance.snapshot())[0]?.status).toBe('completed');
  await rename(join(root, 'owner--model'), join(root, 'saved-repository'));
  await writeFile(join(outside, input.file), data);
  await symlink(
    outside,
    join(root, 'owner--model'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  await expect(instance.action(started.id, 'remove')).rejects.toMatchObject({
    code: 'MODEL_DOWNLOAD_PATH',
  });
  await expect(instance.action(started.id, 'resume')).rejects.toMatchObject({
    code: 'MODEL_DOWNLOAD_PATH',
  });
  await expect(instance.start({ ...input, file: 'nested/new.gguf' })).rejects.toMatchObject({
    code: 'MODEL_DOWNLOAD_PATH',
  });
  await expect(lstat(join(outside, 'nested'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await readFile(join(outside, input.file))).toEqual(data);
});

it('pins the download root and does not overwrite predictable temporary manifest links', async () => {
  const base = await directory(),
    outside = await directory(),
    root = join(base, 'downloads');
  await mkdir(root);
  const linked = join(outside, 'private.txt');
  await writeFile(linked, 'keep me');
  await link(linked, join(root, '.downloads.json.tmp'));
  const instance = manager(root, (async () => new Response(gguf())) as typeof fetch);
  await instance.start(input);
  await expect.poll(async () => (await instance.snapshot())[0]?.status).toBe('completed');
  expect(await readFile(linked, 'utf8')).toBe('keep me');
  await rename(root, join(base, 'saved-downloads'));
  await symlink(outside, root, process.platform === 'win32' ? 'junction' : 'dir');
  await expect(instance.start({ ...input, file: 'another.gguf' })).rejects.toMatchObject({
    code: 'MODEL_DOWNLOAD_PATH',
  });
  await expect(lstat(join(outside, '.downloads.json'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('refuses to truncate a partial file changed to a hard link while fetching the response', async () => {
  const root = await directory(),
    outside = await directory(),
    data = gguf();
  let id = '';
  let count = 0;
  const protectedPath = join(outside, 'private.txt');
  await writeFile(protectedPath, 'do not truncate');
  const instance = manager(root, (async () => {
    if (++count === 1) return pausedResponse(data);
    const temporary = join(root, 'owner--model', input.file + '.' + id + '.part');
    await rm(temporary);
    await link(protectedPath, temporary);
    return new Response(data);
  }) as typeof fetch);
  id = (await instance.start(input)).id;
  await pause(instance, id);
  await instance.action(id, 'resume');
  await expect.poll(async () => (await instance.snapshot())[0]?.status).toBe('failed');
  expect(await readFile(protectedPath, 'utf8')).toBe('do not truncate');
});
