import { expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Store } from '@lodex/storage';
import { defaultModelConfig, defaultPlan, makeCommand, type Session } from '@lodex/contracts';
import { startServer } from './server';
import { createTaskList } from './task-list';

it.each(['cancelled', 'failed', 'restart'] as const)(
  'pauses unfinished task lists on %s and does not switch cancelled Plan to Build',
  async (outcome) => {
    const dir = await mkdtemp(join(tmpdir(), 'lodex-todo-pause-'));
    const db = join(dir, 'state.sqlite'),
      worker = resolve('apps/daemon/dist/worker.cjs');
    let store = await Store.open(db, worker);
    try {
      let session = (
        await store.apply(
          makeCommand({
            type: 'create_session',
            sessionId: crypto.randomUUID(),
            title: 'Pause',
            config: defaultModelConfig(),
            mode: 'plan',
          }),
        )
      ).session;
      session = (
        await store.apply(
          makeCommand({
            type: 'send_message',
            sessionId: session.id,
            expectedVersion: session.version,
            content: 'Investigate',
          }),
        )
      ).session;
      session = (
        await store.apply(
          makeCommand({ type: 'cancel_run', sessionId: session.id, runId: session.run!.id }),
        )
      ).session;
      expect(session.mode).toBe('plan');
      session = (
        await store.apply(
          makeCommand({
            type: 'save_task_list',
            sessionId: session.id,
            expectedVersion: session.version,
            taskList: createTaskList('{"tasks":[{"title":"Implement"}]}', session.run!.messageId),
          }),
        )
      ).session;
      session = (
        await store.apply(
          makeCommand({
            type: 'start_task_list',
            sessionId: session.id,
            expectedVersion: session.version,
          }),
        )
      ).session;
      expect(session.mode).toBe('build');
      if (outcome === 'cancelled')
        await store.apply(
          makeCommand({ type: 'cancel_run', sessionId: session.id, runId: session.run!.id }),
        );
      else if (outcome === 'failed')
        await store.updateRun({
          sessionId: session.id,
          runId: session.run!.id,
          status: 'failed',
          error: 'Fixture failure',
        });
      else {
        await store.close();
        store = await Store.open(db, worker);
      }
      session = await store.session(session.id);
      expect(session.taskList?.active).toBe(false);
      expect(session.taskList?.tasks[0]?.status).toBe('pending');
      expect(session.plan).toEqual(defaultPlan());
    } finally {
      await store.close();
      if (dirname(resolve(dir)) !== resolve(tmpdir())) throw new Error('unsafe cleanup');
      await rm(dir, { recursive: true, force: true });
    }
  },
);

it('saves a Plan to-do list, switches to Build, then runs each item without starting a Goal', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lodex-todo-'));
  const db = join(dir, 'state.sqlite');
  const worker = resolve('apps/daemon/dist/worker.cjs');
  const store = await Store.open(db, worker);
  const config = {
    ...defaultModelConfig(),
    provider: 'demo' as const,
    model: 'planner',
    contextBudgetTokens: 65536,
  };
  let build = false,
    planCalls = 0,
    buildCalls = 0;
  let taskIds: string[] = [];
  const token = 't'.repeat(64);
  const app = await startServer({
    store,
    token,
    providerFactory: () => ({
      listModels: async () => [],
      capabilities: async () => ({ streaming: true, tools: true }),
      generate: async function* (request) {
        if (!build) {
          expect(request.config.model).toBe('planner');
          expect(request.tools?.some((tool) => tool.function.name === 'set_task_list')).toBe(true);
          expect(request.tools?.some((tool) => tool.function.name === 'update_task')).toBe(false);
          if (++planCalls === 1) {
            yield {
              type: 'tool_call_delta',
              index: 0,
              id: 'todo-plan',
              name: 'set_task_list',
              arguments: JSON.stringify({
                tasks: [
                  { title: 'Implement the change', details: 'Use the investigation' },
                  { title: 'Validate the result' },
                ],
              }),
            };
            yield { type: 'finished', reason: 'tool_calls' };
          } else {
            yield { type: 'text_delta', text: 'Plan ready.' };
            yield { type: 'finished', reason: 'stop' };
          }
        } else {
          expect(request.config.model).toBe('builder');
          expect(request.tools?.some((tool) => tool.function.name === 'update_task')).toBe(true);
          expect(request.tools?.some((tool) => tool.function.name === 'complete_goal')).toBe(false);
          const turn = ++buildCalls;
          if (turn === 1 || turn === 3) {
            // A premature prose stop must not silently complete an active list.
            yield { type: 'text_delta', text: 'Continuing the saved task.' };
            yield { type: 'finished', reason: 'stop' };
          } else if (turn === 2 || turn === 4) {
            const taskId = taskIds[turn === 2 ? 0 : 1]!;
            expect(request.messages.at(-1)?.content).toContain(taskId);
            yield {
              type: 'tool_call_delta',
              index: 0,
              id: 'progress-' + turn,
              name: 'update_task',
              arguments: JSON.stringify({
                taskId,
                status: 'completed',
                summary: turn === 2 ? 'Change inspected' : 'Validation passed',
              }),
            };
            yield { type: 'finished', reason: 'tool_calls' };
          } else {
            yield { type: 'text_delta', text: 'All tasks completed.' };
            yield { type: 'finished', reason: 'stop' };
          }
        }
      },
    }),
  });
  const send = (input: Parameters<typeof makeCommand>[0]) =>
    fetch(`http://127.0.0.1:${app.port}/v1/commands`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(makeCommand(input)),
    });
  let saved: Session | undefined;
  try {
    let session = (
      await store.apply(
        makeCommand({
          type: 'create_session',
          sessionId: crypto.randomUUID(),
          title: 'To-do',
          config,
          mode: 'plan',
          routing: { build: { ...config, model: 'builder' } },
        }),
      )
    ).session;
    expect(
      (
        await send({
          type: 'send_message',
          sessionId: session.id,
          expectedVersion: session.version,
          content: 'Investigate and make a task list.',
        })
      ).status,
    ).toBe(200);
    await expect.poll(async () => (await store.session(session.id)).run?.status).toBe('completed');
    session = await store.session(session.id);
    expect(session.mode).toBe('build');
    expect(session.messages.at(-1)?.agentMode).toBe('plan');
    expect(session.plan).toEqual(defaultPlan());
    expect(session.taskList?.tasks.map((task) => task.status)).toEqual(['pending', 'pending']);
    taskIds = session.taskList!.tasks.map((task) => task.id);
    build = true;
    expect(
      (
        await send({
          type: 'start_task_list',
          sessionId: session.id,
          expectedVersion: session.version,
        })
      ).status,
    ).toBe(200);
    await expect.poll(async () => (await store.session(session.id)).run?.status).toBe('completed');
    saved = await store.session(session.id);
    expect(saved.taskList?.tasks.map((task) => task.status)).toEqual(['completed', 'completed']);
    expect(saved.taskList?.active).toBe(false);
    expect(saved.autopilot).toBeUndefined();
    expect(saved.plan).toEqual(defaultPlan());
    expect(buildCalls).toBe(5);
  } finally {
    await app.close();
  }
  const reopened = await Store.open(db, worker);
  try {
    expect((await reopened.session(saved!.id)).taskList).toEqual(saved!.taskList);
    expect((await reopened.session(saved!.id)).mode).toBe('build');
  } finally {
    await reopened.close();
    if (dirname(resolve(dir)) !== resolve(tmpdir())) throw new Error('unsafe cleanup');
    await rm(dir, { recursive: true, force: true });
  }
});
