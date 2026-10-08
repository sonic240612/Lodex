import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  defaultModelConfig,
  makeCommand,
  commandSchema,
  deleteSessionsSchema,
  type ApprovalAction,
  type ElicitationAction,
  type Command,
} from '@lodex/contracts';
import { Store } from '@lodex/storage';
import { inspectSkillDirectory } from '@lodex/skills';
import { Telegram } from './telegram';
import { telegramChunks } from './telegram-output';

// Real per-chat delivery pacing is retained in tests, without contacting Telegram.
vi.setConfig({ expect: { poll: { timeout: 5000 } } });

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
    if (body.timeout === 0) return ok([]);
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
async function fixture(
  reconcileCosts?: (
    sessionId: string,
  ) => Promise<{ reconciled: number; remaining: number; withoutId: number }>,
) {
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
  const decideApproval = vi.fn((action: ApprovalAction) => store.decideApproval(action));
  const decideElicitation = vi.fn((action: ElicitationAction) => store.decideElicitation(action));
  const options = () => ({
    store,
    loadToken: async () => token,
    dispatch,
    decideApproval,
    decideElicitation,
    ...(reconcileCosts ? { reconcileCosts } : {}),
    fetch: bot.fetch,
  });
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
    dir,
    bot,
    session,
    dispatch,
    decideApproval,
    decideElicitation,
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
  it('forwards paired direct skill requests and preserves selections after restart', async () => {
    const app = await fixture();
    const root = join(app.dir, 'review');
    await mkdir(root);
    await writeFile(
      join(root, 'SKILL.md'),
      '---\nname: review\ndescription: Review selected files.\ndisable-model-invocation: true\n---\nReview $ARGUMENTS.\n',
    );
    const skill = await inspectSkillDirectory(root);
    await app.store.saveRegisteredSkill(skill);
    let current = await app.store.session(app.session.id);
    await app.store.apply(
      makeCommand({
        type: 'configure_skills',
        sessionId: current.id,
        expectedVersion: current.version,
        skills: [{ id: skill.id, revision: skill.revision }],
        skillCloudConsent: false,
      }),
    );
    await app.pair();
    await app.manager.configure({
      enabled: true,
      sessionId: current.id,
      allowBuild: true,
      transmissionConsent: true,
    });
    await app.reopen();
    app.bot.push([update(2, '/review source.ts')]);
    await expect.poll(() => app.dispatch.mock.calls.length).toBe(1);
    expect(app.dispatch.mock.calls[0]![0]).toMatchObject({
      type: 'send_message',
      content: '/review source.ts',
      mode: 'build',
      actor: 'telegram',
    });
    current = await app.store.session(current.id);
    await app.store.updateRun({
      sessionId: current.id,
      runId: current.run!.id,
      text: 'done',
      status: 'completed',
    });
    app.manager.wake();
    app.bot.push([update(3, '/plan /skill review inspect')]);
    await expect.poll(() => app.dispatch.mock.calls.length).toBe(2);
    expect(app.dispatch.mock.calls[1]![0]).toMatchObject({
      type: 'send_message',
      content: '/skill review inspect',
      mode: 'plan',
      actor: 'telegram',
    });
    app.bot.push([update(4, '/review while-running')]);
    await expect
      .poll(() => app.bot.sent.some((message) => message.text.includes('실행이 끝난 뒤')))
      .toBe(true);
    expect(app.dispatch).toHaveBeenCalledTimes(2);
  });

  it('delivers the complete final response in order without repeating the model request after restart', async () => {
    const app = await fixture();
    await app.pair();
    app.bot.push([update(2, '/plan investigate')]);
    await expect.poll(() => app.dispatch.mock.calls.length).toBe(1);
    const current = await app.store.session(app.session.id);
    const progress = '중간 조사 내용\n'.repeat(2000);
    const final = '완료한 최종 답변 🦔\n'.repeat(500) + token + '\n최종 결론';
    await app.store.updateRun({
      sessionId: current.id,
      runId: current.run!.id,
      text: progress + final,
      finalResponseOffset: progress.length,
      status: 'completed',
    });
    app.manager.wake();
    const expected = telegramChunks('[complete]\n' + final, token);
    await expect
      .poll(() => app.bot.sent.filter((message) => message.text.startsWith('[1/')).length)
      .toBe(1);
    await app.reopen();
    await expect
      .poll(() => app.bot.sent.filter((message) => /^\[\d+\/\d+\]/.test(message.text)).length, {
        timeout: 10000,
      })
      .toBe(expected.length);
    expect(
      app.bot.sent
        .filter((message) => /^\[\d+\/\d+\]/.test(message.text))
        .map((message) => message.text),
    ).toEqual(expected);
    expect(
      app.bot.sent.some(
        (message) => message.text.includes('중간 조사 내용') || message.text.includes(token),
      ),
    ).toBe(false);
    expect(app.dispatch).toHaveBeenCalledTimes(1);
    expect(JSON.stringify((await app.store.integration('telegram'))?.document)).not.toContain(
      token,
    );
  });

  it('keeps multipart delivery ordered through rate limits and skips uncertain parts after restart', async () => {
    const app = await fixture();
    await app.pair();
    await app.manager.close();
    const saved = (await app.store.integration('telegram'))!;
    const state = saved.document as any;
    const groupId = crypto.randomUUID();
    state.nextSendAt = 0;
    state.outbox = ['sending', 'queued', 'queued'].map((status, index) => ({
      id: crypto.randomUUID(),
      groupId,
      epoch: state.epoch,
      chatId: 100,
      sessionId: app.session.id,
      text: `part ${index + 1}`,
      status,
      retryAt: 0,
    }));
    await app.store.saveIntegration('telegram', saved.version, state);
    app.bot.failures = ['limited'];
    await app.reopen();
    await expect.poll(() => app.bot.sent.length).toBe(3);
    expect(app.bot.sent.map((message) => message.text)).toEqual(['part 2', 'part 2', 'part 3']);
    expect(app.manager.status().unknownDeliveries).toBe(1);
    expect(app.dispatch).not.toHaveBeenCalled();
  });

  it('queues paired remote instructions in the active run instead of starting another request', async () => {
    const app = await fixture();
    await app.pair();
    app.bot.push([update(2, '/plan first request')]);
    await expect.poll(() => app.dispatch.mock.calls.length).toBe(1);
    const first = await app.store.session(app.session.id);
    expect(first.mode).toBe('plan');
    app.bot.push([update(3, 'also check the output')]);
    await expect.poll(() => app.dispatch.mock.calls.length).toBe(2);
    expect(app.dispatch.mock.calls[1]![0]).toMatchObject({
      type: 'steer_run',
      actor: 'telegram',
      runId: first.run!.id,
      content: 'also check the output',
    });
    const queued = await app.store.session(app.session.id);
    expect(queued.run!.id).toBe(first.run!.id);
    expect(queued.mode).toBe('plan');
    expect(queued.messages.at(-1)!.runInput).toMatchObject({ actor: 'telegram', status: 'queued' });
    await expect
      .poll(() => app.bot.sent.some((message) => message.text.includes('추가 지시를 접수')))
      .toBe(true);
    expect(app.bot.sent.some((message) => message.text.includes('중지 요청'))).toBe(false);
  });
  it('lets only the paired account query costs without dispatching a new model request', async () => {
    const reconcile = vi.fn(async () => ({ reconciled: 1, remaining: 0, withoutId: 0 }));
    const app = await fixture(reconcile);
    await app.pair();
    app.bot.push([update(2, '/costs', 101), update(3, '/costs')]);
    await expect.poll(() => reconcile.mock.calls.length).toBe(1);
    await expect
      .poll(() => app.bot.sent.some((message) => message.text.includes('1개 정산')))
      .toBe(true);
    expect(app.dispatch).not.toHaveBeenCalled();
    app.bot.push([update(3, '/costs')]);
    await expect.poll(() => !!app.bot.waiting).toBe(true);
    expect(reconcile).toHaveBeenCalledTimes(1);
  });
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
      update(4, '/plan accepted'),
    ]);
    await expect.poll(() => app.dispatch.mock.calls.length).toBe(1);
    expect(app.dispatch.mock.calls[0]![0]).toMatchObject({
      actor: 'telegram',
      type: 'send_message',
      sessionId: app.session.id,
      content: 'accepted',
      mode: 'plan',
    });
    await expect.poll(() => app.bot.offsets.includes(5)).toBe(true);
    expect((await app.store.integration('telegram'))?.document).toMatchObject({ offset: 5 });
    app.bot.push([update(4, '/plan accepted')]);
    await expect.poll(() => app.bot.offsets.filter((id) => id === 5).length).toBeGreaterThan(1);
    expect(app.dispatch).toHaveBeenCalledTimes(1);
    const current = await app.store.session(app.session.id);
    await app.store.updateRun({
      sessionId: current.id,
      runId: current.run!.id,
      text: 'completed answer',
      status: 'completed',
    });
    app.manager.wake();
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
    // An old Plan session must not silently turn plain text into another Plan request.
    expect(app.session.mode).toBe('plan');
    app.bot.push([update(2, '/ask edit files'), update(3, '/autopilot')]);
    await expect.poll(() => app.bot.sent.length).toBe(1);
    expect(app.bot.sent[0]?.text).toContain('Build');
    expect(app.dispatch).not.toHaveBeenCalled();
    app.bot.push([]);
    await expect.poll(() => app.bot.sent.length).toBe(2);
    expect(app.bot.sent[1]?.text).toContain('지원하지 않는 명령');
  });

  it('treats Plan as an explicit request without latching it or changing an active run', async () => {
    const app = await fixture();
    await app.pair();
    app.bot.push([update(2, '/plan')]);
    await expect
      .poll(() => app.bot.sent.some((message) => message.text.includes('/plan 뒤에')))
      .toBe(true);
    expect(app.dispatch).not.toHaveBeenCalled();
    app.bot.push([update(3, '/plan Inspect the code')]);
    await expect.poll(() => app.dispatch.mock.calls.length).toBe(1);
    expect(app.dispatch.mock.calls[0]![0]).toMatchObject({
      type: 'send_message',
      mode: 'plan',
      content: 'Inspect the code',
    });
    const planned = await app.store.session(app.session.id);
    app.bot.push([update(4, '/plan Inspect something else'), update(5, '/build')]);
    await expect
      .poll(() => app.bot.sent.some((message) => message.text.includes('현재 실행이 끝난 뒤')))
      .toBe(true);
    app.bot.push([]);
    await expect
      .poll(() => app.bot.sent.some((message) => message.text.includes('지원하지 않는 명령')))
      .toBe(true);
    expect(app.dispatch).toHaveBeenCalledTimes(1);
    expect((await app.store.session(app.session.id)).mode).toBe('plan');
    await app.store.updateRun({
      sessionId: planned.id,
      runId: planned.run!.id,
      status: 'completed',
      text: 'Plan ready.',
    });
    await app.manager.configure({
      enabled: true,
      sessionId: planned.id,
      allowBuild: true,
      transmissionConsent: true,
    });
    app.bot.push([update(6, 'Implement the plan')]);
    await expect.poll(() => app.dispatch.mock.calls.length).toBe(2);
    expect(app.dispatch.mock.calls[1]![0]).toMatchObject({
      type: 'send_message',
      mode: 'build',
      content: 'Implement the plan',
    });
    expect((await app.store.session(app.session.id)).mode).toBe('build');
  });

  it('allows a paired account to run a Full Access conversation remotely', async () => {
    const app = await fixture();
    await app.pair();
    let session = (
      await app.store.apply(
        makeCommand({
          type: 'set_mode',
          sessionId: app.session.id,
          expectedVersion: app.session.version,
          mode: 'build',
        }),
      )
    ).session;
    session = (
      await app.store.apply(
        makeCommand({
          type: 'set_permission_mode',
          sessionId: session.id,
          expectedVersion: session.version,
          mode: 'full',
        }),
      )
    ).session;
    app.bot.push([update(2, '/ask inspect host')]);
    await expect.poll(() => app.dispatch.mock.calls.length).toBe(1);
    expect(app.dispatch.mock.calls[0]![0]).toMatchObject({
      actor: 'telegram',
      type: 'send_message',
      sessionId: session.id,
      content: 'inspect host',
    });
    expect((await app.store.session(session.id)).run?.actor).toBe('telegram');
  });

  it('edits goals and todos, changes approval mode, and starts a goal remotely', async () => {
    const app = await fixture();
    await app.pair();
    await app.manager.configure({
      enabled: true,
      sessionId: app.session.id,
      allowBuild: true,
      transmissionConsent: true,
    });
    app.bot.push([update(2, '/todo goal Release Lodex | All checks pass')]);
    await expect
      .poll(async () => (await app.store.session(app.session.id)).plan.goal)
      .toBe('Release Lodex');
    app.bot.push([update(3, '/todo add Run tests | npm test passes')]);
    await expect
      .poll(async () => (await app.store.session(app.session.id)).plan.tasks.length)
      .toBe(1);
    app.bot.push([update(4, '/todo done 1')]);
    await expect
      .poll(async () => (await app.store.session(app.session.id)).plan.tasks[0]?.done)
      .toBe(true);
    app.bot.push([update(5, '/autopilot auto')]);
    await expect
      .poll(async () => (await app.store.session(app.session.id)).permissionMode)
      .toBe('auto');
    app.bot.push([update(6, '/goal Verify the release')]);
    await expect
      .poll(async () => (await app.store.session(app.session.id)).run?.actor)
      .toBe('telegram');
    const session = await app.store.session(app.session.id);
    expect(session.mode).toBe('build');
    expect(session.autopilot).toMatchObject({
      goalDriven: true,
      status: 'running',
      plan: { goal: 'Verify the release' },
    });
    expect(app.dispatch.mock.calls.map(([command]) => command.type)).toEqual([
      'save_plan',
      'save_plan',
      'save_plan',
      'set_permission_mode',
      'start_goal',
    ]);
  });

  it.each(['command', 'verification'] as const)(
    'notifies and resolves a pending %s approval from the paired account',
    async (kind) => {
      const app = await fixture();
      await app.pair();
      await app.manager.configure({
        enabled: true,
        sessionId: app.session.id,
        allowBuild: kind === 'command',
        transmissionConsent: true,
      });
      let session = await app.store.session(app.session.id);
      const sent = await app.store.apply(
        makeCommand({
          type: 'send_message',
          sessionId: session.id,
          expectedVersion: session.version,
          content: '승인 테스트',
        }),
      );
      const activityId = crypto.randomUUID();
      await app.store.updateRun({
        sessionId: session.id,
        runId: sent.session.run!.id,
        activities: [
          {
            id: activityId,
            kind: 'tool',
            label: 'run_command',
            status: 'running',
            text: '',
            approval: {
              kind,
              target: 'npm test',
              actor: 'telegram',
              mode: 'ask',
              risk: 'low',
              reason: '프로젝트 명령 실행',
              status: 'pending',
              requestedAt: new Date().toISOString(),
            },
          },
        ],
      });
      app.manager.wake();
      await expect
        .poll(() => app.bot.sent.some((message) => message.text.includes('승인이 필요합니다.')))
        .toBe(true);
      app.bot.push([update(2, '/approve')]);
      await expect.poll(() => app.decideApproval.mock.calls.length).toBe(1);
      expect(app.decideApproval.mock.calls[0]![0]).toMatchObject({
        sessionId: session.id,
        activityId,
        action: 'approve',
      });
      await expect
        .poll(() => app.bot.sent.some((message) => message.text === '승인했습니다.'))
        .toBe(true);
      session = await app.store.session(session.id);
      expect(
        session.messages.flatMap((message) => message.activities ?? [])[0]?.approval,
      ).toMatchObject({ status: 'approved', decidedBy: 'user' });
    },
  );

  it('notifies and submits MCP elicitation JSON without persisting answer values', async () => {
    const app = await fixture();
    await app.pair();
    await app.manager.configure({
      enabled: true,
      sessionId: app.session.id,
      allowBuild: true,
      transmissionConsent: true,
    });
    const session = await app.store.session(app.session.id);
    const sent = await app.store.apply(
      makeCommand({
        type: 'send_message',
        sessionId: session.id,
        expectedVersion: session.version,
        content: '입력 테스트',
      }),
    );
    const activityId = crypto.randomUUID();
    await app.store.updateRun({
      sessionId: session.id,
      runId: sent.session.run!.id,
      activities: [
        {
          id: activityId,
          kind: 'tool',
          label: 'MCP 사용자 입력',
          status: 'running',
          text: '',
          elicitation: {
            source: 'fixture',
            mode: 'form',
            message: '프로젝트 이름을 입력하세요.',
            status: 'pending',
            requestedAt: new Date().toISOString(),
            fields: [{ name: 'name', type: 'string', title: '이름', required: true }],
          },
        },
      ],
    });
    app.manager.wake();
    await expect
      .poll(() =>
        app.bot.sent.some((message) => message.text.includes('MCP 사용자 입력이 필요합니다.')),
      )
      .toBe(true);
    app.bot.push([update(2, '/answer {"name":"private fixture"}')]);
    await expect.poll(() => app.decideElicitation.mock.calls.length).toBe(1);
    expect(app.decideElicitation.mock.calls[0]![0]).toMatchObject({
      activityId,
      action: 'accept',
      content: { name: 'private fixture' },
    });
    const recorded = await app.store.session(session.id);
    expect(JSON.stringify(recorded.messages.at(-1)?.activities)).not.toContain('private fixture');
    await expect
      .poll(async () => JSON.stringify((await app.store.integration('telegram'))?.document))
      .not.toContain('private fixture');
    expect(recorded.messages.at(-1)?.activities?.[0]?.elicitation?.status).toBe('accepted');
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
