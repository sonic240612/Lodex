import { expect, it } from 'vitest';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '@lodex/storage';
import { defaultModelConfig, makeCommand } from '@lodex/contracts';
import { digest, inspectProject } from '@lodex/tools';
import { startServer } from './server';

it.each(['stop', 'error'] as const)(
  'preserves large edits and full long-run records when finishing with %s',
  async (finish) => {
    const dir = await mkdtemp(join(tmpdir(), 'lodex-large-run-'));
    const before = 'a'.repeat(40000),
      after = 'b'.repeat(70000),
      reply = 'Long response.\n'.repeat(20000);
    await writeFile(join(dir, 'style.css'), before);
    const store = await Store.open(
      join(dir, 'state.sqlite'),
      resolve('apps/daemon/dist/worker.cjs'),
    );
    const project = await store.registerProject(await inspectProject(dir));
    let calls = 0;
    const token = 'l'.repeat(64);
    const app = await startServer({
      store,
      token,
      providerFactory: () => ({
        listModels: async () => [],
        capabilities: async () => ({ streaming: true, tools: true }),
        generate: async function* (request) {
          if (request.messages[0]?.content.includes('Automatic compaction:')) {
            yield {
              type: 'text_delta',
              text: 'Applied large-edit and large-create. Files are saved; their original results remain available for recall.',
            };
            yield { type: 'finished', reason: 'stop' };
            return;
          }

          if (++calls === 1) {
            yield {
              type: 'tool_call_delta',
              index: 0,
              id: 'large-edit',
              name: 'propose_edit',
              arguments: JSON.stringify({
                path: 'style.css',
                expectedHash: digest(before),
                oldText: before,
                newText: after,
              }),
            };
            yield {
              type: 'tool_call_delta',
              index: 1,
              id: 'large-create',
              name: 'propose_changes',
              arguments: JSON.stringify({
                files: [{ kind: 'create', path: 'new.css', content: 'c'.repeat(80000) }],
              }),
            };
            yield { type: 'finished', reason: 'tool_calls' };
          } else {
            expect(await readFile(join(dir, 'style.css'), 'utf8')).toBe(after);
            expect(await readFile(join(dir, 'new.css'), 'utf8')).toBe('c'.repeat(80000));
            expect(JSON.stringify(request.messages)).toContain('running context checkpoint');
            yield { type: 'text_delta', text: reply };
            if (finish === 'error')
              yield {
                type: 'error',
                code: 'FIXTURE_ERROR',
                message: 'Fixture provider disconnected',
              };
            else yield { type: 'finished', reason: 'stop' };
          }
        },
      }),
    });
    try {
      let session = (
        await store.apply(
          makeCommand({
            type: 'create_session',
            sessionId: crypto.randomUUID(),
            title: 'Large edits',
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
            mode: 'auto',
          }),
        )
      ).session;
      const response = await fetch(`http://127.0.0.1:${app.port}/v1/commands`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(
          makeCommand({
            type: 'send_message',
            sessionId: session.id,
            expectedVersion: session.version,
            content: 'Update the complete CSS block, without deleting the file.',
          }),
        ),
      });
      expect(response.status).toBe(200);
      await expect
        .poll(async () => (await store.session(session.id)).run?.status)
        .toBe(finish === 'stop' ? 'completed' : 'failed');
      session = await store.session(session.id);
      const message = session.messages.at(-1)!;
      expect(message.content).toBe(reply);
      expect(Buffer.byteLength(JSON.stringify(message.activities))).toBeGreaterThan(262144);
      expect(message.activities?.find((activity) => activity.edit)?.edit?.status).toBe('applied');
      expect(message.runContextCompaction?.count).toBeGreaterThan(0);
      expect(calls).toBe(2);
    } finally {
      await app.close();
      if (dirname(resolve(dir)) !== resolve(tmpdir())) throw new Error('unsafe cleanup');
      await rm(dir, { recursive: true, force: true });
    }
  },
);

it('continues after an output-token stop without executing a partial tool call', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lodex-truncated-call-'));
  await writeFile(join(dir, 'file.txt'), 'before');
  const store = await Store.open(join(dir, 'state.sqlite'), resolve('apps/daemon/dist/worker.cjs'));
  const project = await store.registerProject(await inspectProject(dir));
  let calls = 0;
  const token = 'o'.repeat(64);
  const app = await startServer({
    store,
    token,
    providerFactory: () => ({
      listModels: async () => [],
      capabilities: async () => ({ streaming: true, tools: true }),
      generate: async function* () {
        if (++calls === 1) {
          yield {
            type: 'tool_call_delta',
            index: 0,
            id: 'partial',
            name: 'propose_edit',
            arguments: '{"path":"file.txt",',
          };
          yield { type: 'finished', reason: 'length' };
        } else if (calls === 2) {
          expect(await readFile(join(dir, 'file.txt'), 'utf8')).toBe('before');
          yield {
            type: 'tool_call_delta',
            index: 0,
            id: 'complete',
            name: 'propose_edit',
            arguments: JSON.stringify({
              path: 'file.txt',
              expectedHash: digest('before'),
              oldText: 'before',
              newText: 'after',
            }),
          };
          yield { type: 'finished', reason: 'tool_calls' };
        } else {
          yield { type: 'text_delta', text: 'Done.' };
          yield { type: 'finished', reason: 'stop' };
        }
      },
    }),
  });
  try {
    let session = (
      await store.apply(
        makeCommand({
          type: 'create_session',
          sessionId: crypto.randomUUID(),
          title: 'Output continuation',
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
          mode: 'auto',
        }),
      )
    ).session;
    expect(
      (
        await fetch(`http://127.0.0.1:${app.port}/v1/commands`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(
            makeCommand({
              type: 'send_message',
              sessionId: session.id,
              expectedVersion: session.version,
              content: 'Edit the file.',
            }),
          ),
        })
      ).status,
    ).toBe(200);
    await expect.poll(async () => (await store.session(session.id)).run?.status).toBe('completed');
    session = await store.session(session.id);
    expect(session.messages.at(-1)?.activities?.[0]?.status).toBe('cancelled');
    expect(await readFile(join(dir, 'file.txt'), 'utf8')).toBe('after');
    expect(calls).toBe(3);
  } finally {
    await app.close();
    if (dirname(resolve(dir)) !== resolve(tmpdir())) throw new Error('unsafe cleanup');
    await rm(dir, { recursive: true, force: true });
  }
});
