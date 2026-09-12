import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  defaultModelConfig,
  makeCommand,
  commandSchema,
  deleteSessionsSchema,
  type Command,
} from '@lodex/contracts';
import { Store } from '@lodex/storage';
import { Telegram } from './telegram';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});
const token = '123456789:fixture_token_not_a_real_secret';
const ok = (result: unknown) =>
  new Response(JSON.stringify({ ok: true, result }), {
    headers: { 'Content-Type': 'application/json' },
  });
class Bot {
  offsets: number[] = [];
  sent: { chat_id: number; text: string }[] = [];
  failures: ('unknown' | 'limited')[] = [];
  pending: unknown[][] = [];
  waiting: ((updates: unknown[]) => void) | undefined;
  fetch: typeof fetch = async (input, init) => {
    const method = String(input).split('/').at(-1),
      body = JSON.parse(String(init?.body ?? '{}'));
    if (method === 'getMe') return ok({ id: 123456789, is_bot: true, username: 'fixture_bot' });
    if (method === 'sendMessage') {
      this.sent.push(body);
      const failure = this.failures.shift();
      if (failure === 'unknown') throw new Error('URL with secret ' + token);
      if (failure === 'limited')
        return new Response(JSON.stringify({ ok: false, parameters: { retry_after: 0.01 } }), {
          status: 429,
        });
      return ok({ message_id: this.sent.length, chat: { id: body.chat_id } });
    }
    if (method !== 'getUpdates') throw new Error('Unexpected bot method');
    this.offsets.push(body.offset);
    if (this.pending.length) return ok(this.pending.shift());
    return new Promise<Response>((resolve, reject) => {
      const finish = (updates: unknown[]) => {
        this.waiting = undefined;
        init?.signal?.removeEventListener('abort', abort);
        resolve(ok(updates));
      };
      const abort = () => {
        this.waiting = undefined;
        reject(new Error('cancelled'));
      };
      this.waiting = finish;
      init?.signal?.addEventListener('abort', abort, { once: true });
      if (init?.signal?.aborted) abort();
    });
  };
  push(updates: unknown[]) {
    if (this.waiting) this.waiting(updates);
    else this.pending.push(updates);
  }
}
const update = (
  id: number,
  text: string,
  userId = 100,
  overrides: Record<string, unknown> = {},
) => ({
  update_id: id,
  message: {
    date: Math.floor(Date.now() / 1000),
    text,
    from: { id: userId, is_bot: false, first_name: 'Fixture' },
    chat: { id: userId, type: 'private' },
    ...overrides,
  },
});
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'lodex-telegram-')),
    path = join(dir, 'state.sqlite'),
    bot = new Bot();
  let store = await Store.open(path, resolve('apps/daemon/dist/worker.cjs'));
  const session = (
    await store.apply(
      makeCommand({
        type: 'create_session',
        sessionId: crypto.randomUUID(),
        title: 'Scoped',
        mode: 'plan',
        config: { ...defaultModelConfig(), provider: 'demo', model: 'demo' },
      }),
    )
  ).session;
  const dispatch = vi.fn((command: Command) => store.apply(command));
  const options = () => ({ store, loadToken: async () => token, dispatch, fetch: bot.fetch });
  let manager = await Telegram.open(options());
  cleanup.push(async () => {
    await manager.close();
    await store.close();
    if (dirname(resolve(dir)) !== resolve(tmpdir())) throw new Error('Unsafe fixture');
    await rm(dir, { recursive: true, force: true });
  });
  const pair = async () => {
    await manager.configure({
      enabled: true,
      sessionId: session.id,
      allowBuild: false,
      transmissionConsent: true,
    });
    const pairing = await manager.pair();
    bot.push([update(1, '/pair ' + pairing.code)]);
    await expect.poll(() => manager.status().candidate?.userId).toBe(100);
    expect(manager.status().owner).toBeUndefined();
    await manager.approve(100, 100);
    await expect.poll(() => bot.sent.length).toBe(1);
    await expect.poll(() => !!bot.waiting).toBe(true);
    bot.sent = [];
  };
  return {
    bot,
    session,
    dispatch,
    pair,
    get manager() {
      return manager;
    },
    get store() {
      return store;
    },
    reopen: async () => {
      await manager.close();
      await store.close();
      store = await Store.open(path, resolve('apps/daemon/dist/worker.cjs'));
      manager = await Telegram.open(options());
    },
  };
}

