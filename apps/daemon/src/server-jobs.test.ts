import { expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '@lodex/storage';
import {
  defaultModelConfig,
  makeCommand,
  type CommandExecution,
  type CommandJob,
} from '@lodex/contracts';
import { inspectProject } from '@lodex/tools';
import { startServer } from './server';

it('accepts stdin while a foreground model run waits and isolates job APIs by conversation and Plan mode', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'lodex-job-api-'));
  const store = await Store.open(
    join(folder, 'state.sqlite'),
    resolve('apps/daemon/dist/worker.cjs'),
  );
  const project = await store.registerProject(await inspectProject(folder));
  let calls = 0,
    received = '';
  const token = 'j'.repeat(64);
  const app = await startServer({
    store,
    token,
    providerFactory: () => ({
      listModels: async () => [],
      capabilities: async () => ({ tools: true, streaming: true }),
      generate: async function* () {
        if (++calls === 1) {
          yield {
            type: 'tool_call_delta',
            index: 0,
            id: 'interactive',
            name: 'run_host_command',
            arguments: '{"command":"fixture stdin","interactive":true}',
          };
          yield { type: 'finished', reason: 'tool_calls' };
        } else {
          yield { type: 'text_delta', text: 'Input delivered.' };
          yield { type: 'finished', reason: 'stop' };
        }
      },
    }),
    hostCommandExecutor: async (options) => {
      const execution: CommandExecution = {
        id: crypto.randomUUID(),
        containerName: '',
        projectId: project.id,
        environment: 'host',
        command: 'fixture stdin',
        cwd: folder,
        status: 'starting',
        startedAt: new Date().toISOString(),
        exitCode: null,
        output: '',
        truncated: false,
        cleanupPending: false,
      };
      await options.record(execution);
      let finish!: () => void;
      const waiting = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const abort = () => finish();
      options.signal.addEventListener('abort', abort, { once: true });
      const detach = options.inputControl?.((text, eof) => {
        received += text;
        if (eof) finish();
      });
      execution.status = 'running';
      await options.record(execution);
      try {
        await waiting;
        execution.status = options.signal.aborted ? 'cancelled' : 'completed';
        execution.exitCode = options.signal.aborted ? null : 0;
        await options.record(execution);
        return execution;
      } finally {
        detach?.();
        options.signal.removeEventListener('abort', abort);
      }
    },
  });
  const request = (path: string, body?: unknown) =>
    fetch(`http://127.0.0.1:${app.port}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  try {
    let session = (
      await store.apply(
        makeCommand({
          type: 'create_session',
          title: 'jobs',
          sessionId: crypto.randomUUID(),
          mode: 'build',
          projectId: project.id,
          config: { ...defaultModelConfig(), provider: 'demo', contextBudgetTokens: 65536 },
        }),
      )
    ).session;
    session = (
      await store.apply(
        makeCommand({
          type: 'set_permission_mode',
          sessionId: session.id,
          expectedVersion: session.version,
          mode: 'full',
        }),
      )
    ).session;
    const other = (
      await store.apply(
        makeCommand({
          type: 'create_session',
          title: 'jobs',
          sessionId: crypto.randomUUID(),
          mode: 'plan',
          config: defaultModelConfig(),
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
            content: 'Ask for stdin',
          }),
        )
      ).status,
    ).toBe(200);
    let job!: CommandJob;
    await expect
      .poll(
        async () => {
          const response = await request(`/v1/command-jobs?sessionId=${session.id}`);
          job = ((await response.json()) as { jobs: CommandJob[] }).jobs[0]!;
          return job?.inputOpen;
        },
        { timeout: 10000 },
      )
      .toBe(true);
    expect((await store.session(session.id)).run?.status).toBe('running');
    expect(await (await request(`/v1/command-jobs?sessionId=${other.id}`)).json()).toEqual({
      jobs: [],
    });
    expect(
      (await request('/v1/command-jobs/input', { sessionId: other.id, jobId: job.id, input: 'no' }))
        .status,
    ).toBe(403);
    expect(
      (await request('/v1/command-jobs/stop', { sessionId: other.id, jobId: job.id })).status,
    ).toBe(404);
    expect(
      (
        await request('/v1/command-jobs/input', {
          sessionId: session.id,
          jobId: job.id,
          input: 'live input\n',
          eof: true,
        })
      ).status,
    ).toBe(200);
    await expect
      .poll(async () => (await store.session(session.id)).run?.status, { timeout: 10000 })
      .toBe('completed');
    expect(received).toBe('live input\n');
    expect(JSON.stringify((await store.integration('command_jobs'))?.document)).not.toContain(
      'live input',
    );
  } finally {
    await app.close();
    if (dirname(resolve(folder)) !== resolve(tmpdir())) throw Error('unsafe');
    await rm(folder, { recursive: true, force: true });
  }
});
