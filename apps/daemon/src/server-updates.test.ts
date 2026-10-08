import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { defaultModelConfig, makeCommand } from '@lodex/contracts';
import { Store } from '@lodex/storage';
import { startServer } from './server';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});
async function fixture(backup = true) {
  const directory = await mkdtemp(join(tmpdir(), 'lodex-update-'));
  const store = await Store.open(
    join(directory, 'state.sqlite'),
    resolve('apps/daemon/dist/worker.cjs'),
  );
  const app = await startServer({
    token: 'u'.repeat(64),
    store,
    ...(backup ? { backupRoot: join(directory, 'backups') } : {}),
  });
  cleanup.push(async () => {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  });
  const request = (path: string, body?: unknown) =>
    fetch(`http://127.0.0.1:${app.port}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { authorization: 'Bearer ' + 'u'.repeat(64), 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const createSession = () =>
    request(
      '/v1/commands',
      makeCommand({
        type: 'create_session',
        sessionId: crypto.randomUUID(),
        title: 'Update test',
        config: { ...defaultModelConfig(), provider: 'demo' },
        projectId: null,
      }),
    );
  return { request, createSession, store };
}
it('backs up an idle app and blocks desktop and remote mutation until released', async () => {
  const { request, createSession } = await fixture();
  expect((await createSession()).status).toBe(200);
  const prepared = await request('/v1/updates/prepare', {});
  expect(prepared.status).toBe(200);
  const result = await prepared.json();
  expect(result.backup.name).toMatch(/^lodex-/);
  expect((await createSession()).status).toBe(409);
  expect((await request('/v1/telegram/config', {})).status).toBe(409);
  expect((await request('/v1/state')).status).toBe(200);
  await request('/v1/updates/release', { token: crypto.randomUUID() });
  expect((await createSession()).status).toBe(409);
  expect((await request('/v1/updates/release', { token: result.token })).status).toBe(200);
  expect((await createSession()).status).toBe(200);
});
it('does not leave the app locked when the pre-update backup is unavailable', async () => {
  const { request, createSession } = await fixture(false);
  expect((await request('/v1/updates/prepare', {})).status).toBe(503);
  expect((await createSession()).status).toBe(200);
});
it('waits for in-flight settings mutations before allowing an update snapshot', async () => {
  const { request, createSession, store } = await fixture();
  const created = await (await createSession()).json();
  let entered: () => void = () => undefined;
  let resume: () => void = () => undefined;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const pending = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const session = store.session.bind(store);
  const spy = vi.spyOn(store, 'session').mockImplementationOnce(async (id) => {
    entered();
    await pending;
    return session(id);
  });
  const saving = request('/v1/automations', {
    version: 0,
    automation: {
      name: 'Update race',
      sessionId: created.session.id,
      prompt: 'Fixture only',
      enabled: false,
      trigger: { kind: 'interval', minutes: 1 },
    },
  });
  try {
    await started;
    expect((await request('/v1/updates/prepare', {})).status).toBe(409);
  } finally {
    resume();
    spy.mockRestore();
    await saving;
  }
  expect((await request('/v1/updates/prepare', {})).status).toBe(200);
});