describe('durable Telegram channel', () => {
  it('clears local queued channel copies when the connected conversation is deleted', async () => {
    const app = await fixture();
    await app.pair();
    await app.manager.withPaused(async () => {
      const saved = (await app.store.integration('telegram'))!;
      const state = saved.document as any;
      state.inbox = [
        {
          id: 2,
          epoch: state.epoch,
          sessionId: app.session.id,
          date: Math.floor(Date.now() / 1000),
          text: 'private queued text',
          status: 'queued',
        },
      ];
      state.outbox = [
        {
          id: crypto.randomUUID(),
          epoch: state.epoch,
          sessionId: app.session.id,
          chatId: 100,
          text: 'private answer',
          status: 'queued',
          retryAt: 0,
        },
      ];
      await app.store.saveIntegration('telegram', saved.version, state);
      await app.store.deleteSessions(
        deleteSessionsSchema.parse({
          protocolVersion: 1,
          commandId: crypto.randomUUID(),
          actor: 'desktop',
          policyVersion: 1,
          type: 'delete_sessions',
          targets: [{ sessionId: app.session.id, expectedVersion: app.session.version }],
        }),
      );
    });
    expect(app.manager.status()).toMatchObject({
      running: false,
      config: { enabled: false, sessionId: null },
    });
    const persisted = (await app.store.integration('telegram'))!.document;
    expect(JSON.stringify(persisted)).not.toContain('private queued text');
    expect(JSON.stringify(persisted)).not.toContain('private answer');
    expect(app.dispatch).not.toHaveBeenCalled();
  });
  it('requires local numeric-account approval, ignores other users/groups, and deduplicates accepted requests', async () => {
    const app = await fixture();
    await app.pair();
    app.bot.push([
      update(2, 'do not run', 101),
      update(3, 'group request', 100, { chat: { id: 100, type: 'group' } }),
      update(4, '/ask accepted'),
    ]);
    await expect.poll(() => app.dispatch.mock.calls.length).toBe(1);
    expect(app.dispatch.mock.calls[0]![0]).toMatchObject({
      actor: 'telegram',
      type: 'send_message',
      sessionId: app.session.id,
      content: 'accepted',
    });
    await expect.poll(() => app.bot.offsets.includes(5)).toBe(true);
    expect((await app.store.integration('telegram'))?.document).toMatchObject({ offset: 5 });
    app.bot.push([update(4, '/ask accepted')]);
    await expect.poll(() => app.bot.offsets.filter((id) => id === 5).length).toBeGreaterThan(1);
    expect(app.dispatch).toHaveBeenCalledTimes(1);
    const current = await app.store.session(app.session.id);
    await app.store.updateRun({
      sessionId: current.id,
      runId: current.run!.id,
      text: 'completed answer',
      status: 'completed',
    });
    app.bot.push([]);
    await expect
      .poll(() =>
        app.bot.sent.some((message) => message.text.includes('[complete]\ncompleted answer')),
      )
      .toBe(true);
    expect(app.bot.sent.every((message) => message.chat_id === 100)).toBe(true);
  });

  it('blocks Build requests until explicitly allowed and never executes unsupported commands', async () => {
    const app = await fixture();
    await app.pair();
    await app.store.apply(
      makeCommand({
        type: 'set_mode',
        sessionId: app.session.id,
        expectedVersion: app.session.version,
        mode: 'build',
      }),
    );
    app.bot.push([update(2, '/ask edit files'), update(3, '/autopilot')]);
    await expect.poll(() => app.bot.sent.length).toBe(1);
    expect(app.bot.sent[0]?.text).toContain('Build');
    expect(app.dispatch).not.toHaveBeenCalled();
    app.bot.push([]);
    await expect.poll(() => app.bot.sent.length).toBe(2);
    expect(app.bot.sent[1]?.text).toContain('지원하지 않는 명령');
  });

  it('records uncertain sends without replay and retries only an explicit rate-limit rejection', async () => {
    const app = await fixture();
    await app.pair();
    app.bot.failures = ['unknown'];
    app.bot.push([update(2, '/help')]);
    await expect.poll(() => app.manager.status().unknownDeliveries).toBe(1);
    const attempts = app.bot.sent.length;
    app.bot.push([]);
    await expect.poll(() => !!app.bot.waiting).toBe(true);
    expect(app.bot.sent.length).toBe(attempts);
    expect(app.manager.status().error ?? '').not.toContain(token);
    app.bot.failures = ['limited'];
    app.bot.push([update(3, '/plan')]);
    await expect.poll(() => app.bot.sent.length).toBe(attempts + 1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    app.bot.push([]);
    await expect.poll(() => app.bot.sent.length).toBe(attempts + 2);
    expect(app.manager.status().unknownDeliveries).toBe(1);
  });

  it('reconciles a persisted command receipt after restart without sending the model request twice', async () => {
    const app = await fixture();
    await app.pair();
    await app.manager.close();
    const command = commandSchema.parse({
      ...makeCommand({
        type: 'send_message',
        sessionId: app.session.id,
        expectedVersion: app.session.version,
        content: 'once',
      }),
      actor: 'telegram',
    });
    await app.store.apply(command);
    const saved = (await app.store.integration('telegram'))!;
    const state = saved.document as any;
    state.inbox = [
      {
        id: 2,
        epoch: state.epoch,
        date: Math.floor(Date.now() / 1000) - 600,
        text: 'once',
        status: 'prepared',
        command,
      },
    ];
    state.offset = 3;
    state.outbox = [
      {
        id: crypto.randomUUID(),
        epoch: state.epoch,
        chatId: 100,
        text: 'uncertain receipt',
        status: 'sending',
        retryAt: 0,
      },
    ];
    await app.store.saveIntegration('telegram', saved.version, state);
    await app.reopen();
    await expect.poll(() => app.dispatch.mock.calls.length).toBe(1);
    expect((await app.store.session(app.session.id)).messages).toHaveLength(2);
    expect((await app.store.session(app.session.id)).run?.status).toBe('interrupted');
    expect(app.manager.status().unknownDeliveries).toBe(1);
    expect(app.bot.sent.some((message) => message.text === 'uncertain receipt')).toBe(false);
  });

  it('does not dispatch a prepared but never executed request after its deadline', async () => {
    const app = await fixture();
    await app.pair();
    await app.manager.close();
    const saved = (await app.store.integration('telegram'))!;
    const state = saved.document as any;
    const command = makeCommand({
      type: 'send_message',
      sessionId: app.session.id,
      expectedVersion: app.session.version,
      content: 'expired',
    });
    state.inbox = [
      {
        id: 2,
        epoch: state.epoch,
        date: Math.floor(Date.now() / 1000) - 600,
        text: 'expired',
        status: 'prepared',
        command,
      },
    ];
    await app.store.saveIntegration('telegram', saved.version, state);
    await app.reopen();
    await expect
      .poll(() => app.bot.sent.some((message) => message.text.includes('만료')))
      .toBe(true);
    expect(app.dispatch).not.toHaveBeenCalled();
    expect((await app.store.session(app.session.id)).messages).toHaveLength(0);
  });

  it('revokes the peer and does not resume queued requests on reconnect', async () => {
    const app = await fixture();
    await app.pair();
    await app.manager.unpair();
    expect(app.manager.status()).toMatchObject({ running: false, config: { enabled: false } });
    expect(app.manager.status().owner).toBeUndefined();
    app.bot.push([update(2, '/ask old owner')]);
    await app.manager.configure({
      enabled: true,
      sessionId: app.session.id,
      allowBuild: false,
      transmissionConsent: true,
    });
    await expect.poll(() => app.bot.offsets.includes(3)).toBe(true);
    expect(app.dispatch).not.toHaveBeenCalled();
  });
});
