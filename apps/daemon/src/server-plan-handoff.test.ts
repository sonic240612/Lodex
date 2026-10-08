import { expect, it } from 'vitest';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { Store } from '@lodex/storage';
import { defaultModelConfig, makeCommand } from '@lodex/contracts';
import { inspectProject } from '@lodex/tools';
import { startServer } from './server';

it.each([false, true])(
  'continues Plan evidence into Build without another read, routed model=%s',
  async (routed) => {
    const dir = await mkdtemp(join(tmpdir(), 'lodex-plan-handoff-'));
    await writeFile(join(dir, 'file.txt'), 'before PLAN_SOURCE_FACT\n');
    const hash = createHash('sha256').update('before PLAN_SOURCE_FACT\n').digest('hex');
    const store = await Store.open(
      join(dir, 'state.sqlite'),
      resolve('apps/daemon/dist/worker.cjs'),
    );
    const project = await store.registerProject(await inspectProject(dir));
    const config = {
      ...defaultModelConfig(),
      provider: 'demo' as const,
      model: 'planner',
      contextBudgetTokens: 65536,
      eco: true,
    };
    let build = false,
      planCalls = 0,
      buildCalls = 0,
      readCalls = 0;
    const token = 'p'.repeat(64);
    const app = await startServer({
      store,
      token,
      providerFactory: () => ({
        listModels: async () => [],
        capabilities: async () => ({ streaming: true, tools: true }),
        generate: async function* (request) {
          if (!build) {
            if (++planCalls === 1) {
              readCalls++;
              yield {
                type: 'tool_call_delta',
                index: 0,
                id: 'plan-source-read',
                name: 'read_file',
                arguments: '{"path":"file.txt"}',
              };
              yield { type: 'finished', reason: 'tool_calls' };
            } else {
              yield { type: 'text_delta', text: 'The investigation is ready for Build.' };
              yield { type: 'finished', reason: 'stop' };
            }
          } else {
            expect(request.config.model).toBe(routed ? 'builder' : 'planner');
            if (++buildCalls === 1) {
              expect(request.messages.at(-1)?.content).toContain('PLAN_SOURCE_FACT');
              expect(request.messages.at(-1)?.content).toContain('plan-source-read');
              expect(request.messages.at(-1)?.content).toContain(hash);
              expect(request.messages[0]?.content).toContain('do not restart investigation');
              yield {
                type: 'tool_call_delta',
                index: 0,
                id: 'build-edit',
                name: 'propose_edit',
                arguments: JSON.stringify({
                  path: 'file.txt',
                  expectedHash: hash,
                  oldText: 'before',
                  newText: 'after',
                }),
              };
              yield { type: 'finished', reason: 'tool_calls' };
            } else {
              expect(JSON.parse(request.messages.at(-1)!.content).status).toBe('applied');
              yield { type: 'text_delta', text: 'Implemented from the saved investigation.' };
              yield { type: 'finished', reason: 'stop' };
            }
          }
        },
      }),
    });
    const command = (input: Parameters<typeof makeCommand>[0]) =>
      fetch(`http://127.0.0.1:${app.port}/v1/commands`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(makeCommand(input)),
      });
    try {
      let session = (
        await store.apply(
          makeCommand({
            type: 'create_session',
            sessionId: crypto.randomUUID(),
            title: 'Plan to Build',
            mode: 'plan',
            config,
            projectId: project.id,
            ...(routed ? { routing: { build: { ...config, model: 'builder' } } } : {}),
          }),
        )
      ).session;
      session = (
        await store.apply(
          makeCommand({
            type: 'set_permission_mode',
            sessionId: session.id,
            expectedVersion: session.version,
            mode: 'auto',
          }),
        )
      ).session;
      expect(
        (
          await command({
            type: 'send_message',
            sessionId: session.id,
            expectedVersion: session.version,
            content: 'Investigate file.txt in Plan.',
          })
        ).status,
      ).toBe(200);
      await expect
        .poll(async () => (await store.session(session.id)).run?.status)
        .toBe('completed');
      session = await store.session(session.id);
      const source = session.messages.at(-1)!;
      expect(source.agentMode).toBe('plan');
      expect(await readFile(join(dir, 'file.txt'), 'utf8')).toBe('before PLAN_SOURCE_FACT\n');
      // Reproduce a stored lossy checkpoint that no longer carries the actual tool facts.
      session = (
        await store.apply(
          makeCommand({
            type: 'quick_compact_context',
            sessionId: session.id,
            expectedVersion: session.version,
          }),
          undefined,
          undefined,
          {
            throughMessageId: source.id,
            summary: 'Plan investigation finished; its details were omitted.',
            createdAt: new Date().toISOString(),
            reason: 'manual',
            method: 'fast',
            compactedMessageCount: 2,
            originalEstimateTokens: 10000,
            compactedEstimateTokens: 1000,
          },
        )
      ).session;
      session = (
        await store.apply(
          makeCommand({
            type: 'set_mode',
            sessionId: session.id,
            expectedVersion: session.version,
            mode: 'build',
          }),
        )
      ).session;
      build = true;
      expect(
        (
          await command({
            type: 'send_message',
            sessionId: session.id,
            expectedVersion: session.version,
            content: 'Build using the Plan investigation.',
          })
        ).status,
      ).toBe(200);
      await expect
        .poll(async () => (await store.session(session.id)).run?.status)
        .toBe('completed');
      session = await store.session(session.id);
      expect(session.run?.context?.handoff).toMatchObject({
        sourceMessageId: source.id,
        sourceMode: 'plan',
        includedToolResults: 1,
      });
      expect(session.messages.at(-1)?.agentMode).toBe('build');
      expect(readCalls).toBe(1);
      expect(await readFile(join(dir, 'file.txt'), 'utf8')).toBe('after PLAN_SOURCE_FACT\n');
    } finally {
      await app.close();
      if (dirname(resolve(dir)) !== resolve(tmpdir())) throw Error('unsafe');
      await rm(dir, { recursive: true, force: true });
    }
  },
);
