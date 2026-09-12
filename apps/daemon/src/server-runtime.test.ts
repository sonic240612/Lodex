import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, writeFile, readFile, lstat, realpath, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  defaultModelConfig,
  engineSettingsSchema,
  makeCommand,
  type LocalProfile,
  type Session,
  type RuntimeSnapshot,
} from '@lodex/contracts';
import { Store } from '@lodex/storage';
import { startServer } from './server';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'lodex-managed-api 한글-'));
  const store = await Store.open(join(dir, 'state.sqlite'), resolve('apps/daemon/dist/worker.cjs'));
  const app = await startServer({
    token: 'a'.repeat(64),
    store,
    supervisorPath: resolve('apps/daemon/dist/supervisor.cjs'),
  });
  cleanups.push(async () => {
    await app.close();
    if (dirname(resolve(dir)) !== resolve(tmpdir())) throw new Error('Unsafe fixture directory');
    await rm(dir, { recursive: true, force: true });
  });
  const script = join(dir, 'http-engine.cjs'),
    capture = join(dir, 'request.json');
  await writeFile(
    script,
    `const http = require('node:http'), fs = require('node:fs');
const args = process.argv.slice(2), arg = k => args[args.indexOf(k) + 1];
http.createServer(async (req, res) => {
  if (req.headers.authorization !== 'Bearer ' + arg('--api-key')) { res.writeHead(401); res.end(); return; }
  if (req.url === '/health') { res.end('{}'); return; }
  if (req.url !== '/v1/chat/completions') { res.writeHead(404); res.end(); return; }
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  fs.writeFileSync(${JSON.stringify(capture)}, Buffer.concat(chunks));
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'managed fixture response' }, finish_reason: null }] }) + '\\n\\n');
  res.end('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + '\\n\\ndata: [DONE]\\n\\n');
}).listen(Number(arg('--port')), arg('--host'));
`,
  );
  const modelPath = join(dir, 'fixture.gguf'),
    header = Buffer.alloc(24);
  header.write('GGUF');
  header.writeUInt32LE(3, 4);
  header.writeBigUInt64LE(1n, 8);
  await writeFile(modelPath, header);
  const enginePath = await realpath(process.execPath);
  const identity = async (path: string) => {
    const s = await lstat(path);
    return `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}`;
  };
  const profile: LocalProfile = await store.saveLocalProfile({
    id: crypto.randomUUID(),
    version: 1,
    name: 'Managed fixture',
    enginePath,
    modelPath,
    engineIdentity: await identity(enginePath),
    modelIdentity: await identity(modelPath),
    engineVersion: 'Node fixture; not llama.cpp',
    ggufVersion: 3,
    modelBytes: 24,
    vramReservationMb: 64,
    settings: engineSettingsSchema.parse({ extraArgs: [script] }),
    supportedFlags: [
      '--model',
      '--host',
      '--port',
      '--alias',
      '--api-key',
      '--ctx-size',
      '--gpu-layers',
      '--threads',
      '--threads-batch',
      '--batch-size',
      '--ubatch-size',
      '--flash-attn',
      '--cache-type-k',
      '--cache-type-v',
      '--parallel',
      '--jinja',
      '--fit',
    ],
  });
  const request = (path: string, value?: unknown) =>
    fetch('http://127.0.0.1:' + app.port + path, {
      method: value === undefined ? 'GET' : 'POST',
      headers: { Authorization: 'Bearer ' + 'a'.repeat(64), 'Content-Type': 'application/json' },
      ...(value === undefined ? {} : { body: JSON.stringify(value) }),
    });
  const sessionId = crypto.randomUUID();
  const created = await request(
    '/v1/commands',
    makeCommand({
      type: 'create_session',
      sessionId,
      title: 'Managed model',
      config: {
        ...defaultModelConfig(),
        model: profile.name,
        managedModelId: profile.id,
        managedModelVersion: profile.version,
        baseUrl: 'http://127.0.0.1:1/v1',
      },
    }),
  );
  expect(created.status).toBe(200);
  const session = (await created.json()).session as Session;
  const send = () =>
    request(
      '/v1/commands',
      makeCommand({
        type: 'send_message',
        sessionId,
        expectedVersion: session.version,
        content: 'hello',
      }),
    );
  return { store, request, profile, session, send, capture };
}

describe('managed model daemon integration', () => {
  it('loads its own authenticated engine, routes chat and releases the lease without changing stored configuration', async () => {
    const app = await fixture();
    expect((await app.send()).status).toBe(200);
    await expect
      .poll(async () => (await app.store.session(app.session.id)).run?.status, { timeout: 10000 })
      .toBe('completed');
    const current = await app.store.session(app.session.id);
    expect(current.messages.at(-1)?.content).toBe('managed fixture response');
    expect(current.config).toEqual(app.session.config);
    expect(JSON.parse(await readFile(app.capture, 'utf8')).model).toBe('lodex-' + app.profile.id);
    await expect
      .poll(
        async () =>
          ((await app.request('/v1/runtime').then((r) => r.json())) as RuntimeSnapshot).instances[0]
            ?.leases,
      )
      .toBe(0);
    const unloaded = await app.request('/v1/runtime/action', {
      profileId: app.profile.id,
      action: 'unload',
    });
    expect(unloaded.status).toBe(200);
    expect((await unloaded.json()).instances[0].status).toBe('stopped');
  });

  it('rejects changed or removed profiles before persisting a user message', async () => {
    const app = await fixture();
    await app.store.saveLocalProfile({ ...app.profile, name: 'updated' }, app.profile.version);
    const changed = await app.send();
    expect(changed.status).toBe(409);
    expect((await changed.json()).error.code).toBe('MODEL_PROFILE_CHANGED');
    expect((await app.store.session(app.session.id)).messages).toHaveLength(0);
    await app.store.removeLocalProfile(app.profile.id);
    expect((await app.send()).status).toBe(409);
    expect((await app.store.session(app.session.id)).run).toBeNull();
  });

  it('enforces runtime setting versions through the API', async () => {
    const app = await fixture();
    const initial = (await app.request('/v1/runtime').then((r) => r.json())).settings;
    const saved = await app.request('/v1/runtime/settings', { ...initial, vramBudgetMb: 16384 });
    expect(saved.status).toBe(200);
    expect((await saved.json()).settings.version).toBe(1);
    const stale = await app.request('/v1/runtime/settings', { ...initial, vramBudgetMb: 8192 });
    expect(stale.status).toBe(409);
    expect((await stale.json()).error.code).toBe('VERSION_CONFLICT');
    expect((await app.request('/v1/runtime/action', null)).status).toBe(400);
  });
});
