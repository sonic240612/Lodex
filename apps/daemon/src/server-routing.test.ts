import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  defaultModelConfig,
  makeCommand,
  type AgentRoutingConfig,
  type InferenceProvider,
  type InferenceRequest,
} from '@lodex/contracts';
import { Store } from '@lodex/storage';
import { startServer } from './server';
import { inspectProject } from '@lodex/tools';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});
const base = { ...defaultModelConfig(), provider: 'demo' as const, model: 'base' };
async function setup(
  generate: InferenceProvider['generate'],
  routing: AgentRoutingConfig,
  project = false,
) {
  const dir = await mkdtemp(join(tmpdir(), 'lodex-roles-'));
  const store = await Store.open(join(dir, 'state.sqlite'), resolve('apps/daemon/dist/worker.cjs'));
  const app = await startServer({
    token: 'a'.repeat(64),
    store,
    openrouterKey: 'fixture-key',
    providerFactory: () => ({
      generate,
      listModels: async () => [],
      capabilities: async () => ({ tools: true, streaming: true }),
    }),
  });
  cleanups.push(async () => {
    await app.close();
    if (dirname(resolve(dir)) !== resolve(tmpdir())) throw new Error('Unsafe fixture');
    await rm(dir, { recursive: true, force: true });
  });
  let projectId: string | null = null;
  if (project) {
    await writeFile(join(dir, 'hello.txt'), 'actual project evidence');
    projectId = (await store.registerProject(await inspectProject(dir))).id;
  }
  const created = await store.apply(
    makeCommand({
      type: 'create_session',
      sessionId: crypto.randomUUID(),
      title: 'roles',
      config: base,
      mode: 'plan',
      routing,
      projectId,
    }),
  );
  const command = (body: unknown) =>
    fetch('http://127.0.0.1:' + app.port + '/v1/commands', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + 'a'.repeat(64), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  const send = async () => {
    const current = await store.session(created.session.id);
    return command(
      makeCommand({
        type: 'send_message',
        sessionId: current.id,
        expectedVersion: current.version,
        content: 'Main private conversation. Delegate the specified independent tasks.',
      }),
    );
  };
  return { store, session: created.session, command, send };
}

describe('role routing and durable delegation', () => {
  it('keeps parent and child generations running beyond the former shared cap', async () => {
    let calls = 0;
    const app = await setup(
      async function* (request) {
        calls++;
        if (request.config.model === 'planner') {
          yield {
            type: 'tool_call_delta',
            index: 0,
            id: 'd-' + calls,
            name: 'delegate_tasks',
            arguments: '{"tasks":[{"task":"one"},{"task":"two"},{"task":"three"}]}',
          };
          yield { type: 'finished', reason: 'tool_calls' };
        } else {
          yield { type: 'text_delta', text: 'finding' };
          yield { type: 'finished', reason: 'stop' };
        }
      },
      { subagentsEnabled: true, plan: { ...base, model: 'planner' } },
    );
    expect((await app.send()).status).toBe(200);
    await expect.poll(() => calls).toBeGreaterThan(12);
    const running = await app.store.session(app.session.id);
    expect(running.run?.status).toBe('running');
    expect(
      (
        await app.command(
          makeCommand({
            type: 'cancel_run',
            sessionId: running.id,
            runId: running.run!.id,
          }),
        )
      ).status,
    ).toBe(200);
    await expect
      .poll(async () => (await app.store.session(app.session.id)).run?.status)
      .toBe('cancelled');
    expect(calls).toBeGreaterThan(12);
    expect((await app.store.session(app.session.id)).messages.at(-1)?.status).toBe('cancelled');
  });

  it('uses Plan and child models with isolated project context and persists their results', async () => {
    const requests: InferenceRequest[] = [];
    const app = await setup(
      async function* (request) {
        requests.push(structuredClone(request));
        const last = request.messages.at(-1)!;
        yield { type: 'usage', usage: { inputTokens: 7, outputTokens: 3 } };
        if (request.config.model === 'planner' && last.role !== 'tool') {
          yield {
            type: 'tool_call_delta',
            index: 0,
            id: 'delegate-1',
            name: 'delegate_tasks',
            arguments: JSON.stringify({
              tasks: [{ task: 'Inspect hello.txt' }, { task: 'Explain a small concept' }],
            }),
          };
          yield { type: 'finished', reason: 'tool_calls' };
        } else if (
          request.config.model === 'reader' &&
          request.messages[1]!.content.includes('hello.txt') &&
          last.role !== 'tool'
        ) {
          yield {
            type: 'tool_call_delta',
            index: 0,
            id: 'read-1',
            name: 'read_file',
            arguments: '{"path":"hello.txt"}',
          };
          yield { type: 'finished', reason: 'tool_calls' };
        } else {
          yield {
            type: 'text_delta',
            text:
              request.config.model === 'reader' ? 'Independent finding' : 'Reviewed child findings',
          };
          yield { type: 'finished', reason: 'stop' };
        }
      },
      {
        subagentsEnabled: true,
        plan: { ...base, model: 'planner' },
        subagent: { ...base, model: 'reader' },
      },
      true,
    );
    expect((await app.send()).status).toBe(200);
    await expect
      .poll(async () => (await app.store.session(app.session.id)).run?.status)
      .toBe('completed');
    const current = await app.store.session(app.session.id),
      answer = current.messages.at(-1)!;
    expect(current.config.model).toBe('base');
    expect(answer.inferenceConfig?.model).toBe('planner');
    expect(
      answer.activities
        ?.find((activity) => activity.subagents)
        ?.subagents?.map((child) => child.status),
    ).toEqual(['completed', 'completed']);
    const children = requests.filter((r) => r.config.model === 'reader');
    expect(children).toHaveLength(3);
    expect(
      children.every((r) => !JSON.stringify(r.messages).includes('Main private conversation')),
    ).toBe(true);
    expect(
      children.every((r) =>
        r.tools?.every((t) =>
          ['inspect_path', 'read_file', 'list_files', 'find_files', 'search_text'].includes(
            t.function.name,
          ),
        ),
      ),
    ).toBe(true);
    expect(
      children.some((r) => r.messages.some((m) => m.content.includes('actual project evidence'))),
    ).toBe(true);
    expect(answer.usage).toMatchObject({ inputTokens: 35, outputTokens: 15 });
  });

  it('uses the base model for an unspecified child role and blocks unconsented cloud roles before persistence', async () => {
    const called: string[] = [];
    const app = await setup(
      async function* (req) {
        called.push(req.config.model);
        if (req.config.model === 'planner' && req.messages.at(-1)?.role !== 'tool') {
          yield {
            type: 'tool_call_delta',
            index: 0,
            id: 'd',
            name: 'delegate_tasks',
            arguments: '{"tasks":[{"task":"task"}]}',
          };
          yield { type: 'finished', reason: 'tool_calls' };
        } else {
          yield { type: 'text_delta', text: 'done' };
          yield { type: 'finished', reason: 'stop' };
        }
      },
      { subagentsEnabled: true, plan: { ...base, model: 'planner' } },
    );
    expect((await app.send()).status).toBe(200);
    await expect
      .poll(async () => (await app.store.session(app.session.id)).run?.status)
      .toBe('completed');
    expect(called).toEqual(['planner', 'base', 'planner']);
    const cloud = await setup(
      async function* () {
        throw new Error('must not generate');
        yield { type: 'finished', reason: 'stop' };
      },
      {
        subagentsEnabled: true,
        subagent: { ...base, provider: 'openrouter', cloudConsent: false },
      },
    );
    const response = await cloud.send();
    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe('CLOUD_CONSENT');
    expect((await cloud.store.session(cloud.session.id)).messages).toHaveLength(0);
  });

  it('locks used routing and recovers running children without replaying them', async () => {
    const app = await setup(
      async function* () {
        yield { type: 'finished', reason: 'stop' };
      },
      { subagentsEnabled: true },
    );
    const first = await app.store.apply(
      makeCommand({
        type: 'send_message',
        sessionId: app.session.id,
        expectedVersion: app.session.version,
        content: 'persist only',
      }),
    );
    await app.store.updateRun({
      sessionId: first.session.id,
      runId: first.session.run!.id,
      activities: [
        {
          id: crypto.randomUUID(),
          kind: 'tool',
          label: 'delegate_tasks',
          status: 'running',
          text: '',
          subagents: [
            {
              id: crypto.randomUUID(),
              task: 'unfinished',
              status: 'running',
              provider: 'demo',
              model: 'base',
              text: '',
              modelCalls: 1,
              toolCalls: 0,
            },
          ],
        },
      ],
    });
    await app.store.updateRun({
      sessionId: first.session.id,
      runId: first.session.run!.id,
      status: 'interrupted',
    });
    const recovered = await app.store.session(first.session.id);
    expect(recovered.messages.at(-1)?.activities?.[0]?.subagents?.[0]?.status).toBe('interrupted');
    const response = await app.command(
      makeCommand({
        type: 'configure_routing',
        sessionId: recovered.id,
        expectedVersion: recovered.version,
        routing: { subagentsEnabled: false },
      }),
    );
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe('NEW_SESSION_REQUIRED');
  });
});
