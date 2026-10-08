import { describe, expect, it, vi } from 'vitest';
import { modelConfigSchema, type InferenceEvent, type InferenceRequest } from '@lodex/contracts';
import { OllamaProvider } from './ollama';

const signal = () => new AbortController().signal;
const details = {
  capabilities: ['completion', 'tools', 'thinking'],
  model_info: { 'general.architecture': 'qwen3', 'qwen3.context_length': 32768 },
  parameters: 'temperature 0.6\ntop_p 0.95\nnum_ctx 8192\nnum_predict 4096',
};
const tool = {
  type: 'function' as const,
  function: {
    name: 'read_file',
    description: 'Read a file',
    parameters: { type: 'object', properties: { path: { type: 'string' } } },
  },
};
const request = (): InferenceRequest => ({
  config: modelConfigSchema.parse({
    provider: 'ollama',
    model: 'fixture:latest',
    keepAliveSeconds: 0,
    contextBudgetTokens: 8192,
    maxTokens: 1000,
  }),
  messages: [{ role: 'user', content: '안녕하세요' }],
});
async function collect(iter: AsyncIterable<InferenceEvent>) {
  const events: InferenceEvent[] = [];
  for await (const event of iter) events.push(event);
  return events;
}
function ndjson(chunks: unknown[]) {
  const bytes = new TextEncoder().encode(
    chunks.map((chunk) => JSON.stringify(chunk)).join('\n') + '\n',
  );
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < bytes.length; i += 3) controller.enqueue(bytes.slice(i, i + 3));
        controller.close();
      },
    }),
    { headers: { 'content-type': 'application/x-ndjson' } },
  );
}
const completed = () => ndjson([{ message: { content: '완료' }, done: true, done_reason: 'stop' }]);

