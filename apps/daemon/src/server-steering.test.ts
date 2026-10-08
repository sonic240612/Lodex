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
const untilAborted = (signal: AbortSignal) =>
  new Promise<never>((_resolve, reject) => {
    signal.throwIfAborted();
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
async function fixture(provider: InferenceProvider, webFetcher?: typeof fetch, eco = false) {
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
        config: { ...defaultModelConfig(), provider: 'demo', contextBudgetTokens: 65536, eco },
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
it('interrupts streaming immediately, discards partial tool calls, and applies an idempotent instruction once', async () => {
  const ready = deferred();
  let calls = 0;
  const app = await fixture({
    listModels: async () => [],
    capabilities: async () => ({ tools: true, streaming: true }),
    generate: async function* (request, signal) {
      if (++calls === 1) {
        yield { type: 'text_delta', text: 'Initial response.' };
        yield { type: 'reasoning_delta', text: 'Old direction still being generated.' };
        yield {
          type: 'tool_call_delta',
          index: 0,
          id: 'partial',
          name: 'web_fetch',
          arguments: '{"url":',
        };
        ready.release();
        await new Promise<never>((_resolve, reject) => {
          signal.throwIfAborted();
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
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
    await expect.poll(async () => (await app.store.session(live.id)).run?.status).toBe('completed');
    const final = await app.store.session(live.id);
    expect(final.run!.id).toBe(runId);
    expect(calls).toBe(2);
    const response = final.messages.find((message) => message.id === final.run!.messageId)!;
    expect(response.activities?.find((activity) => activity.label === 'web_fetch')?.status).toBe(
      'cancelled',
    );
    expect(response.activities?.find((activity) => activity.kind === 'thinking')?.status).toBe(
      'interrupted',
    );
    expect(
      response.continuation?.some((message) =>
        message.toolCalls?.some((call) => call.id === 'partial'),
      ),
    ).toBe(false);
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
    await app.close();
  }
});
it('retains the original task and every earlier instruction across successive stream interruptions', async () => {
  const ready = [deferred(), deferred()];
  let calls = 0;
  const app = await fixture({
    listModels: async () => [],
    capabilities: async () => ({ tools: true, streaming: true }),
    async *generate(request, signal) {
      const round = calls++;
      const input = JSON.stringify(request.messages);
      expect(input).toContain('Implement the report export');
      if (round >= 1) expect(input).toContain('Preserve the existing API');
      if (round >= 2) expect(input).toContain('Also include Korean column labels');
      if (round < 2) {
        yield { type: 'text_delta', text: `Working round ${round}.` };
        ready[round]!.release();
        await untilAborted(signal);
      } else {
        yield { type: 'text_delta', text: 'Continued with all three requirements.' };
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
          content: 'Implement the report export',
        })
      ).status,
    ).toBe(200);
    let runId = '';
    for (const [index, content] of [
      'Preserve the existing API',
      'Also include Korean column labels',
    ].entries()) {
      await ready[index]!.promise;
      const session = await app.store.session(app.session.id);
      runId ||= session.run!.id;
      expect(session.run!.id).toBe(runId);
      expect(
        (
          await app.request({
            type: 'steer_run',
            sessionId: session.id,
            runId,
            content,
          })
        ).status,
      ).toBe(200);
    }
    await expect
      .poll(async () => (await app.store.session(app.session.id)).run?.status)
      .toBe('completed');
    const session = await app.store.session(app.session.id);
    expect(calls).toBe(3);
    expect(session.run!.id).toBe(runId);
    expect(
      session.messages.filter((message) => message.runInput?.status === 'included'),
    ).toHaveLength(2);
    const next = JSON.stringify(compileContext(session, 'Continue with tests').request.messages);
    for (const instruction of [
      'Implement the report export',
      'Preserve the existing API',
      'Also include Korean column labels',
    ]) {
      expect(next).toContain(instruction);
    }
  } finally {
    await app.close();
  }
});

it.each([false, true])(
  'interrupts automatic summarization without losing steering (incremental=%s)',
  async (eco) => {
    const ready = deferred();
    let summaries = 0,
      responses = 0;
    const app = await fixture(
      {
        listModels: async () => [],
        capabilities: async () => ({ tools: true, streaming: true }),
        countInputTokens: async (request) =>
          request.messages.some(
            (message) =>
              message.content.includes('Automatic compaction:') ||
              message.content.includes('running context checkpoint') ||
              message.content.includes('NEW REQUIREMENT'),
          )
            ? 5000
            : eco
              ? 12000
              : 60000,
        async *generate(request, signal) {
          if (request.messages[0]?.content.includes('Automatic compaction:')) {
            summaries++;
            yield { type: 'text_delta', text: 'Incomplete summary, not to be saved.' };
            ready.release();
            await untilAborted(signal);
          } else {
            responses++;
            expect(JSON.stringify(request.messages)).toContain('NEW REQUIREMENT');
            expect(JSON.stringify(request.messages)).toContain('Original investigation');
            yield { type: 'text_delta', text: 'Applied the new requirement.' };
            yield { type: 'finished', reason: 'stop' };
          }
        },
      },
      undefined,
      eco,
    );
    try {
      let session = (
        await app.store.apply(
          makeCommand({
            type: 'send_message',
            sessionId: app.session.id,
            expectedVersion: app.session.version,
            content: 'Original investigation' + (eco ? ' verified finding'.repeat(180) : ''),
          }),
        )
      ).session;
      session = await app.store.updateRun({
        sessionId: session.id,
        runId: session.run!.id,
        text: 'Verified findings',
        status: 'completed',
      });
      await app.request({
        type: 'send_message',
        sessionId: session.id,
        expectedVersion: session.version,
        content: 'Continue',
      });
      await ready.promise;
      session = await app.store.session(session.id);
      expect(
        (
          await app.request({
            type: 'steer_run',
            sessionId: session.id,
            runId: session.run!.id,
            content: 'NEW REQUIREMENT: preserve the public API.',
          })
        ).status,
      ).toBe(200);
      await expect
        .poll(async () => (await app.store.session(session.id)).run?.status)
        .toBe('completed');
      session = await app.store.session(session.id);
      const response = session.messages.find((message) => message.id === session.run!.messageId)!;
      expect(response.runContextCompaction).toBeUndefined();
      expect(
        response.activities?.find(
          (activity) => activity.label === (eco ? 'Eco 자동 요약' : '컨텍스트 자동 LLM 압축'),
        )?.status,
      ).toBe('interrupted');
      expect(summaries).toBe(1);
      expect(responses).toBe(1);
    } finally {
      await app.close();
    }
  },
);

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
