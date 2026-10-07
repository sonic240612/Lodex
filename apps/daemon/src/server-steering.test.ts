import { expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '@lodex/storage';
import { defaultModelConfig, makeCommand, type InferenceProvider } from '@lodex/contracts';
import { compileContext } from '@lodex/context';
import { startServer } from './server';
const deferred = () => {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
};
async function fixture(provider: InferenceProvider, webFetcher?: typeof fetch) {
  const dir = await mkdtemp(join(tmpdir(), 'lodex-steering-'));
  const store = await Store.open(join(dir, 'state.sqlite'), resolve('apps/daemon/dist/worker.cjs'));
  const token = 's'.repeat(64),
    app = await startServer({
      store,
      token,
      providerFactory: () => provider,
      ...(webFetcher ? { webFetcher } : {}),
    });
  const request = (command: Parameters<typeof makeCommand>[0] | ReturnType<typeof makeCommand>) =>
    fetch(`http://127.0.0.1:${app.port}/v1/commands`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify('commandId' in command ? command : makeCommand(command)),
    });
  let session = (
    await store.apply(
      makeCommand({
        type: 'create_session',
        title: 'live input',
        sessionId: crypto.randomUUID(),
        mode: 'plan',
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
  return {
    store,
    session,
    request,
    close: async () => {
      await app.close();
      if (dirname(resolve(dir)) !== resolve(tmpdir())) throw Error('unsafe');
      await rm(dir, { recursive: true, force: true });
    },
  };
}
it('queues an idempotent instruction during streaming, continues the same run and does not duplicate it in later context', async () => {
  const gate = deferred(),
    ready = deferred();
  let calls = 0;
  const app = await fixture({
    listModels: async () => [],
    capabilities: async () => ({ tools: true, streaming: true }),
    generate: async function* (request) {
      if (++calls === 1) {
        yield { type: 'text_delta', text: 'Initial response.' };
        ready.release();
        await gate.promise;
        yield { type: 'finished', reason: 'stop' };
      } else {
        expect(request.messages.at(-1)?.content).toContain('Keep the result concise.');
        expect(request.tools?.some((tool) => tool.function.name === 'run_host_command')).toBe(
          false,
        );
        yield { type: 'text_delta', text: 'Followed the added instruction.' };
        yield { type: 'finished', reason: 'stop' };
      }
    },
  });
  try {
    expect(
      (
        await app.request({
          type: 'send_message',
          sessionId: app.session.id,
          expectedVersion: app.session.version,
          content: 'Start working',
        })
      ).status,
    ).toBe(200);
    await ready.promise;
    const live = await app.store.session(app.session.id),
      runId = live.run!.id;
    const command = makeCommand({
      type: 'steer_run',
      sessionId: live.id,
      runId,
      content: 'Keep the result concise.',
    });
    expect((await app.request(command)).status).toBe(200);
    expect((await (await app.request(command)).json()).replayed).toBe(true);
    expect(
      (await app.store.session(live.id)).messages
        .filter((message) => message.runInput)
        .map((message) => message.runInput!.status),
    ).toEqual(['queued']);
    gate.release();
    await expect.poll(async () => (await app.store.session(live.id)).run?.status).toBe('completed');
    const final = await app.store.session(live.id);
    expect(final.run!.id).toBe(runId);
    expect(calls).toBe(2);
    expect(final.messages.find((message) => message.runInput)?.runInput).toMatchObject({
      status: 'included',
      actor: 'desktop',
    });
    const next = compileContext(final, 'Next request');
    expect(
      next.request.messages.filter((message) =>
        message.content.includes('Keep the result concise.'),
      ),
    ).toHaveLength(1);
    expect(
      (await app.request({ type: 'steer_run', sessionId: live.id, runId, content: 'Too late' }))
        .status,
    ).toBe(409);
  } finally {
    gate.release();
    await app.close();
  }
});
it('finishes the active tool, skips the rest of its batch and applies live input before choosing further actions', async () => {
  const gate = deferred(),
    ready = deferred();
  let calls = 0,
    fetches = 0;
  const app = await fixture(
    {
      listModels: async () => [],
      capabilities: async () => ({ tools: true, streaming: true }),
      generate: async function* (request) {
        if (++calls === 1) {
          for (const [index, id] of ['first', 'second'].entries())
            yield {
              type: 'tool_call_delta',
              index,
              id,
              name: 'web_fetch',
              arguments: JSON.stringify({ url: `https://example.com/${id}` }),
            };
          yield { type: 'finished', reason: 'tool_calls' };
        } else {
          expect(request.messages.find((message) => message.toolCallId === 'second')).toMatchObject(
            { isError: true },
          );
          expect(request.messages.at(-1)?.content).toContain('Do not fetch another page.');
          yield { type: 'text_delta', text: 'Stopped after the first page.' };
          yield { type: 'finished', reason: 'stop' };
        }
      },
    },
    async () => {
      fetches++;
      ready.release();
      await gate.promise;
      return new Response('page', { headers: { 'Content-Type': 'text/plain' } });
    },
  );
  try {
    await app.request({
      type: 'send_message',
      sessionId: app.session.id,
      expectedVersion: app.session.version,
      content: 'Read two pages',
    });
    await ready.promise;
    const live = await app.store.session(app.session.id);
    expect(
      (
        await app.request({
          type: 'steer_run',
          sessionId: live.id,
          runId: live.run!.id,
          content: 'Do not fetch another page.',
        })
      ).status,
    ).toBe(200);
    gate.release();
    await expect.poll(async () => (await app.store.session(live.id)).run?.status).toBe('completed');
    expect(fetches).toBe(1);
    expect(calls).toBe(2);
  } finally {
    gate.release();
    await app.close();
  }
});
it('defers completion atomically for queued input and retains unconsumed input after cancellation/recovery', async () => {
  const app = await fixture({
    listModels: async () => [],
    capabilities: async () => ({ tools: false, streaming: true }),
    generate: async function* () {
      yield { type: 'finished', reason: 'stop' };
    },
  });
  try {
    let live = (
      await app.store.apply(
        makeCommand({
          type: 'send_message',
          sessionId: app.session.id,
          expectedVersion: app.session.version,
          content: 'fixture run',
        }),
      )
    ).session;
    await app.store.apply(
      makeCommand({
        type: 'steer_run',
        sessionId: live.id,
        runId: live.run!.id,
        content: 'pending instruction',
      }),
    );
    live = await app.store.updateRun({
      sessionId: live.id,
      runId: live.run!.id,
      text: 'finished',
      status: 'completed',
    });
    expect(live.run?.status).toBe('running');
    live = await app.store.updateRun({
      sessionId: live.id,
      runId: live.run!.id,
      status: 'interrupted',
    });
    expect(live.messages.at(-1)?.runInput?.status).toBe('interrupted');
    expect(live.messages.at(-1)?.content).toBe('pending instruction');
    const next = compileContext(live, 'next');
    expect(
      next.request.messages.some((message) => message.content.includes('pending instruction')),
    ).toBe(true);
  } finally {
    await app.close();
  }
});
