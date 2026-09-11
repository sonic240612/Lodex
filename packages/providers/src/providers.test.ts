import { describe, expect, it, vi } from 'vitest';
import { defaultModelConfig, type InferenceEvent, type InferenceRequest } from '@lodex/contracts';
import { ChatCompletionProvider, decodeSse } from './index';
const signal = () => new AbortController().signal;
function stream(text: string, chunkSize = 1): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({
    start(controller) {
      for (let i = 0; i < bytes.length; i += chunkSize)
        controller.enqueue(bytes.slice(i, i + chunkSize));
      controller.close();
    },
  });
}
const response = (text: string) =>
  new Response(stream(text), { headers: { 'Content-Type': 'text/event-stream' } });
const data = (value: unknown) => 'data: ' + JSON.stringify(value) + '\n\n';
async function collect<T>(generator: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of generator) values.push(value);
  return values;
}
const request = () => ({
  config: { ...defaultModelConfig(), model: 'fixture' },
  messages: [{ role: 'user' as const, content: '안녕' }],
});
describe('SSE protocol', () => {
  it('decodes split UTF-8, CRLF, bare CR, comments and multiline data', async () => {
    const events = await collect(
      decodeSse(
        stream(': keepalive\r\nid: 4\r\ndata: 안녕 😀\r\ndata: 두 번째\r\n\r\ndata: next\r\r'),
        signal(),
      ),
    );
    expect(events).toEqual([
      { data: '안녕 😀\n두 번째', event: 'message', id: '4' },
      { data: 'next', event: 'message', id: '4' },
    ]);
  });
  it('does not emit unterminated partial events at EOF', async () => {
    expect(await collect(decodeSse(stream('data: incomplete'), signal()))).toEqual([]);
  });
  it('cancels a stalled stream promptly', async () => {
    const abort = new AbortController();
    const body = new ReadableStream<Uint8Array>({});
    const pending = collect(decodeSse(body, abort.signal));
    abort.abort(new Error('stop'));
    await expect(pending).rejects.toThrow('stop');
  });
});
describe('provider adapters', () => {
  it('separates structured thinking and preserves tool/reasoning wire fields', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        response(
          data({
            choices: [{ delta: { reasoning_content: '생각', content: '<think>생각</think>답변' } }],
          }) +
            data({ choices: [{ delta: {}, finish_reason: 'stop' }] }) +
            'data: [DONE]\n\n',
        ),
      );
    const input: InferenceRequest = {
      config: { ...defaultModelConfig(), model: 'fixture' },
      messages: [
        {
          role: 'assistant',
          content: '',
          reasoningContent: 'prior',
          toolCalls: [{ id: 'c1', name: 'read_file', arguments: '{}' }],
        },
        { role: 'tool', toolCallId: 'c1', content: 'result' },
      ],
      tools: [
        {
          type: 'function',
          function: { name: 'read_file', description: 'read', parameters: { type: 'object' } },
        },
      ],
    };
    const events = await collect(
      new ChatCompletionProvider(
        'llama-server',
        'http://localhost:8080/v1',
        null,
        fetcher,
      ).generate(input, signal()),
    );
    expect(events.filter((e) => e.type === 'reasoning_delta')).toEqual([
      { type: 'reasoning_delta', text: '생각' },
    ]);
    expect(events.filter((e) => e.type === 'text_delta')).toEqual([
      { type: 'text_delta', text: '답변' },
    ]);
    const body = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body));
    expect(body.messages[0]).toMatchObject({
      reasoning_content: 'prior',
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file' } }],
    });
    expect(body.messages[1].tool_call_id).toBe('c1');
    expect(body.tools).toEqual(input.tools);
  });
  it('sends compiled messages unchanged, with no extra unbudgeted Eco prompt', async () => {
    const input: InferenceRequest = {
      config: { ...defaultModelConfig(), model: 'fixture', eco: true },
      messages: [
        { role: 'system', content: 'compiled eco instruction' },
        { role: 'user', content: 'hello' },
      ],
    };
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        response(data({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + 'data: [DONE]\n\n'),
      );
    await collect(
      new ChatCompletionProvider(
        'llama-server',
        'http://localhost:8080/v1',
        null,
        fetcher,
      ).generate(input, signal()),
    );
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)).messages).toEqual(input.messages);
  });
  it('decodes content, engine timings and usage without estimating unknown values', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      response(
        data({ choices: [{ delta: { content: '안녕' }, finish_reason: null }] }) +
          data({
            choices: [{ delta: {}, finish_reason: 'stop' }],
            usage: { prompt_tokens: 20, completion_tokens: 5 },
            timings: { predicted_per_second: 30, prompt_per_second: 200 },
          }) +
          'data: [DONE]\n\n',
      ),
    );
    const provider = new ChatCompletionProvider(
      'llama-server',
      'http://127.0.0.1:8080/v1',
      null,
      fetcher,
    );
    const events = await collect(provider.generate(request(), signal()));
    expect(events).toContainEqual({ type: 'text_delta', text: '안녕' });
    expect(events).toContainEqual({ type: 'finished', reason: 'stop' });
    expect(events).toContainEqual({
      type: 'usage',
      usage: {
        inputTokens: 20,
        outputTokens: 5,
        decodeTps: { value: 30, source: 'engine_reported' },
        prefillTps: { value: 200, source: 'engine_reported' },
      },
    });
    expect(events.some((event) => event.type === 'usage' && 'costUsd' in event.usage)).toBe(false);
  });
  it('uses the fixed OpenRouter host, strict provider policy, and handles final usage', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      response(
        ': OPENROUTER PROCESSING\n\n' +
          data({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }) +
          data({
            choices: [],
            usage: {
              prompt_tokens: 10,
              completion_tokens: 2,
              cost: 0.000003,
              cost_details: { upstream_inference_cost: 99 },
            },
          }) +
          'data: [DONE]\n\n',
      ),
    );
    const provider = new ChatCompletionProvider(
      'openrouter',
      'https://untrusted.example',
      'fixture-secret',
      fetcher,
    );
    const events = await collect(
      provider.generate(
        { ...request(), config: { ...request().config, provider: 'openrouter' } },
        signal(),
      ),
    );
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
    const body = JSON.parse(String(init?.body));
    expect(body.provider).toEqual({
      require_parameters: true,
      data_collection: 'deny',
      allow_fallbacks: false,
    });
    expect(body).not.toHaveProperty('stream_options');
    expect(init?.redirect).toBe('error');
    expect(events).toContainEqual({
      type: 'usage',
      usage: { inputTokens: 10, outputTokens: 2, costUsd: 0.000003, billing: 'reported' },
    });
  });
  it('exposes split tool deltas without executing them', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      response(
        data({
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, id: 'call_1', function: { name: 'read_file', arguments: '{"pa' } },
                ],
              },
            },
          ],
        }) +
          data({
            choices: [
              {
                delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"a"}' } }] },
                finish_reason: 'tool_calls',
              },
            ],
          }) +
          'data: [DONE]\n\n',
      ),
    );
    const events = await collect(
      new ChatCompletionProvider(
        'llama-server',
        'http://localhost:8080/v1',
        null,
        fetcher,
      ).generate(request(), signal()),
    );
    expect(events.filter((e) => e.type === 'tool_call_delta')).toHaveLength(2);
    expect(events.at(-1)).toEqual({ type: 'finished', reason: 'tool_calls' });
  });
  it.each([
    ['missing DONE', data({ choices: [{ delta: { content: 'partial' }, finish_reason: 'stop' }] })],
    ['mid-stream error', data({ error: { message: 'raw private detail' } })],
    ['malformed JSON', 'data: {broken}\n\n'],
    ['missing finish reason', 'data: [DONE]\n\n'],
  ])('rejects %s and never yields success', async (_name, text) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(text));
    const events: InferenceEvent[] = [];
    await expect(
      (async () => {
        for await (const event of new ChatCompletionProvider(
          'llama-server',
          'http://localhost:8080/v1',
          null,
          fetcher,
        ).generate(request(), signal()))
          events.push(event);
      })(),
    ).rejects.toThrow();
    expect(events.some((event) => event.type === 'finished')).toBe(false);
    expect(JSON.stringify(events)).not.toContain('raw private detail');
  });
  it('does not expose HTTP error response bodies or credentials', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('secret internal error', { status: 401 }));
    await expect(
      collect(
        new ChatCompletionProvider('openrouter', '', 'fixture-secret', fetcher).generate(
          request(),
          signal(),
        ),
      ),
    ).rejects.toThrow('HTTP 401');
  });
  it('preserves unknown model capability values', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify({ data: [{ id: 'local.gguf' }] })));
    const descriptors = await new ChatCompletionProvider(
      'llama-server',
      'http://localhost:8080/v1',
      null,
      fetcher,
    ).listModels();
    expect(descriptors[0]).toMatchObject({ contextLength: null, tools: null });
  });
});
