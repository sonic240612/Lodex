import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  defaultModelConfig,
  makeCommand,
  taskListSchema,
  type InferenceProvider,
  type ModelConfig,
  type AgentRoutingConfig,
  type InferenceRequest,
  type Command,
} from '@lodex/contracts';
import { Store } from '@lodex/storage';
import { startServer } from './server';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});
const config = (model: string, cloud = false): ModelConfig => ({
  ...defaultModelConfig(),
  provider: cloud ? 'openrouter' : 'llama-server',
  model,
  cloudConsent: cloud,
  maxTokens: 512,
  autoMaxTokens: false,
});
const pricing = { prompt: 0.000001, completion: 0.000002, request: 0 };
async function fixture(
  generate: InferenceProvider['generate'],
  options: {
    routing?: AgentRoutingConfig;
    tasks?: { id: string; model?: ModelConfig; costUsd?: number }[];
  } = {},
) {
  const dir = await mkdtemp(join(tmpdir(), 'lodex-role-models-'));
  const store = await Store.open(join(dir, 'state.sqlite'), resolve('apps/daemon/dist/worker.cjs'));
  const requests: InferenceRequest[] = [];
  const provider: InferenceProvider = {
    listModels: async () =>
      ['task-one', 'task-two', 'reviewer', 'summarizer'].map((id) => ({
        id,
        name: id,
        contextLength: 32768,
        maxCompletionTokens: 4096,
        defaultTemperature: null,
        defaultTopP: null,
        tools: true,
        pricing,
      })),
    capabilities: async () => ({ tools: true, streaming: true }),
    async *generate(request, signal) {
      requests.push(structuredClone(request));
      yield* generate(request, signal);
    },
  };
  const app = await startServer({
    token: 'r'.repeat(64),
    store,
    openrouterKey: 'fake-test-only',
    providerFactory: () => provider,
  });
  cleanups.push(async () => {
    await app.close();
    if (dirname(resolve(dir)) !== resolve(tmpdir())) throw new Error('Unsafe fixture');
    await rm(dir, { recursive: true, force: true });
  });
  let session = (
    await store.apply(
      makeCommand({
        type: 'create_session',
        sessionId: crypto.randomUUID(),
        title: 'Role models',
        config: config('main'),
        ...(options.routing ? { routing: options.routing } : {}),
      }),
    )
  ).session;
  if (options.tasks)
    session = (
      await store.apply(
        makeCommand({
          type: 'save_task_list',
          sessionId: session.id,
          expectedVersion: session.version,
          taskList: taskListSchema.parse({
            tasks: options.tasks.map((task, index) => ({ ...task, title: `Task ${index + 1}` })),
          }),
        }),
      )
    ).session;
  const command = (value: Command) =>
    fetch(`http://127.0.0.1:${app.port}/v1/commands`, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + 'r'.repeat(64), 'Content-Type': 'application/json' },
      body: JSON.stringify(value),
    });
  const start = async (current = session) => {
    const value = makeCommand(
      options.tasks
        ? { type: 'start_task_list', sessionId: current.id, expectedVersion: current.version }
        : {
            type: 'send_message',
            sessionId: current.id,
            expectedVersion: current.version,
            content: 'Review the current work.',
          },
    );
    const response = await command(value);
    expect(response.status, await response.clone().text()).toBe(200);
    await expect
      .poll(async () => (await store.session(session.id)).run?.status)
      .not.toBe('running');
    return store.session(session.id);
  };
  return { store, session, command, start, requests };
}

