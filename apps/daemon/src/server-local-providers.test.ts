import { afterEach, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { makeCommand, modelConfigSchema, type Session } from '@lodex/contracts';
import { Store } from '@lodex/storage';
import { startServer } from './server';
import { waitForCompletedRun } from './test-helpers';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

it.each(['ollama', 'vllm', 'mlx'] as const)(
  'connects %s through the authenticated catalog, saved session and real HTTP adapter',
  async (provider) => {
    const paths: string[] = [],
      bodies: Record<string, unknown>[] = [];
    const fixture = createServer((request, response) => {
      paths.push(request.url!);
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        if (chunks.length) bodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        response.setHeader('content-type', 'application/json');
        if (request.url === '/api/tags')
          response.end(JSON.stringify({ models: [{ name: 'fixture' }] }));
        else if (request.url === '/api/show')
          response.end(
            JSON.stringify({
              capabilities: ['completion', 'tools'],
              model_info: { 'general.architecture': 'llama', 'llama.context_length': 32768 },
            }),
          );
        else if (request.url === '/api/chat') {
          response.setHeader('content-type', 'application/x-ndjson');
          response.end(
            JSON.stringify({
              message: { content: 'native result' },
              done: true,
              done_reason: 'stop',
              prompt_eval_count: 30,
              eval_count: 4,
            }) + '\n',
          );
        } else if (request.url === '/v1/models')
          response.end(JSON.stringify({ data: [{ id: 'fixture', max_model_len: 32768 }] }));
        else if (request.url === '/tokenize')
          response.end(JSON.stringify({ count: 100, tokens: [], max_model_len: 32768 }));
        else if (request.url === '/v1/chat/completions') {
          response.setHeader('content-type', 'text/event-stream');
          response.end(
            'data: {"choices":[{"delta":{"content":"compatible result"},"finish_reason":"stop"}]}\n\ndata: {"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":4}}\n\ndata: [DONE]\n\n',
          );
        } else {
          response.statusCode = 404;
          response.end('{}');
        }
      });
    });
    await new Promise<void>((resolve) => fixture.listen(0, '127.0.0.1', resolve));
    cleanup.push(
      () =>
        new Promise((resolve) => {
          fixture.close(() => resolve());
          fixture.closeAllConnections();
        }),
    );
    const address = fixture.address();
    if (!address || typeof address === 'string') throw new Error('Missing fixture address');
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const directory = await mkdtemp(join(tmpdir(), 'lodex-local-provider-'));
    cleanup.push(async () => {
      if (dirname(resolve(directory)) !== resolve(tmpdir()))
        throw new Error('Unsafe fixture cleanup');
      await rm(directory, { recursive: true, force: true });
    });
    const store = await Store.open(
      join(directory, 'state.sqlite'),
      resolve('apps/daemon/dist/worker.cjs'),
    );
    const token = 'p'.repeat(64),
      app = await startServer({ store, token });
    cleanup.push(() => app.close());
    const api = (path: string, body?: unknown) =>
      fetch(`http://127.0.0.1:${app.port}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    const catalog = await api('/v1/models?' + new URLSearchParams({ provider, baseUrl }));
    expect(catalog.status).toBe(200);
    expect((await catalog.json()).models).toMatchObject([{ id: 'fixture' }]);
    const config = modelConfigSchema.parse({
      provider,
      baseUrl,
      model: 'fixture',
      keepAliveSeconds: 0,
    });
    const created = await api(
      '/v1/commands',
      makeCommand({
        type: 'create_session',
        sessionId: crypto.randomUUID(),
        title: provider,
        config,
        projectId: null,
      }),
    );
    expect(created.status).toBe(200);
    const session = (await created.json()).session as Session;
    const sent = await api(
      '/v1/commands',
      makeCommand({
        type: 'send_message',
        sessionId: session.id,
        expectedVersion: session.version,
        content: 'Hello',
      }),
    );
    expect(sent.status).toBe(200);
    await waitForCompletedRun(store, session.id);
    const completed = await store.session(session.id);
    expect(completed.run?.status).toBe('completed');
    expect(completed.messages.at(-1)?.content).toContain(
      provider === 'ollama' ? 'native result' : 'compatible result',
    );
    expect(completed.config).toMatchObject({
      provider,
      baseUrl: config.baseUrl,
      keepAliveSeconds: 0,
    });
    expect(paths).not.toContain('/props');
    expect(
      paths.some((path) => path === (provider === 'ollama' ? '/api/chat' : '/v1/chat/completions')),
    ).toBe(true);
    if (provider === 'vllm')
      expect(completed.run?.context?.tokenCountSource).toBe('vllm_chat_template');
    const chat = bodies.find((body) => body.stream === true);
    expect(chat).toBeDefined();
    if (provider === 'ollama')
      expect(chat).toMatchObject({ keep_alive: 0, truncate: false, shift: false });
    const raw = await api(
      '/v1/models?' + new URLSearchParams({ provider, baseUrl: 'https://example.com/v1' }),
    );
    expect(raw.status).toBe(400);
  },
);
