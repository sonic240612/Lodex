import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  defaultExecutionConfig,
  defaultModelConfig,
  makeCommand,
  type Command,
  type InferenceProvider,
  type Session,
} from '@lodex/contracts';
import { Store } from '@lodex/storage';
import { startServer } from './server';
import { ObservationPack } from './observations';
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});

describe('ObservationPack full session lifecycle', () => {
  it('preserves complete captured output, then recalls it after compaction and a daemon restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lodex-observation-lifecycle-'));
    const projectPath = join(root, 'project');
    await mkdir(projectPath);
    const database = join(root, 'state.sqlite'),
      observationRoot = join(root, 'observations');
    let store = await Store.open(database, resolve('apps/daemon/dist/worker.cjs'));
    const output = Array.from(
      { length: 1500 },
      (_, line) => `line ${line}: ${'evidence '.repeat(4)}`,
    ).join('\n');
    let round = 0,
      observationId = '';
    const provider: InferenceProvider = {
      listModels: async () => [],
      capabilities: async () => ({ streaming: true, tools: true }),
      async *generate(request) {
        if (round === 0) {
          yield {
            type: 'tool_call_delta',
            index: 0,
            id: 'large-log',
            name: 'run_command',
            arguments: '{"command":"known-check"}',
          };
          yield { type: 'finished', reason: 'tool_calls' };
        } else if (round <= 2) {
          expect(
            JSON.parse(request.messages.find((entry) => entry.toolCallId === 'large-log')!.content)
              .output,
          ).toBe(output);
          yield {
            type: 'tool_call_delta',
            index: 0,
            id: 'read-' + round,
            name: 'list_files',
            arguments: '{"path":"."}',
          };
          yield { type: 'finished', reason: 'tool_calls' };
        } else {
          const placeholder = request.messages.find(
            (entry) => entry.toolCallId === 'large-log',
          )!.content;
          expect(placeholder).toContain('large tool result replaced');
          observationId = /id: (obs_[a-f0-9]{24})/.exec(placeholder)![1]!;
          yield { type: 'text_delta', text: 'The captured check completed.' };
          yield { type: 'finished', reason: 'stop' };
        }
        round++;
      },
    };
    let app = await startServer({
      token: 'd'.repeat(64),
      store,
      observationRoot,
      providerFactory: () => provider,
      commandExecutor: async (options) => {
        options.captureOutput?.(output);
        const execution = {
          id: crypto.randomUUID(),
          containerName: 'test',
          environment: 'docker' as const,
          command: 'known-check',
          cwd: '.',
          status: 'completed' as const,
          startedAt: new Date().toISOString(),
          exitCode: 0,
          output: 'display excerpt only',
          truncated: true,
          cleanupPending: false,
        };
        await options.record(execution);
        return execution;
      },
    });
    cleanup.push(async () => {
      await app.close();
      if (dirname(resolve(root)) !== resolve(tmpdir()))
        throw new Error('Unsafe lifecycle directory');
      await rm(root, { recursive: true, force: true });
    });
    const request = (path: string, body: unknown) =>
      fetch(`http://127.0.0.1:${app.port}${path}`, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + 'd'.repeat(64), 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    const command = async (value: Command): Promise<Session> => {
      const response = await request('/v1/commands', value);
      expect(response.status, await response.clone().text()).toBe(200);
      return (await response.json()).session;
    };
    const { project } = await request('/v1/projects', { path: projectPath }).then((value) =>
      value.json(),
    );
    let session = await command(
      makeCommand({
        type: 'create_session',
        sessionId: crypto.randomUUID(),
        title: 'Observations',
        config: {
          ...defaultModelConfig(),
          provider: 'demo',
          model: 'demo',
          eco: true,
          contextBudgetTokens: 131072,
        },
        projectId: project.id,
      }),
    );
    session = await command(
      makeCommand({
        type: 'set_permission_mode',
        sessionId: session.id,
        expectedVersion: session.version,
        mode: 'auto',
      }),
    );
    session = await command(
      makeCommand({
        type: 'configure_execution',
        sessionId: session.id,
        expectedVersion: session.version,
        execution: { ...defaultExecutionConfig(), backend: 'docker', projectAccess: true },
      }),
    );
    await command(
      makeCommand({
        type: 'send_message',
        sessionId: session.id,
        expectedVersion: session.version,
        content: 'Run the known check.',
      }),
    );
    await vi.waitFor(async () =>
      expect((await store.session(session.id)).run?.status).not.toBe('running'),
    );
    session = await store.session(session.id);
    expect(session.run?.status, session.messages.at(-1)?.error ?? undefined).toBe('completed');
    const original = session.messages
      .at(-1)!
      .continuation!.find((entry) => entry.toolCallId === 'large-log')!;
    expect(JSON.parse(original.content).output).toBe(output);
    expect(original.observationId).toBe(observationId);
    // Add completed turns so the native compaction cut includes the tool-bearing turn.
    for (let index = 0; index < 3; index++) {
      session = (
        await store.apply(
          makeCommand({
            type: 'send_message',
            sessionId: session.id,
            expectedVersion: session.version,
            content: `follow-up ${index}`,
          }),
        )
      ).session;
      session = await store.updateRun({
        sessionId: session.id,
        runId: session.run!.id,
        text: 'Recorded follow-up.',
        status: 'completed',
      });
    }
    session = await command(
      makeCommand({
        type: 'quick_compact_context',
        sessionId: session.id,
        expectedVersion: session.version,
      }),
    );
    expect(session.contextCompaction!.summary).toContain(observationId);
    expect(
      JSON.parse(
        session.messages
          .find((message) =>
            message.continuation?.some((entry) => entry.observationId === observationId),
          )!
          .continuation!.find((entry) => entry.observationId === observationId)!.content,
      ).output,
    ).toBe(output);
    await app.close();
    store = await Store.open(database, resolve('apps/daemon/dist/worker.cjs'));
    let resumed = 0;
    const next: InferenceProvider = {
      listModels: async () => [],
      capabilities: async () => ({ streaming: true, tools: true }),
      async *generate(input) {
        const requestNumber = resumed++;
        if (requestNumber === 0) {
          expect(JSON.stringify(input.messages)).toContain(observationId);
          expect(JSON.stringify(input.messages)).not.toContain('line 700:');
          yield {
            type: 'tool_call_delta',
            index: 0,
            id: 'recall',
            name: 'recall_observation',
            arguments: JSON.stringify({ id: 'obs_000000000000000000000000', offset: 0 }),
          };
          yield { type: 'finished', reason: 'tool_calls' };
        } else if (requestNumber === 1) {
          expect(JSON.parse(input.messages.at(-1)!.content).error).toBe('OBSERVATION_RECALL');
          yield {
            type: 'tool_call_delta',
            index: 0,
            id: 'recall-corrected',
            name: 'recall_observation',
            arguments: JSON.stringify({ id: observationId, offset: 0 }),
          };
          yield { type: 'finished', reason: 'tool_calls' };
        } else {
          const page = JSON.parse(input.messages.at(-1)!.content);
          expect(page.id).toBe(observationId);
          expect(page.text).toContain('line 0: evidence');
          yield { type: 'text_delta', text: 'Original evidence recalled after restart.' };
          yield { type: 'finished', reason: 'stop' };
        }
      },
    };
    app = await startServer({
      token: 'd'.repeat(64),
      store,
      observationRoot,
      providerFactory: () => next,
    });
    session = await store.session(session.id);
    await command(
      makeCommand({
        type: 'send_message',
        sessionId: session.id,
        expectedVersion: session.version,
        content: 'Retrieve the saved evidence.',
      }),
    );
    await vi.waitFor(async () =>
      expect((await store.session(session.id)).run?.status).not.toBe('running'),
    );
    session = await store.session(session.id);
    expect(session.run?.status, session.messages.at(-1)?.error ?? undefined).toBe('completed');
    expect(session.messages.at(-1)?.content).toContain('after restart');
    const pack = new ObservationPack(observationRoot);
    let offset = 0,
      restored = '';
    for (;;) {
      const page = JSON.parse(
        await pack.recall(session.id, JSON.stringify({ id: observationId, offset })),
      );
      restored += page.text;
      if (page.eof) break;
      offset = page.nextOffset;
    }
    expect(restored).toBe(original.content);
    const ledger = await readFile(join(observationRoot, session.id, 'ledger.jsonl'), 'utf8');
    expect(ledger).toContain('"event":"placeholder"');
    expect(ledger).toContain('"event":"recall"');
  });
});
