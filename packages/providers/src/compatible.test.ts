import { describe, expect, it, vi } from 'vitest';
import { modelConfigSchema, type InferenceEvent, type InferenceRequest } from '@lodex/contracts';
import { ChatCompletionProvider, createInferenceProvider, OllamaProvider } from './index';

const signal = () => new AbortController().signal;
const tools = [
  {
    type: 'function' as const,
    function: { name: 'read_file', description: 'Read', parameters: { type: 'object' } },
  },
];
const input = (provider: 'vllm' | 'mlx'): InferenceRequest => ({
  config: modelConfigSchema.parse({ provider, model: 'fixture' }),
  messages: [
    { role: 'system', content: 'follow instructions' },
    { role: 'user', content: '안녕' },
  ],
  tools,
  stopSequences: ['<end>'],
});
const stream = () =>
  new Response(
    [
      { choices: [{ delta: { reasoning: 'checking' } }] },
      { choices: [{ delta: { content: '안녕' } }] },
      {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'tool-1',
                  function: { name: 'read_file', arguments: '{"path":"a"}' },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      },
      { choices: [], usage: { prompt_tokens: 61, completion_tokens: 12 } },
    ]
      .map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`)
      .join('') + 'data: [DONE]\n\n',
    { headers: { 'content-type': 'text/event-stream' } },
  );
async function collect(iter: AsyncIterable<InferenceEvent>) {
  const events: InferenceEvent[] = [];
  for await (const event of iter) events.push(event);
  return events;
}

describe('external OpenAI-compatible local adapters', () => {
  it.each(['vllm', 'mlx'] as const)(
    '%s streams usage/reasoning/tool calls without llama /props',
    async (kind) => {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(Response.json({ data: [{ id: 'fixture', max_model_len: 65536 }] }))
        .mockResolvedValueOnce(stream());
      const request = input(kind);
      const adapter = new ChatCompletionProvider(kind, request.config.baseUrl, null, fetcher);
      expect(await adapter.listModels()).toMatchObject([
        {
          id: 'fixture',
          contextLength: kind === 'vllm' ? 65536 : null,
          tools: null,
          pricing: null,
        },
      ]);
      const events = await collect(adapter.generate(request, signal()));
      expect(events).toContainEqual({ type: 'reasoning_delta', text: 'checking' });
      expect(events).toContainEqual({ type: 'text_delta', text: '안녕' });
      expect(events).toContainEqual({
        type: 'tool_call_delta',
        index: 0,
        id: 'tool-1',
        name: 'read_file',
        arguments: '{"path":"a"}',
      });
      expect(events).toContainEqual({
        type: 'usage',
        usage: { inputTokens: 61, outputTokens: 12 },
      });
      expect(events.at(-1)).toEqual({ type: 'finished', reason: 'tool_calls' });
      expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
        request.config.baseUrl + '/models',
        request.config.baseUrl + '/chat/completions',
      ]);
      expect(
        fetcher.mock.calls.every(
          ([, init]) =>
            init?.redirect === 'error' && !new Headers(init.headers).has('authorization'),
        ),
      ).toBe(true);
      const body = JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body));
      expect(body).toMatchObject({
        messages: request.messages,
        tools,
        tool_choice: 'auto',
        stop: ['<end>'],
        stream_options: { include_usage: true },
      });
      expect(body).not.toHaveProperty('temperature');
      expect(body).not.toHaveProperty('top_p');
      expect(body).not.toHaveProperty('parallel_tool_calls');
    },
  );

  it('counts the complete vLLM chat template at the server root without generating', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ count: 127, tokens: [], max_model_len: 32768 }));
    const request = input('vllm');
    request.config.baseUrl = 'https://gpu.tailnet.ts.net/proxy/v1';
    request.messages.push(
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'one', name: 'read_file', arguments: '{}' }],
      },
      { role: 'tool', content: 'result', toolCallId: 'one' },
    );
    const adapter = new ChatCompletionProvider('vllm', request.config.baseUrl, null, fetcher);
    expect(await adapter.countInputTokens(request, signal())).toBe(127);
    expect(fetcher.mock.calls[0]?.[0]).toBe('https://gpu.tailnet.ts.net/proxy/tokenize');
    const body = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body));
    expect(body).toMatchObject({
      model: 'fixture',
      add_generation_prompt: true,
      tools,
      messages: [
        request.messages[0],
        request.messages[1],
        {
          role: 'assistant',
          tool_calls: [
            { id: 'one', type: 'function', function: { name: 'read_file', arguments: '{}' } },
          ],
        },
        { role: 'tool', tool_call_id: 'one' },
      ],
    });
  });

  it('uses an estimate when tokenizer support is absent but surfaces invalid/error counts', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('', { status: 404 }))
      .mockResolvedValueOnce(Response.json({ count: 1.5 }))
      .mockResolvedValueOnce(new Response('', { status: 500 }));
    const request = input('vllm'),
      adapter = new ChatCompletionProvider('vllm', request.config.baseUrl, null, fetcher);
    expect(await adapter.countInputTokens(request, signal())).toBeNull();
    await expect(adapter.countInputTokens(request, signal())).rejects.toThrow('계산 응답');
    await expect(adapter.countInputTokens(request, signal())).rejects.toThrow('HTTP 500');
    const mlxFetch = vi.fn<typeof fetch>();
    expect(
      await new ChatCompletionProvider(
        'mlx',
        input('mlx').config.baseUrl,
        null,
        mlxFetch,
      ).countInputTokens(input('mlx'), signal()),
    ).toBeNull();
    expect(mlxFetch).not.toHaveBeenCalled();
  });

  it('does not silently ignore MLX tool-choice restrictions', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(stream());
    const request = input('mlx'),
      adapter = new ChatCompletionProvider('mlx', request.config.baseUrl, null, fetcher);
    await expect(
      collect(adapter.generate({ ...request, toolChoice: 'required' }, signal())),
    ).rejects.toThrow('필수 도구 선택');
    expect(fetcher).not.toHaveBeenCalled();
    await expect(
      collect(adapter.generate({ ...request, toolChoice: 'none' }, signal())),
    ).rejects.toThrow('도구가 허용되지 않은');
    const body = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body));
    expect(body).not.toHaveProperty('tools');
    expect(body).not.toHaveProperty('tool_choice');
  });

  it('selects the native adapter and keeps all local endpoints private', () => {
    expect(createInferenceProvider('ollama', 'http://localhost:11434')).toBeInstanceOf(
      OllamaProvider,
    );
    for (const provider of ['ollama', 'vllm', 'mlx'] as const) {
      expect(() => createInferenceProvider(provider, 'https://example.com')).toThrow();
      expect(() => createInferenceProvider(provider, 'http://0.0.0.0:8080')).toThrow();
      expect(
        modelConfigSchema.safeParse({
          provider,
          managedModelId: crypto.randomUUID(),
          managedModelVersion: 1,
        }).success,
      ).toBe(false);
    }
    expect(modelConfigSchema.parse({ provider: 'ollama' }).baseUrl).toBe('http://127.0.0.1:11434');
    expect(modelConfigSchema.parse({ provider: 'vllm' }).baseUrl).toBe('http://127.0.0.1:8000/v1');
    expect(modelConfigSchema.parse({ provider: 'mlx' }).baseUrl).toBe('http://127.0.0.1:8080/v1');
  });
});
