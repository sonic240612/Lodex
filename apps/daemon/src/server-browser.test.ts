import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Store } from '@lodex/storage';
import {
  defaultModelConfig,
  makeCommand,
  type InferenceProvider,
  type InferenceRequest,
  type Session,
} from '@lodex/contracts';
import { startServer } from './server';
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
it('persists browser and schedule settings and offers browser tools only to full Build runs', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lodex-browser-server-'));
  const store = await Store.open(join(dir, 'state.sqlite'), resolve('apps/daemon/dist/worker.cjs'));
  const requests: InferenceRequest[] = [];
  const provider: InferenceProvider = {
    listModels: async () => [],
    capabilities: async () => ({ tools: true, streaming: true }),
    async *generate(request) {
      requests.push(request);
      yield { type: 'text_delta', text: 'done' };
      yield { type: 'finished', reason: 'stop' };
    },
  };
  const token = 'b'.repeat(64);
  const app = await startServer({ store, token, providerFactory: () => provider });
  cleanup.push(async () => {
    await app.close();
    if (dirname(resolve(dir)) !== resolve(tmpdir())) throw new Error('unsafe');
    await rm(dir, { recursive: true, force: true });
  });
  const request = (path: string, body?: unknown) =>
    fetch(`http://127.0.0.1:${app.port}${path}`, {
      method: body ? 'POST' : 'GET',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  expect(await (await request('/v1/browser')).json()).toMatchObject({ config: { enabled: false } });
  const configured = await request('/v1/browser', {
    version: 0,
    config: { enabled: true, channel: 'chrome' },
  });
  expect(configured.status).toBe(200);
  expect((await store.integration('browser'))?.document).toMatchObject({ enabled: true });
  expect((await request('/v1/browser', { version: 0, config: { enabled: false } })).status).toBe(
    409,
  );
  for (const [permission, mode] of [
    ['ask', 'build'],
    ['auto', 'build'],
    ['full', 'plan'],
    ['full', 'build'],
  ] as const) {
    let session: Session = (
      await store.apply(
        makeCommand({
          type: 'create_session',
          sessionId: crypto.randomUUID(),
          title: 'Browser matrix',
          config: { ...defaultModelConfig(), provider: 'demo' },
        }),
      )
    ).session;
    session = (
      await store.apply(
        makeCommand({
          type: 'set_permission_mode',
          sessionId: session.id,
          expectedVersion: session.version,
          mode: permission,
        }),
      )
    ).session;
    expect(
      (
        await request(
          '/v1/commands',
          makeCommand({
            type: 'send_message',
            sessionId: session.id,
            expectedVersion: session.version,
            mode,
            content: 'Inspect browser availability',
          }),
        )
      ).status,
    ).toBe(200);
    await expect.poll(async () => (await store.session(session.id)).run?.status).toBe('completed');
    expect(
      requests.at(-1)!.tools?.some((tool) => tool.function.name === 'browser_action') ?? false,
    ).toBe(permission === 'full' && mode === 'build');
    if (mode === 'build' && permission === 'full') {
      expect(
        (
          await request('/v1/automations', {
            version: 0,
            automation: {
              name: 'Local fixture',
              sessionId: session.id,
              prompt: 'Check the fixture',
              trigger: { kind: 'interval', minutes: 60 },
              enabled: false,
            },
          })
        ).status,
      ).toBe(200);
      const snapshot = await (await request('/v1/automations')).json();
      expect(snapshot.records).toHaveLength(1);
      expect((await store.integration('automations'))?.document).toMatchObject([
        { enabled: false },
      ]);
      expect(
        (
          await request('/v1/automations/remove', {
            version: snapshot.version,
            id: snapshot.records[0].id,
          })
        ).status,
      ).toBe(200);
    }
  }
});
