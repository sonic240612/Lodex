import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { get } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import {
  defaultModelConfig,
  defaultPlan,
  makeCommand,
  type Command,
  type CommandResult,
  type InferenceProvider,
  type InferenceRequest,
  type ModelConfig,
  type Session,
  type SecretSource,
  autopilotLimitsSchema,
  defaultExecutionConfig,
} from '@lodex/contracts';
import { decodeSse } from '@lodex/providers';
import { Store } from '@lodex/storage';
import { startServer } from './server';
import type { executeCommand } from '@lodex/tools';
const cleanup: (() => Promise<void>)[] = [];
const token = 'a'.repeat(64);
async function setup(
  provider?: InferenceProvider,
  secrets?: { openrouterKey: string; openrouterKeySource: SecretSource; envFilePath: string },
  commandExecutor?: typeof executeCommand,
) {
  const dir = await mkdtemp(join(tmpdir(), 'lodex-http-한글 '));
  const store = await Store.open(join(dir, 'test.sqlite'), resolve('apps/daemon/dist/worker.cjs'));
  const factory = vi.fn(() => provider!);
  const app = await startServer({
    token,
    store,
    ...secrets,
    ...(provider ? { providerFactory: factory } : {}),
    ...(commandExecutor ? { commandExecutor } : {}),
  });
  cleanup.push(async () => {
    await app.close();
    if (dirname(resolve(dir)) !== resolve(tmpdir())) throw new Error('Unsafe test directory');
    await rm(dir, { recursive: true, force: true });
  });
  const base = 'http://127.0.0.1:' + app.port;
  const request = (path: string, options: RequestInit = {}) =>
    fetch(base + path, {
      ...options,
      headers: {
        Authorization: 'Bearer ' + token,
        'Content-Type': 'application/json',
        ...options.headers,
      },
    });
  const command = (value: Command) =>
    request('/v1/commands', { method: 'POST', body: JSON.stringify(value) });
  async function create(
    config: Partial<ModelConfig> = {},
    projectId: string | null = null,
  ): Promise<Session> {
    const response = await command(
      makeCommand({
        type: 'create_session',
        sessionId: crypto.randomUUID(),
        title: '통합 테스트',
        config: { ...defaultModelConfig(), provider: 'demo', model: 'demo', ...config },
        projectId,
      }),
    );
    expect(response.status).toBe(200);
    return ((await response.json()) as CommandResult).session;
  }
  return { base, store, request, command, create, factory, dir };
}
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});
describe('authenticated daemon integration', () => {
  it.each(['pass', 'fail', 'budget', 'no_progress'] as const)(
    'runs a bounded local Autopilot and persists %s distinctly',
    async (outcome) => {
      let taskId = '',
        round = 0,
        executions = 0;
      const provider: InferenceProvider = {
        listModels: async () => [],
        capabilities: async () => ({ tools: true, streaming: true }),
        async *generate(request) {
          expect(request.tools?.some((t) => t.function.name === 'verify_task')).toBe(true);
          if (outcome === 'no_progress') {
            yield { type: 'text_delta', text: 'I am done.' };
            yield { type: 'finished', reason: 'stop' };
            return;
          }
          const name = outcome === 'pass' && round > 0 ? 'verify_goal' : 'verify_task';
          yield {
            type: 'tool_call_delta',
            index: 0,
            id: 'v-' + round++,
            name,
            arguments: name === 'verify_task' ? JSON.stringify({ taskId }) : '{}',
          };
          if (name === 'verify_goal')
            yield {
              type: 'tool_call_delta',
              index: 1,
              id: 'after-goal',
              name: 'run_command',
              arguments: '{"command":"must not run"}',
            };
          yield { type: 'finished', reason: 'tool_calls' };
        },
      };
      const executor: typeof executeCommand = async (options) => {
        executions++;
        const id = crypto.randomUUID(),
          command = JSON.parse(options.argumentsJson).command as string;
        expect(command).toBe('npm test');
        const execution = {
          id,
          containerName: 'lodex-' + id,
          command,
          cwd: '.',
          status: (outcome === 'fail' ? 'failed' : 'completed') as 'failed' | 'completed',
          startedAt: '',
          exitCode: outcome === 'fail' ? 1 : 0,
          output: outcome === 'fail' ? 'regression failed' : 'fixture check passed',
          truncated: false,
          cleanupPending: false,
        };
        await options.record(execution);
        return execution;
      };
      const app = await setup(provider, undefined, executor);
      const { project } = await app
        .request('/v1/projects', { method: 'POST', body: JSON.stringify({ path: app.dir }) })
        .then((r) => r.json());
      let session = await app.create(
        { provider: 'llama-server', model: 'fixture', contextBudgetTokens: 65536 },
        project.id,
      );
      taskId = crypto.randomUUID();
      session = (
        await app
          .command(
            makeCommand({
              type: 'save_plan',
              sessionId: session.id,
              expectedVersion: session.version,
              plan: {
                ...defaultPlan(),
                goal: 'Regression',
                criteria: 'Check passes',
                verificationCommand: 'npm test',
                includeInContext: true,
                tasks: [
                  {
                    id: taskId,
                    title: 'Fix',
                    criteria: 'Check passes',
                    verificationCommand: 'npm test',
                    done: false,
                  },
                ],
              },
            }),
          )
          .then((r) => r.json())
      ).session;
      session = (
        await app
          .command(
            makeCommand({
              type: 'configure_execution',
              sessionId: session.id,
              expectedVersion: session.version,
              execution: { ...defaultExecutionConfig(), backend: 'docker', projectAccess: true },
            }),
          )
          .then((r) => r.json())
      ).session;
      const response = await app.command(
        makeCommand({
          type: 'start_autopilot',
          sessionId: session.id,
          expectedVersion: session.version,
          taskIds: [],
          limits: autopilotLimitsSchema.parse({ modelCalls: outcome === 'budget' ? 1 : 6 }),
        }),
      );
      expect(response.status).toBe(200);
      await vi.waitFor(async () =>
        expect((await app.store.session(session.id)).run?.status).not.toBe('running'),
      );
      session = await app.store.session(session.id);
      expect(session.autopilot?.status).toBe(outcome === 'pass' ? 'completed' : 'paused');
      expect(session.plan.tasks[0]!.done).toBe(false);
      expect(session.autopilot?.modelCalls).toBe(
        outcome === 'budget' ? 1 : outcome === 'fail' ? 3 : 2,
      );
      expect(executions).toBe(
        outcome === 'no_progress' ? 0 : outcome === 'fail' ? 3 : outcome === 'budget' ? 1 : 2,
      );
      if (outcome === 'pass') expect(session.autopilot?.evidence).toHaveLength(2);
      else expect(session.autopilot?.reason).toBeTruthy();
    },
  );
  it('offers read-only Plan tools, reviews a plan, and adopts it without executing tasks', async () => {
    let round = 0;
    const provider: InferenceProvider = {
      listModels: async () => [],
      capabilities: async () => ({ tools: true, streaming: true }),
      async *generate(request) {
        expect(request.tools?.map((t) => t.function.name)).toEqual(['propose_plan']);
        if (round++ === 0) {
          yield {
            type: 'tool_call_delta',
            index: 0,
            id: 'p',
            name: 'propose_plan',
            arguments: JSON.stringify({
              goal: 'Release',
              criteria: 'Checks pass',
              tasks: [{ key: 'test', title: 'Test', criteria: 'Pass', dependsOn: [] }],
            }),
          };
          yield { type: 'finished', reason: 'tool_calls' };
        } else {
          yield { type: 'text_delta', text: 'Review the plan.' };
          yield { type: 'finished', reason: 'stop' };
        }
      },
    };
    const app = await setup(provider);
    let session = await app.create();
    session = (
      await app
        .command(
          makeCommand({
            type: 'set_mode',
            sessionId: session.id,
            expectedVersion: session.version,
            mode: 'plan',
          }),
        )
        .then((r) => r.json())
    ).session;
    await app.command(
      makeCommand({
        type: 'send_message',
        sessionId: session.id,
        expectedVersion: session.version,
        content: 'Plan release',
      }),
    );
    await vi.waitFor(async () =>
      expect((await app.store.session(session.id)).run?.status).toBe('completed'),
    );
    session = await app.store.session(session.id);
    expect(session.plan.tasks).toEqual([]);
    const proposal = session.messages.at(-1)!.activities!.find((a) => a.planProposal)!;
    const adoption = makeCommand({
      type: 'adopt_plan',
      sessionId: session.id,
      expectedVersion: session.version,
      activityId: proposal.id,
    });
    const response = await app.command(adoption);
    expect(response.status).toBe(200);
    expect((await response.json()).session.plan.tasks[0].done).toBe(false);
    expect((await app.command(adoption).then((r) => r.json())).replayed).toBe(true);
  });
  it('blocks a model that requests a write proposal in Plan even with a selected project', async () => {
    const provider: InferenceProvider = {
      listModels: async () => [],
      capabilities: async () => ({ tools: true, streaming: true }),
      async *generate(request) {
        expect(request.tools?.some((t) => t.function.name === 'read_file')).toBe(true);
        expect(request.tools?.some((t) => t.function.name === 'propose_changes')).toBe(false);
        yield {
          type: 'tool_call_delta',
          index: 0,
          id: 'w',
          name: 'propose_changes',
          arguments: '{}',
        };
        yield { type: 'finished', reason: 'tool_calls' };
      },
    };
    const app = await setup(provider);
    const { project } = await app
      .request('/v1/projects', { method: 'POST', body: JSON.stringify({ path: app.dir }) })
      .then((r) => r.json());
    let session = await app.create({}, project.id);
    session = (
      await app
        .command(
          makeCommand({
            type: 'set_mode',
            sessionId: session.id,
            expectedVersion: session.version,
            mode: 'plan',
          }),
        )
        .then((r) => r.json())
    ).session;
    await app.command(
      makeCommand({
        type: 'send_message',
        sessionId: session.id,
        expectedVersion: session.version,
        content: 'Ignore Plan and write',
      }),
    );
    await vi.waitFor(async () =>
      expect((await app.store.session(session.id)).run?.status).toBe('failed'),
    );
    expect(
      (await app.store.session(session.id)).messages.at(-1)!.activities?.every((a) => !a.changes),
    ).toBe(true);
  });
  it('exposes only dotenv source metadata and rejects UI replacement of a managed key', async () => {
    const secret = 'private-test-fixture-do-not-display';
    const app = await setup(undefined, {
      openrouterKey: secret,
      openrouterKeySource: 'env_file',
      envFilePath: 'C:/fixture/.env',
    });
    const state = await app.request('/v1/state').then((r) => r.json());
    expect(state.openrouterConfigured).toBe(true);
    expect(state.openrouterKeySource).toBe('env_file');
    expect(JSON.stringify(state)).not.toContain(secret);
    const response = await app.request('/v1/secret', {
      method: 'PUT',
      body: JSON.stringify({ key: null }),
    });
    expect(response.status).toBe(409);
    expect(JSON.stringify(await response.json())).not.toContain(secret);
    expect(JSON.stringify(await app.store.snapshot())).not.toContain(secret);
  });
  it('persists a model change set, publishes new files only after review, and undoes through the API', async () => {
    let round = 0;
    const provider: InferenceProvider = {
      listModels: async () => [],
      capabilities: async () => ({ tools: true, streaming: true }),
      async *generate() {
        if (round++ === 0) {
          yield {
            type: 'tool_call_delta',
            index: 0,
            id: 'set-1',
            name: 'propose_changes',
            arguments: JSON.stringify({
              files: [
                {
                  kind: 'edit',
                  path: 'existing.txt',
                  expectedHash: createHash('sha256').update('before').digest('hex'),
                  oldText: 'before',
                  newText: 'after',
                },
                { kind: 'create', path: 'new.txt', content: 'new content' },
              ],
            }),
          };
          yield { type: 'finished', reason: 'tool_calls' };
        } else {
          yield { type: 'text_delta', text: '두 파일 변경을 검토해 주세요.' };
          yield { type: 'finished', reason: 'stop' };
        }
      },
    };
    const app = await setup(provider);
    await writeFile(join(app.dir, 'existing.txt'), 'before');
    const { project } = await app
      .request('/v1/projects', { method: 'POST', body: JSON.stringify({ path: app.dir }) })
      .then((r) => r.json());
    const created = await app.create({}, project.id);
    await app.command(
      makeCommand({
        type: 'send_message',
        sessionId: created.id,
        expectedVersion: created.version,
        content: 'change both',
      }),
    );
    await vi.waitFor(async () =>
      expect((await app.store.session(created.id)).run?.status).toBe('completed'),
    );
    let session = await app.store.session(created.id);
    const card = session.messages.at(-1)!.activities!.find((a) => a.changes)!;
    expect(card.changes?.files).toHaveLength(2);
    expect(card.changes?.status).toBe('proposed');
    await expect(readFile(join(app.dir, 'new.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    const act = async (action: 'apply' | 'undo' | 'check') => {
      const response = await app.request('/v1/edits', {
        method: 'POST',
        body: JSON.stringify({
          sessionId: session.id,
          expectedVersion: session.version,
          activityId: card.id,
          action,
        }),
      });
      expect(response.status).toBe(200);
      session = (await response.json()).session;
      return session.messages.at(-1)!.activities!.find((a) => a.id === card.id)!.changes!;
    };
    const applied = await act('apply');
    expect(applied.status).toBe('applied');
    expect(applied.files[1]).toHaveProperty('identity');
    expect(await readFile(join(app.dir, 'new.txt'), 'utf8')).toBe('new content');
    await writeFile(join(app.dir, 'new.txt'), 'user work');
    expect((await act('undo')).status).toBe('conflict');
    expect(await readFile(join(app.dir, 'existing.txt'), 'utf8')).toBe('after');
    expect(await readFile(join(app.dir, 'new.txt'), 'utf8')).toBe('user work');
    await writeFile(join(app.dir, 'new.txt'), 'new content');
    expect((await act('check')).status).toBe('applied');
    expect((await act('undo')).status).toBe('reverted');
    expect(await readFile(join(app.dir, 'existing.txt'), 'utf8')).toBe('before');
    await expect(readFile(join(app.dir, 'new.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('persists a Tailscale URL and returns an actionable error for wildcard client addresses', async () => {
    const app = await setup();
    const session = await app.create({
      provider: 'llama-server',
      model: 'fixture',
      baseUrl: 'http://100.75.2.3:8080',
    });
    expect((await app.store.session(session.id)).config.baseUrl).toBe('http://100.75.2.3:8080/v1');
    const response = await app.request(
      '/v1/models?' +
        new URLSearchParams({ provider: 'llama-server', baseUrl: 'http://0.0.0.0:8080' }),
    );
    expect(response.status).toBe(400);
    expect((await response.json()).error.message).toContain('수신 주소');
  });
  it('deletes selected sessions through the authenticated API and replays the deletion receipt', async () => {
    const app = await setup();
    const a = await app.create(),
      b = await app.create();
    const body = JSON.stringify({
      protocolVersion: 1,
      commandId: crypto.randomUUID(),
      actor: 'desktop',
      policyVersion: 1,
      type: 'delete_sessions',
      targets: [a, b].map((s) => ({ sessionId: s.id, expectedVersion: s.version })),
    });
    expect((await app.request('/v1/sessions/delete', { method: 'POST', body })).status).toBe(200);
    expect(
      (await app.request('/v1/sessions/delete', { method: 'POST', body }).then((r) => r.json()))
        .replayed,
    ).toBe(true);
    expect((await app.request('/v1/state').then((r) => r.json())).sessions).toEqual([]);
  });
  it('keeps a model edit as a proposal until UI apply, checks conflicts and does not reapply retries', async () => {
    const before = 'const value = 1;\n';
    let round = 0;
    const provider: InferenceProvider = {
      listModels: async () => [],
      capabilities: async () => ({ tools: true, streaming: true }),
      async *generate() {
        if (round++ === 0) {
          yield {
            type: 'tool_call_delta',
            index: 0,
            id: 'proposal-1',
            name: 'propose_edit',
            arguments: JSON.stringify({
              path: 'edit.ts',
              expectedHash: createHash('sha256').update(before).digest('hex'),
              oldText: 'value = 1',
              newText: 'value = 2',
            }),
          };
          yield { type: 'finished', reason: 'tool_calls' };
        } else {
          yield { type: 'text_delta', text: '수정안을 확인해 주세요.' };
          yield { type: 'finished', reason: 'stop' };
        }
      },
    };
    const app = await setup(provider);
    const file = join(app.dir, 'edit.ts');
    await writeFile(file, before);
    const { project } = await app
      .request('/v1/projects', { method: 'POST', body: JSON.stringify({ path: app.dir }) })
      .then((r) => r.json());
    const session = await app.create({}, project.id);
    await app.command(
      makeCommand({
        type: 'send_message',
        sessionId: session.id,
        expectedVersion: session.version,
        content: '수정 제안',
      }),
    );
    await vi.waitFor(async () =>
      expect((await app.store.session(session.id)).run?.status).toBe('completed'),
    );
    const proposed = await app.store.session(session.id);
    const card = proposed.messages.at(-1)!.activities!.find((a) => a.edit)!;
    expect(card.edit!.status).toBe('proposed');
    expect(await readFile(file, 'utf8')).toBe(before);
    const body = JSON.stringify({
      sessionId: session.id,
      expectedVersion: proposed.version,
      activityId: card.id,
      action: 'apply',
    });
    const applied = await app.request('/v1/edits', { method: 'POST', body }).then((r) => r.json());
    expect(
      applied.session.messages.at(-1).activities.find((a: { id: string }) => a.id === card.id).edit
        .status,
    ).toBe('applied');
    expect(await readFile(file, 'utf8')).toBe('const value = 2;\n');
    await writeFile(file, 'user edit');
    expect((await app.request('/v1/edits', { method: 'POST', body })).status).toBe(200);
    expect(await readFile(file, 'utf8')).toBe('user edit');
    const checked = await app
      .request('/v1/edits', {
        method: 'POST',
        body: JSON.stringify({
          sessionId: session.id,
          expectedVersion: applied.session.version,
          activityId: card.id,
          action: 'check',
        }),
      })
      .then((r) => r.json());
    expect(
      checked.session.messages.at(-1).activities.find((a: { id: string }) => a.id === card.id).edit
        .status,
    ).toBe('conflict');
    // Restore the applied bytes, reconcile, then undo through the same UI API.
    await writeFile(file, 'const value = 2;\n');
    const ready = await app
      .request('/v1/edits', {
        method: 'POST',
        body: JSON.stringify({
          sessionId: session.id,
          expectedVersion: checked.session.version,
          activityId: card.id,
          action: 'check',
        }),
      })
      .then((r) => r.json());
    const undoBody = JSON.stringify({
      sessionId: session.id,
      expectedVersion: ready.session.version,
      activityId: card.id,
      action: 'undo',
    });
    const undone = await app
      .request('/v1/edits', { method: 'POST', body: undoBody })
      .then((r) => r.json());
    expect(
      undone.session.messages.at(-1).activities.find((a: { id: string }) => a.id === card.id).edit
        .status,
    ).toBe('reverted');
    expect(await readFile(file, 'utf8')).toBe(before);
    await writeFile(file, 'new user edit after undo');
    expect((await app.request('/v1/edits', { method: 'POST', body: undoBody })).status).toBe(200);
    expect(await readFile(file, 'utf8')).toBe('new user edit after undo');
  });
  it('registers a project and completes a real file tool round-trip with durable activities', async () => {
    const requests: InferenceRequest[] = [];
    const provider: InferenceProvider = {
      listModels: async () => [],
      capabilities: async () => ({ tools: true, streaming: true }),
      async *generate(request) {
        requests.push(structuredClone(request));
        if (requests.length === 1) {
          yield {
            type: 'provider_state_delta',
            provider: 'demo',
            model: 'demo',
            data: [{ index: 0, type: 'reasoning.encrypted', data: 'opaque-' }],
          };
          yield {
            type: 'provider_state_delta',
            provider: 'demo',
            model: 'demo',
            data: [{ index: 0, type: 'reasoning.encrypted', data: 'fixture' }],
          };
          yield { type: 'reasoning_delta', text: '파일을 먼저 확인합니다.' };
          yield {
            type: 'tool_call_delta',
            index: 0,
            id: 'read-1',
            name: 'read_file',
            arguments: '{"pa',
          };
          yield { type: 'tool_call_delta', index: 0, arguments: 'th":"hello.txt"}' };
          yield { type: 'usage', usage: { inputTokens: 11, outputTokens: 5 } };
          yield { type: 'finished', reason: 'tool_calls' };
        } else {
          yield { type: 'text_delta', text: '확인한 파일: 안녕 프로젝트' };
          yield { type: 'usage', usage: { inputTokens: 17, outputTokens: 7 } };
          yield { type: 'finished', reason: 'stop' };
        }
      },
    };
    const app = await setup(provider);
    const path = join(app.dir, '프로젝트');
    await mkdir(path);
    await writeFile(join(path, 'hello.txt'), '안녕 프로젝트');
    const register = () =>
      app
        .request('/v1/projects', { method: 'POST', body: JSON.stringify({ path }) })
        .then((r) => r.json());
    const { project } = await register();
    expect((await register()).project.id).toBe(project.id);
    expect((await app.store.snapshot()).projects).toHaveLength(1);
    const session = await app.create({}, project.id);
    expect(session.projectId).toBe(project.id);
    await app.command(
      makeCommand({
        type: 'send_message',
        sessionId: session.id,
        expectedVersion: session.version,
        content: '파일을 읽어 줘',
      }),
    );
    await vi.waitFor(async () =>
      expect((await app.store.session(session.id)).run?.status).toBe('completed'),
    );
    const final = await app.store.session(session.id),
      message = final.messages.at(-1)!;
    expect(requests).toHaveLength(2);
    expect(requests[0]!.tools?.map((tool) => tool.function.name)).toEqual([
      'propose_changes',
      'propose_edit',
      'list_files',
      'read_file',
      'search_text',
      'propose_plan',
    ]);
    expect(requests[1]!.messages.at(-1)).toMatchObject({ role: 'tool', toolCallId: 'read-1' });
    expect(requests[1]!.messages.at(-1)?.content).toContain('안녕 프로젝트');
    expect(requests[1]!.messages.at(-2)?.reasoningDetails).toEqual([
      { index: 0, type: 'reasoning.encrypted', data: 'opaque-fixture' },
    ]);
    expect(JSON.stringify(message.activities)).not.toContain('opaque-fixture');
    expect(message.activities?.map((a) => [a.kind, a.status])).toEqual([
      ['thinking', 'completed'],
      ['tool', 'completed'],
    ]);
    expect(message.usage).toMatchObject({ inputTokens: 28, outputTokens: 12 });
    expect(message.continuation?.map((m) => m.role)).toEqual(['assistant', 'tool', 'assistant']);
    await app.command(
      makeCommand({
        type: 'send_message',
        sessionId: final.id,
        expectedVersion: final.version,
        content: '이어서 설명',
      }),
    );
    await vi.waitFor(() => expect(requests).toHaveLength(3));
    expect(requests[2]!.messages.some((m) => m.toolCallId === 'read-1')).toBe(true);
  });
  it.each([false, true])(
    'gates project file transmission separately from chat consent (%s)',
    async (consent) => {
      let captured: InferenceRequest | undefined;
      const provider: InferenceProvider = {
        listModels: async () => [],
        capabilities: async () => ({ tools: true, streaming: true }),
        async *generate(request) {
          captured = request;
          yield { type: 'finished', reason: 'stop' };
        },
      };
      const app = await setup(provider);
      const { project } = await app
        .request('/v1/projects', { method: 'POST', body: JSON.stringify({ path: app.dir }) })
        .then((r) => r.json());
      await app.request('/v1/secret', { method: 'PUT', body: JSON.stringify({ key: 'fixture' }) });
      const session = await app.create(
        {
          provider: 'openrouter',
          model: 'fixture',
          cloudConsent: true,
          projectCloudConsent: consent,
        },
        project.id,
      );
      await app.command(
        makeCommand({
          type: 'send_message',
          sessionId: session.id,
          expectedVersion: session.version,
          content: 'hello',
        }),
      );
      await vi.waitFor(() => expect(captured).toBeDefined());
      expect(!!captured!.tools?.some((tool) => tool.function.name === 'read_file')).toBe(consent);
      expect(JSON.stringify(captured)).not.toContain(app.dir);
    },
  );
  it('does not execute tool deltas from an interrupted provider stream', async () => {
    let calls = 0;
    const provider: InferenceProvider = {
      listModels: async () => [],
      capabilities: async () => ({ tools: true, streaming: true }),
      async *generate() {
        calls++;
        yield {
          type: 'tool_call_delta',
          index: 0,
          id: 'partial',
          name: 'read_file',
          arguments: '{"path":"hello.txt"}',
        };
      },
    };
    const app = await setup(provider);
    const { project } = await app
      .request('/v1/projects', { method: 'POST', body: JSON.stringify({ path: app.dir }) })
      .then((r) => r.json());
    const session = await app.create({}, project.id);
    await app.command(
      makeCommand({
        type: 'send_message',
        sessionId: session.id,
        expectedVersion: session.version,
        content: 'hello',
      }),
    );
    await vi.waitFor(async () =>
      expect((await app.store.session(session.id)).run?.status).toBe('failed'),
    );
    const message = (await app.store.session(session.id)).messages.at(-1)!;
    expect(calls).toBe(1);
    expect(message.activities?.[0]).toMatchObject({ status: 'failed', text: '' });
    expect(message.continuation ?? []).toHaveLength(0);
  });
  it('stops a non-terminating tool loop at its model call limit', async () => {
    let calls = 0;
    const provider: InferenceProvider = {
      listModels: async () => [],
      capabilities: async () => ({ tools: true, streaming: true }),
      async *generate() {
        calls++;
        yield {
          type: 'tool_call_delta',
          index: 0,
          id: 'call-' + calls,
          name: 'list_files',
          arguments: '{}',
        };
        yield { type: 'finished', reason: 'tool_calls' };
      },
    };
    const app = await setup(provider);
    const { project } = await app
      .request('/v1/projects', { method: 'POST', body: JSON.stringify({ path: app.dir }) })
      .then((r) => r.json());
    const session = await app.create({}, project.id);
    await app.command(
      makeCommand({
        type: 'send_message',
        sessionId: session.id,
        expectedVersion: session.version,
        content: 'loop',
      }),
    );
    await vi.waitFor(async () =>
      expect((await app.store.session(session.id)).run?.status).toBe('failed'),
    );
    expect(calls).toBe(6);
    const message = (await app.store.session(session.id)).messages.at(-1)!;
    expect(message.error).toContain('실행 한도');
    expect(message.activities?.filter((a) => a.status === 'completed')).toHaveLength(5);
  });
  it('rejects a context overflow before storing messages or invoking the provider', async () => {
    const app = await setup();
    const session = await app.create({ contextBudgetTokens: 2048, maxTokens: 1024 });
    const before = await app.store.snapshot();
    const result = await app.command(
      makeCommand({
        type: 'send_message',
        sessionId: session.id,
        expectedVersion: session.version,
        content: 'x'.repeat(1500),
      }),
    );
    expect(result.status).toBe(400);
    expect((await result.json()).error.code).toBe('CONTEXT_BUDGET');
    expect(await app.store.snapshot()).toEqual(before);
  });
  it('persists the compiled input manifest and pins the plan revision during generation', async () => {
    let captured: InferenceRequest | undefined;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const provider: InferenceProvider = {
      listModels: async () => [],
      capabilities: async () => ({ tools: false, streaming: true }),
      async *generate(request) {
        captured = request;
        await gate;
        yield { type: 'finished', reason: 'stop' };
      },
    };
    const app = await setup(provider);
    let session = await app.create();
    session = (
      (await app
        .command(
          makeCommand({
            type: 'save_plan',
            sessionId: session.id,
            expectedVersion: session.version,
            plan: {
              ...defaultPlan(),
              includeInContext: true,
              goal: 'ORIGINAL_GOAL',
              instructions: 'PINNED_RULE',
              tasks: [{ id: crypto.randomUUID(), title: 'test', done: false }],
            },
          }),
        )
        .then((r) => r.json())) as CommandResult
    ).session;
    try {
      const response = await app.command(
        makeCommand({
          type: 'send_message',
          sessionId: session.id,
          expectedVersion: session.version,
          content: 'next',
        }),
      );
      const sent = (await response.json()) as CommandResult;
      await vi.waitFor(() => expect(captured).toBeDefined());
      expect(captured!.messages.at(-1)?.content).toContain('ORIGINAL_GOAL');
      expect(sent.session.run?.context?.sourceSessionVersion).toBe(session.version);
      expect(sent.session.run?.context?.requestSha256).toMatch(/^[a-f0-9]{64}$/);
      const current = await app.store.session(session.id);
      expect(
        (
          await app.command(
            makeCommand({
              type: 'save_plan',
              sessionId: session.id,
              expectedVersion: current.version,
              plan: { ...current.plan, goal: 'LATER_GOAL' },
            }),
          )
        ).status,
      ).toBe(200);
      expect(JSON.stringify(captured)).not.toContain('LATER_GOAL');
      release();
      await vi.waitFor(async () =>
        expect((await app.store.session(session.id)).run?.status).toBe('completed'),
      );
      const final = await app.store.session(session.id);
      expect(final.plan.goal).toBe('LATER_GOAL');
      expect(final.plan.tasks[0]?.done).toBe(false);
      expect(final.run?.context).toEqual(sent.session.run?.context);
      expect(
        (await app.store.events(0)).some(
          (e) => e.type === 'session_changed' && e.session.run?.context?.planIncluded,
        ),
      ).toBe(true);
    } finally {
      release();
    }
  });
  it('requires plan opt-in independently of OpenRouter conversation consent', async () => {
    let captured: InferenceRequest | undefined;
    const provider: InferenceProvider = {
      listModels: async () => [],
      capabilities: async () => ({ tools: false, streaming: true }),
      async *generate(request) {
        captured = request;
        yield { type: 'finished', reason: 'stop' };
      },
    };
    const app = await setup(provider);
    await app.request('/v1/secret', {
      method: 'PUT',
      body: JSON.stringify({ key: 'fixture-only' }),
    });
    let session = await app.create({
      provider: 'openrouter',
      model: 'fixture',
      cloudConsent: true,
    });
    session = (
      (await app
        .command(
          makeCommand({
            type: 'save_plan',
            sessionId: session.id,
            expectedVersion: session.version,
            plan: { ...defaultPlan(), goal: 'PRIVATE_GOAL' },
          }),
        )
        .then((r) => r.json())) as CommandResult
    ).session;
    expect(
      (
        await app.command(
          makeCommand({
            type: 'send_message',
            sessionId: session.id,
            expectedVersion: session.version,
            content: 'hello',
          }),
        )
      ).status,
    ).toBe(200);
    await vi.waitFor(() => expect(captured).toBeDefined());
    expect(JSON.stringify(captured)).not.toContain('PRIVATE_GOAL');
  });
  it('rejects unauthenticated clients, browser origins and DNS-rebinding hosts', async () => {
    const app = await setup();
    expect((await fetch(app.base + '/v1/state')).status).toBe(401);
    expect(
      (await app.request('/v1/state', { headers: { Origin: 'https://example.com' } })).status,
    ).toBe(403);
    const hostStatus = await new Promise<number | undefined>((resolve, reject) => {
      get(
        app.base + '/v1/state',
        { headers: { Authorization: 'Bearer ' + token, Host: 'evil.example' } },
        (response) => {
          response.resume();
          resolve(response.statusCode);
        },
      ).on('error', reject);
    });
    expect(hostStatus).toBe(403);
    expect((await app.request('/v1/state')).status).toBe(200);
  });
  it('rejects malformed commands and does not persist credentials', async () => {
    const app = await setup();
    const response = await app.request('/v1/commands', {
      method: 'POST',
      body: JSON.stringify({ type: 'exec', command: 'anything' }),
    });
    expect(response.status).toBe(400);
    await app.request('/v1/secret', {
      method: 'PUT',
      body: JSON.stringify({ key: 'test-private-key' }),
    });
    const state = await app.request('/v1/state').then((r) => r.text());
    expect(state).toContain('"openrouterConfigured":true');
    expect(state).not.toContain('test-private-key');
    expect(JSON.stringify(await app.store.snapshot())).not.toContain('test-private-key');
  });
  it('requires cloud consent before invoking any provider or adding messages', async () => {
    const provider: InferenceProvider = {
      listModels: async () => [],
      capabilities: async () => ({ tools: false, streaming: true }),
      async *generate() {
        yield { type: 'finished', reason: 'stop' };
      },
    };
    const app = await setup(provider);
    const session = await app.create({
      provider: 'openrouter',
      model: 'fixture/model',
      cloudConsent: false,
    });
    const result = await app.command(
      makeCommand({
        type: 'send_message',
        sessionId: session.id,
        expectedVersion: session.version,
        content: 'private',
      }),
    );
    expect(result.status).toBe(403);
    expect(app.factory).not.toHaveBeenCalled();
    expect((await app.store.session(session.id)).messages).toHaveLength(0);
  });
  it('deduplicates generation requests and persists final stream content', async () => {
    const provider: InferenceProvider = {
      listModels: async () => [],
      capabilities: async () => ({ tools: false, streaming: true }),
      async *generate() {
        yield { type: 'text_delta', text: '안녕 ' };
        yield { type: 'text_delta', text: 'Lodex' };
        yield { type: 'finished', reason: 'stop' };
      },
    };
    const app = await setup(provider),
      session = await app.create();
    const command = makeCommand({
      type: 'send_message',
      sessionId: session.id,
      expectedVersion: session.version,
      content: 'hello',
    });
    expect((await app.command(command)).status).toBe(200);
    expect(((await app.command(command).then((r) => r.json())) as CommandResult).replayed).toBe(
      true,
    );
    await vi.waitFor(async () =>
      expect((await app.store.session(session.id)).run?.status).toBe('completed'),
    );
    expect(app.factory).toHaveBeenCalledTimes(1);
    expect((await app.store.session(session.id)).messages.at(-1)?.content).toBe('안녕 Lodex');
  });
  it('cancels an active request and never marks late content complete', async () => {
    let aborted = false;
    const provider: InferenceProvider = {
      listModels: async () => [],
      capabilities: async () => ({ tools: false, streaming: true }),
      async *generate(_request, signal) {
        yield { type: 'text_delta', text: '부분 응답' };
        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          else signal.addEventListener('abort', () => resolve(), { once: true });
        });
        aborted = signal.aborted;
        yield { type: 'text_delta', text: '늦은 응답' };
        yield { type: 'finished', reason: 'stop' };
      },
    };
    const app = await setup(provider),
      session = await app.create();
    const result = (await app
      .command(
        makeCommand({
          type: 'send_message',
          sessionId: session.id,
          expectedVersion: session.version,
          content: 'run',
        }),
      )
      .then((r) => r.json())) as CommandResult;
    await app.command(
      makeCommand({ type: 'cancel_run', sessionId: session.id, runId: result.session.run!.id }),
    );
    await vi.waitFor(() => expect(aborted).toBe(true));
    expect((await app.store.session(session.id)).run?.status).toBe('cancelled');
    expect((await app.store.session(session.id)).messages.at(-1)?.content).not.toContain(
      '늦은 응답',
    );
  });
  it('replays durable events after a reconnect cursor', async () => {
    const app = await setup(),
      session = await app.create();
    await app.command(
      makeCommand({
        type: 'save_plan',
        sessionId: session.id,
        expectedVersion: session.version,
        plan: { ...defaultPlan(), goal: '복구 확인' },
      }),
    );
    const abort = new AbortController();
    const response = await app.request('/v1/events?after=1', { signal: abort.signal });
    const events = decodeSse(response.body!, abort.signal);
    const event = await events.next();
    expect(JSON.parse(event.value!.data).session.plan.goal).toBe('복구 확인');
    expect(event.value!.id).toBe('2');
    await events.return(undefined);
    abort.abort();
  });
  it('rejects tool execution when no project tools are enabled', async () => {
    const provider: InferenceProvider = {
      listModels: async () => [],
      capabilities: async () => ({ tools: true, streaming: true }),
      async *generate() {
        yield {
          type: 'tool_call_delta',
          index: 0,
          id: 'unavailable-call',
          name: 'exec',
          arguments: '{"command":"never-run"}',
        };
        yield { type: 'finished', reason: 'tool_calls' };
      },
    };
    const app = await setup(provider),
      session = await app.create();
    await app.command(
      makeCommand({
        type: 'send_message',
        sessionId: session.id,
        expectedVersion: session.version,
        content: 'run',
      }),
    );
    await vi.waitFor(async () =>
      expect((await app.store.session(session.id)).run?.status).toBe('failed'),
    );
    expect((await app.store.session(session.id)).messages.at(-1)?.error).toContain(
      '실행하지 않았습니다',
    );
  });
});