describe('Ollama native adapter', () => {
  it('loads local model capabilities and configured context limits without llama endpoints', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          models: [
            { name: 'fixture:latest' },
            { name: 'remote:cloud' },
            { name: 'secret-alias', remote_host: 'https://example.com' },
          ],
        }),
      )
      .mockResolvedValueOnce(Response.json(details));
    const adapter = new OllamaProvider('http://100.64.1.2:11434/api', fetcher);
    expect(await adapter.listModels()).toEqual([
      {
        id: 'fixture:latest',
        name: 'fixture:latest',
        contextLength: 8192,
        maxCompletionTokens: 4096,
        defaultTemperature: 0.6,
        defaultTopP: 0.95,
        tools: true,
        pricing: null,
      },
    ]);
    expect(await adapter.capabilities('fixture:latest')).toEqual({ tools: true, streaming: true });
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      'http://100.64.1.2:11434/api/tags',
      'http://100.64.1.2:11434/api/show',
    ]);
    expect(
      fetcher.mock.calls.every(
        ([, init]) => init?.redirect === 'error' && !new Headers(init.headers).has('authorization'),
      ),
    ).toBe(true);
    expect(await adapter.countInputTokens(request(), signal())).toBeNull();
  });

  it('streams split Unicode, separates thinking and reports engine token timings', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(details))
      .mockResolvedValueOnce(
        ndjson([
          { message: { thinking: '살펴보겠습니다.' }, done: false },
          { message: { content: '<think>살펴보겠습니다.</think>안녕 😀' }, done: false },
          {
            done: true,
            done_reason: 'stop',
            prompt_eval_count: 120,
            prompt_eval_cached_count: 20,
            prompt_eval_duration: 500000000,
            eval_count: 40,
            eval_duration: 2000000000,
          },
        ]),
      );
    const input = request();
    input.stopSequences = ['끝'];
    const events = await collect(
      new OllamaProvider(input.config.baseUrl, fetcher).generate(input, signal()),
    );
    expect(events.filter((event) => event.type === 'reasoning_delta')).toEqual([
      { type: 'reasoning_delta', text: '살펴보겠습니다.' },
    ]);
    expect(
      events
        .filter((event) => event.type === 'text_delta')
        .map((event) => event.text)
        .join(''),
    ).toBe('안녕 😀');
    expect(events).toContainEqual({
      type: 'usage',
      usage: {
        inputTokens: 120,
        outputTokens: 40,
        prefillTps: { value: 200, source: 'engine_reported' },
        decodeTps: { value: 20, source: 'engine_reported' },
      },
    });
    expect(events.at(-1)).toEqual({ type: 'finished', reason: 'stop' });
    expect(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body))).toMatchObject({
      stream: true,
      truncate: false,
      shift: false,
      keep_alive: 0,
      options: { num_ctx: 8192, num_predict: 1000, stop: ['끝'] },
    });
    const body = JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body));
    expect(body.options).not.toHaveProperty('temperature');
    expect(body.options).not.toHaveProperty('top_p');
    expect(body).not.toHaveProperty('think');
  });

  it('translates native tool objects and replays tool names, IDs and thinking', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(details))
      .mockResolvedValueOnce(
        ndjson([
          {
            message: {
              tool_calls: [{ function: { name: 'read_file', arguments: { path: '가.txt' } } }],
            },
            done: false,
          },
          {
            message: {
              tool_calls: [
                { id: 'server-id', function: { name: 'read_file', arguments: { path: '나.txt' } } },
              ],
            },
            done: false,
          },
          { done: true, done_reason: 'stop' },
        ]),
      );
    const input = request();
    input.tools = [tool];
    input.messages.push(
      {
        role: 'assistant',
        content: '',
        reasoningContent: 'existing thought',
        toolCalls: [{ id: 'before', name: 'read_file', arguments: '{"path":"a.txt"}' }],
      },
      { role: 'tool', content: 'file contents', toolCallId: 'before' },
    );
    const events = await collect(
      new OllamaProvider(input.config.baseUrl, fetcher).generate(input, signal()),
    );
    const calls = events.filter((event) => event.type === 'tool_call_delta');
    expect(calls).toEqual([
      {
        type: 'tool_call_delta',
        index: 0,
        id: expect.any(String),
        name: 'read_file',
        arguments: '{"path":"가.txt"}',
      },
      {
        type: 'tool_call_delta',
        index: 1,
        id: 'server-id',
        name: 'read_file',
        arguments: '{"path":"나.txt"}',
      },
    ]);
    expect(events.at(-1)).toEqual({ type: 'finished', reason: 'tool_calls' });
    expect(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body))).toMatchObject({
      tools: [tool],
      messages: [
        input.messages[0],
        {
          role: 'assistant',
          thinking: 'existing thought',
          tool_calls: [
            { id: 'before', function: { name: 'read_file', arguments: { path: 'a.txt' } } },
          ],
        },
        { role: 'tool', tool_call_id: 'before', tool_name: 'read_file' },
      ],
    });
  });

  it('maps explicit sampling controls and summary thinking separately', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(details))
      .mockResolvedValueOnce(completed());
    const input = request();
    input.purpose = 'context_summary';
    input.config = {
      ...input.config,
      useDefaultTemperature: false,
      temperature: 0.2,
      useDefaultTopP: false,
      topP: 0.8,
    };
    await collect(new OllamaProvider(input.config.baseUrl, fetcher).generate(input, signal()));
    expect(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body))).toMatchObject({
      think: false,
      options: { temperature: 0.2, top_p: 0.8 },
    });
  });

  it('never sends an inference request for a cloud alias or unsupported tool model', async () => {
    for (const meta of [
      { ...details, remote_host: 'https://ollama.com', remote_model: 'private' },
      { ...details, capabilities: ['completion'] },
    ]) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(meta));
      await expect(
        collect(
          new OllamaProvider(request().config.baseUrl, fetcher).generate(
            { ...request(), tools: [tool] },
            signal(),
          ),
        ),
      ).rejects.toThrow(/로컬 모델|도구 호출/);
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
  });

  it('does not claim unsupported required tool choice and enforces none', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(details))
      .mockResolvedValueOnce(
        ndjson([
          {
            message: { tool_calls: [{ function: { name: 'read_file', arguments: {} } }] },
            done: true,
          },
        ]),
      );
    const adapter = new OllamaProvider(request().config.baseUrl, fetcher);
    await expect(
      collect(adapter.generate({ ...request(), tools: [tool], toolChoice: 'required' }, signal())),
    ).rejects.toThrow('필수 도구 선택');
    expect(fetcher).toHaveBeenCalledTimes(1);
    await expect(
      collect(adapter.generate({ ...request(), tools: [tool], toolChoice: 'none' }, signal())),
    ).rejects.toThrow('도구가 허용되지 않은');
    expect(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body))).not.toHaveProperty('tools');
  });

  it('retries an initial rate limit only three times with 2/5/7 second delays', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(details))
      .mockImplementation(async () => new Response('', { status: 429 }));
    const wait = vi.fn(async (_milliseconds: number, _signal: AbortSignal) => {});
    await expect(
      collect(
        new OllamaProvider(request().config.baseUrl, fetcher, wait).generate(request(), signal()),
      ),
    ).rejects.toThrow('HTTP 429');
    expect(fetcher).toHaveBeenCalledTimes(5);
    expect(wait.mock.calls.map((call) => call[0])).toEqual([2000, 5000, 7000]);
  });

  it('does not replay partial streams or malformed tool arguments', async () => {
    for (const chunks of [
      [{ message: { content: 'partial' }, done: false }],
      [
        {
          message: {
            tool_calls: [{ function: { name: 'read_file', arguments: 'not an object' } }],
          },
          done: true,
        },
      ],
      [{ error: 'server private logs' }],
    ]) {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(Response.json(details))
        .mockResolvedValueOnce(ndjson(chunks));
      await expect(
        collect(
          new OllamaProvider(request().config.baseUrl, fetcher).generate(
            { ...request(), tools: [tool] },
            signal(),
          ),
        ),
      ).rejects.toThrow();
      expect(fetcher).toHaveBeenCalledTimes(2);
    }
  });

  it('cancels a stalled native stream promptly and does not retry', async () => {
    const cancelled = vi.fn();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(details))
      .mockResolvedValueOnce(new Response(new ReadableStream({ cancel: cancelled })));
    const controller = new AbortController();
    const iterator = new OllamaProvider(request().config.baseUrl, fetcher).generate(
      request(),
      controller.signal,
    );
    expect((await iterator.next()).value).toEqual({ type: 'started' });
    const pending = iterator.next();
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    controller.abort(new Error('stop native generation'));
    await expect(pending).rejects.toThrow('stop native generation');
    expect(cancelled).toHaveBeenCalledOnce();
  });

  it('rejects malformed metadata and unbounded stream events', async () => {
    const metadata = vi.fn<typeof fetch>().mockResolvedValue(Response.json([]));
    await expect(
      new OllamaProvider(request().config.baseUrl, metadata).listModels(),
    ).rejects.toThrow('모델 정보 형식');
    const stream = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(details))
      .mockResolvedValueOnce(new Response('x'.repeat(1_048_577)));
    await expect(
      collect(new OllamaProvider(request().config.baseUrl, stream).generate(request(), signal())),
    ).rejects.toThrow('이벤트 크기');
  });
});