it('uses each ordered task model and stops the old model batch before the next task', async () => {
  const ids = [crypto.randomUUID(), crypto.randomUUID()];
  const app = await fixture(
    async function* (request) {
      const first = request.config.model === 'task-one';
      yield {
        type: 'usage',
        usage: {
          generationId: first ? 'generation-one' : 'generation-two',
          costUsd: 0.002,
          inputTokens: 100,
          outputTokens: 50,
        },
      };
      yield {
        type: 'tool_call_delta',
        index: 0,
        id: first ? 'complete-one' : 'complete-two',
        name: 'update_task',
        arguments: JSON.stringify({
          taskId: first ? ids[0] : ids[1],
          status: 'completed',
          summary: 'Validated the result.',
        }),
      };
      if (first)
        yield {
          type: 'tool_call_delta',
          index: 1,
          id: 'must-not-run',
          name: 'web_fetch',
          arguments: '{"url":"http://127.0.0.1:1/"}',
        };
      yield { type: 'finished', reason: 'tool_calls' };
    },
    {
      tasks: [
        { id: ids[0]!, model: config('task-one', true), costUsd: 0.1 },
        { id: ids[1]!, model: config('task-two', true), costUsd: 0.1 },
      ],
    },
  );
  const final = await app.start();
  expect(final.run?.status).toBe('completed');
  expect(app.requests.map((request) => request.config.model)).toEqual(['task-one', 'task-two']);
  expect(final.taskList?.tasks.map((task) => task.status)).toEqual(['completed', 'completed']);
  expect(final.messages.at(-1)?.inferenceConfig?.model).toBe('task-two');
  expect(
    final.messages.at(-1)?.costCalls?.map((call) => [call.taskId, call.model, call.actualCostUsd]),
  ).toEqual([
    [ids[0], 'task-one', 0.002],
    [ids[1], 'task-two', 0.002],
  ]);
  const skipped = final.messages
    .at(-1)
    ?.continuation?.find((entry) => entry.toolCallId === 'must-not-run');
  expect(JSON.parse(skipped!.content).skipped).toBe(true);
});

it('rejects a task reservation before generation', async () => {
  const id = crypto.randomUUID();
  const app = await fixture(
    async function* () {
      yield { type: 'text_delta', text: 'must not generate' };
      yield { type: 'finished', reason: 'stop' };
    },
    { tasks: [{ id, model: config('task-one', true), costUsd: 0.001 }] },
  );
  const final = await app.start();
  expect(final.run?.status).toBe('failed');
  expect(final.messages.at(-1)?.error).toContain('작업 비용 한도');
  expect(app.requests).toHaveLength(0);
  expect(final.taskList?.active).toBe(false);
});

it('uses the summary role during automatic compaction and records every charged summary chunk', async () => {
  let generation = 0;
  const app = await fixture(
    async function* (request) {
      if (request.config.model === 'summarizer') {
        expect(request.purpose).toBe('context_summary');
        yield {
          type: 'usage',
          usage: {
            generationId: 'summary-' + ++generation,
            costUsd: 0.001,
            inputTokens: 100,
            outputTokens: 40,
          },
        };
        yield {
          type: 'text_delta',
          text: 'Previous investigation is preserved. Implement the requested update without changing the public API, then run relevant validation.',
        };
      } else yield { type: 'text_delta', text: 'Continued from the summary.' };
      yield { type: 'finished', reason: 'stop' };
    },
    {
      routing: {
        subagentsEnabled: false,
        summary: { ...config('summarizer', true), contextBudgetTokens: 8192 },
      },
    },
  );
  let current = app.session;
  for (let index = 0; index < 3; index++) {
    current = (
      await app.store.apply(
        makeCommand({
          type: 'send_message',
          sessionId: current.id,
          expectedVersion: current.version,
          content: 'Earlier request ' + index,
        }),
      )
    ).session;
    current = await app.store.updateRun({
      sessionId: current.id,
      runId: current.run!.id,
      text: 'Verified investigation record. '.repeat(550),
      status: 'completed',
    });
  }
  const final = await app.start(current);
  expect(final.run?.status, final.messages.at(-1)?.error ?? undefined).toBe('completed');
  expect(app.requests.some((request) => request.config.model === 'summarizer')).toBe(true);
  expect(app.requests.at(-1)?.config.model).toBe('main');
  expect(final.messages.at(-1)?.runContextCompaction?.model).toBe('summarizer');
  const charges = final.messages.at(-1)?.costCalls ?? [];
  expect(charges.length).toBeGreaterThan(0);
  expect(
    charges.every(
      (call) =>
        call.purpose === 'automatic_compaction' &&
        call.model === 'summarizer' &&
        call.actualCostUsd === 0.001,
    ),
  ).toBe(true);
});

