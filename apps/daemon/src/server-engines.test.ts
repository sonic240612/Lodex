import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '@lodex/storage';
import { startServer } from './server';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});
it('exposes authenticated explicit engine discovery, validates installs, and never fetches a release during snapshot polling', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lodex-server-engines-'));
  const store = await Store.open(
    join(directory, 'state.sqlite'),
    resolve('apps/daemon/dist/worker.cjs'),
  );
  const metadata = {
    tag_name: 'b123',
    html_url: 'https://github.com/ggml-org/llama.cpp/releases/tag/b123',
    published_at: '2026-10-01T00:00:00.000Z',
    draft: false,
    prerelease: true,
    assets: [
      {
        id: 1,
        name: 'llama-b123-bin-win-cpu-x64.zip',
        size: 100,
        digest: null,
        browser_download_url:
          'https://github.com/ggml-org/llama.cpp/releases/download/b123/llama-b123-bin-win-cpu-x64.zip',
      },
    ],
  };
  const fetcher = vi.fn(async () => Response.json(metadata));
  const app = await startServer({
    token: 'e'.repeat(64),
    store,
    engineRoot: join(directory, 'engines'),
    engineFetch: fetcher as typeof fetch,
  });
  cleanup.push(async () => {
    await app.close();
    if (dirname(resolve(directory)) !== resolve(tmpdir())) throw new Error('Unsafe cleanup');
    await rm(directory, { recursive: true, force: true });
  });
  const request = (path: string, body?: unknown, authenticated = true) =>
    fetch(`http://127.0.0.1:${app.port}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        ...(authenticated ? { authorization: 'Bearer ' + 'e'.repeat(64) } : {}),
        'content-type': 'application/json',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  expect((await request('/v1/runtime/engines/catalog', { channel: 'stable' }, false)).status).toBe(
    401,
  );
  expect(fetcher).not.toHaveBeenCalled();
  expect((await request('/v1/runtime/engines/catalog', { channel: 'invalid' })).status).toBe(400);
  const catalog = await request('/v1/runtime/engines/catalog', { channel: 'stable' });
  expect(catalog.status).toBe(200);
  expect((await catalog.json()).variants[0].unavailableReason).toContain('SHA-256');
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect((await request('/v1/runtime')).status).toBe(200);
  expect((await request('/v1/runtime')).status).toBe(200);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(
    (await request('/v1/runtime/engines/install', { releaseTag: '../escape', assetId: 1 })).status,
  ).toBe(400);
  expect(
    (await request('/v1/runtime/engines/install', { releaseTag: 'b123', assetId: 1 })).status,
  ).toBe(400);
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(
    (await request('/v1/runtime/engines/action', { id: '../escape', action: 'remove' })).status,
  ).toBe(400);
  const state = await (await request('/v1/runtime')).json();
  expect(state.engines.installed).toEqual([]);
  expect(state.engines.installations).toEqual([]);
});
