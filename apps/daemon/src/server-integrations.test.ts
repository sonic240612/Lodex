import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import {
  defaultModelConfig,
  makeCommand,
  deleteSessionsSchema,
  type Session,
} from '@lodex/contracts';
import { Store } from '@lodex/storage';
import { startServer } from './server';
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});
it('connects paired Telegram requests to the normal agent loop and clears channel scope on HTTP deletion', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lodex-integration-api-'));
  const store = await Store.open(join(dir, 'state.sqlite'), resolve('apps/daemon/dist/worker.cjs'));
  const updates: unknown[] = [],
    sent: string[] = [];
  let generations = 0;
  const telegramFetch: typeof fetch = async (input, init) => {
    const method = String(input).split('/').at(-1),
      body = JSON.parse(String(init?.body));
    let result: unknown;
    if (method === 'getMe') result = { id: 123456, is_bot: true, username: 'fixture_bot' };
    else if (method === 'sendMessage') {
      sent.push(body.text);
      result = { message_id: sent.length, chat: { id: body.chat_id } };
    } else {
      await delay(20, undefined, { signal: init?.signal ?? undefined });
      result = updates.splice(0);
    }
    return new Response(JSON.stringify({ ok: true, result }));
  };
  const app = await startServer({
    store,
    token: 'b'.repeat(64),
    telegramToken: '123456:fixture_token_for_test_only',
    telegramFetch,
    worktreeRoot: join(dir, 'worktrees'),
    providerFactory: () => ({
      listModels: async () => [],
      capabilities: async () => ({ tools: true, streaming: true }),
      async *generate() {
        generations++;
        yield { type: 'text_delta', text: 'agent response' };
        yield { type: 'finished', reason: 'stop' };
      },
    }),
  });
  cleanup.push(async () => {
    await app.close();
    if (dirname(resolve(dir)) !== resolve(tmpdir())) throw new Error('Unsafe fixture');
    await rm(dir, { recursive: true, force: true });
  });
  const call = (path: string, body?: unknown) =>
    fetch('http://127.0.0.1:' + app.port + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: 'Bearer ' + 'b'.repeat(64), 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(5000),
    });
  const created = await call(
    '/v1/commands',
    makeCommand({
      type: 'create_session',
      sessionId: crypto.randomUUID(),
      title: 'remote',
      mode: 'plan',
      config: { ...defaultModelConfig(), provider: 'demo', model: 'demo' },
    }),
  );
  const session = (await created.json()).session as Session;
  const configured = await call('/v1/telegram/config', {
    enabled: true,
    sessionId: session.id,
    allowBuild: false,
    transmissionConsent: true,
  });
  expect(configured.status).toBe(200);
  expect(await configured.text()).not.toContain('fixture_token');
  const pairing = await call('/v1/telegram/pair', {}).then((response) => response.json());
  const push = (id: number, text: string) =>
    updates.push({
      update_id: id,
      message: {
        date: Math.floor(Date.now() / 1000),
        text,
        from: { id: 111, is_bot: false, first_name: 'Owner' },
        chat: { id: 111, type: 'private' },
      },
    });
  push(1, '/pair ' + pairing.code);
  await expect
    .poll(
      async () =>
        (await call('/v1/telegram').then((response) => response.json())).candidate?.userId,
    )
    .toBe(111);
  expect((await call('/v1/telegram/approve', { userId: 222, chatId: 222 })).status).toBe(400);
  expect((await call('/v1/telegram').then((response) => response.json())).running).toBe(true);
  expect((await call('/v1/telegram/approve', { userId: 111, chatId: 111 })).status).toBe(200);
  push(2, '/ask hello');
  await expect.poll(async () => (await store.session(session.id)).run?.status).toBe('completed');
  expect(generations).toBe(1);
  await expect.poll(() => sent.some((text) => text.includes('agent response'))).toBe(true);
  const current = await store.session(session.id);
  expect(
    (
      await call(
        '/v1/sessions/delete',
        deleteSessionsSchema.parse({
          protocolVersion: 1,
          commandId: crypto.randomUUID(),
          actor: 'desktop',
          policyVersion: 1,
          type: 'delete_sessions',
          targets: [{ sessionId: current.id, expectedVersion: current.version }],
        }),
      )
    ).status,
  ).toBe(200);
  expect(await call('/v1/telegram').then((response) => response.json())).toMatchObject({
    running: false,
    config: { enabled: false, sessionId: null },
  });
  expect(await call('/v1/worktrees').then((response) => response.json())).toEqual({ records: [] });
});