it('executes the review role without tools and records its actual model, purpose and charge', async () => {
  let main = 0;
  const app = await fixture(
    async function* (request) {
      if (request.config.model === 'reviewer') {
        expect(request.tools).toEqual([]);
        yield {
          type: 'usage',
          usage: {
            generationId: 'review-generation',
            costUsd: 0.003,
            inputTokens: 150,
            outputTokens: 45,
          },
        };
        yield { type: 'text_delta', text: 'Found a missing null check in the supplied function.' };
        yield { type: 'finished', reason: 'stop' };
      } else if (main++ === 0) {
        yield {
          type: 'tool_call_delta',
          index: 0,
          id: 'review',
          name: 'review_work',
          arguments: JSON.stringify({ content: 'function sample(value) { return value.name; }' }),
        };
        yield { type: 'finished', reason: 'tool_calls' };
      } else {
        yield { type: 'text_delta', text: 'Review complete.' };
        yield { type: 'finished', reason: 'stop' };
      }
    },
    { routing: { subagentsEnabled: false, review: config('reviewer', true) } },
  );
  const final = await app.start();
  expect(final.run?.status).toBe('completed');
  expect(app.requests.map((request) => request.config.model)).toEqual(['main', 'reviewer', 'main']);
  expect(final.messages.at(-1)?.costCalls?.[0]).toMatchObject({
    model: 'reviewer',
    purpose: 'review',
    actualCostUsd: 0.003,
  });
  expect(final.messages.at(-1)?.costCalls?.[0]?.reservedCostUsd).toBeGreaterThan(0);
  expect(
    final.messages.at(-1)?.activities?.find((activity) => activity.label === 'review_work')?.text,
  ).toContain('reviewer');
});

it('continues the original run with new instructions when a review is interrupted', async () => {
  let steer!: () => Promise<void>,
    main = 0;
  const app = await fixture(
    async function* (request, signal) {
      if (request.config.model === 'reviewer') {
        await steer();
        signal.throwIfAborted();
        throw new Error('Review must be interrupted');
      }
      if (main++ === 0) {
        yield {
          type: 'tool_call_delta',
          index: 0,
          id: 'review',
          name: 'review_work',
          arguments: JSON.stringify({ content: 'Current implementation' }),
        };
        yield { type: 'finished', reason: 'tool_calls' };
      } else {
        expect(JSON.stringify(request.messages)).toContain('Also check the empty case.');
        yield { type: 'text_delta', text: 'Included the additional instruction.' };
        yield { type: 'finished', reason: 'stop' };
      }
    },
    { routing: { subagentsEnabled: false, review: config('reviewer') } },
  );
  steer = async () => {
    const live = await app.store.session(app.session.id);
    expect(
      (
        await app.command(
          makeCommand({
            type: 'steer_run',
            sessionId: live.id,
            runId: live.run!.id,
            content: 'Also check the empty case.',
          }),
        )
      ).status,
    ).toBe(200);
  };
  const final = await app.start();
  expect(final.run?.status).toBe('completed');
  const answer = final.messages.find((message) => message.id === final.run?.messageId);
  expect(answer?.content).toContain('Included the additional instruction.');
  expect(answer?.activities?.find((activity) => activity.label === 'review_work')?.status).toBe(
    'interrupted',
  );
});

it('does not send any request when a configured review role lacks cloud consent', async () => {
  const app = await fixture(
    async function* () {
      yield { type: 'finished', reason: 'stop' };
    },
    {
      routing: {
        subagentsEnabled: false,
        review: { ...config('reviewer', true), cloudConsent: false },
      },
    },
  );
  const response = await app.command(
    makeCommand({
      type: 'send_message',
      sessionId: app.session.id,
      expectedVersion: app.session.version,
      content: 'Review',
    }),
  );
  expect(response.status).toBe(403);
  expect(app.requests).toEqual([]);
});
