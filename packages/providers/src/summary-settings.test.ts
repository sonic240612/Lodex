import { expect, it } from 'vitest';
import { defaultModelConfig, type InferenceRequest } from '@lodex/contracts';
import { ChatCompletionProvider } from './index';

const completed = () =>
  new Response(
    'data: {"choices":[{"delta":{"content":"A complete summary of verified work."},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
    { headers: { 'Content-Type': 'text/event-stream' } },
  );
const request = (): InferenceRequest => ({
  config: { ...defaultModelConfig(), model: 'fixture' },
  messages: [{ role: 'user', content: 'Summarize verified work.' }],
});
const drain = async (provider: ChatCompletionProvider, input: InferenceRequest) => {
  for await (const _ of provider.generate(input, new AbortController().signal)) {
    /* consume */
  }
};

it.each([
  [{ mandatory: false, supported_efforts: ['high', 'low'] }, { enabled: false }],
  [{ mandatory: true, supported_efforts: ['high', 'low', 'minimal'] }, { effort: 'minimal' }],
  [{ mandatory: true, supported_efforts: ['none', 'low'] }, { effort: 'low' }],
  [{ supported_efforts: ['none', 'low'] }, { effort: 'none' }],
  [{}, undefined],
  [{ mandatory: true, supported_efforts: null }, undefined],
] as const)(
  'uses only advertised OpenRouter summary controls (%j)',
  async (reasoning, expected) => {
    const bodies: Record<string, unknown>[] = [];
    let catalogs = 0;
    const provider = new ChatCompletionProvider('openrouter', '', 'fixture', async (url, init) => {
      if (url.endsWith('/models')) {
        catalogs++;
        return new Response(JSON.stringify({ data: [{ id: 'fixture', reasoning }] }));
      }
      bodies.push(JSON.parse(String(init.body)));
      return completed();
    });
    await drain(provider, { ...request(), purpose: 'context_summary' });
    await drain(provider, { ...request(), purpose: 'context_summary' });
    await drain(provider, request());
    expect(bodies[0]?.reasoning).toEqual(expected);
    expect(bodies[1]?.reasoning).toEqual(expected);
    expect(bodies[2]).not.toHaveProperty('reasoning');
    expect(catalogs).toBe(1);
  },
);

it('keeps unknown OpenRouter settings unchanged if metadata cannot be loaded', async () => {
  let catalogs = 0;
  const bodies: Record<string, unknown>[] = [];
  const provider = new ChatCompletionProvider('openrouter', '', 'fixture', async (url, init) => {
    if (url.endsWith('/models')) {
      catalogs++;
      throw new Error('unavailable');
    }
    bodies.push(JSON.parse(String(init.body)));
    return completed();
  });
  await drain(provider, { ...request(), purpose: 'context_summary' });
  await drain(provider, { ...request(), purpose: 'context_summary' });
  expect(catalogs).toBe(1);
  expect(bodies.every((body) => !('reasoning' in body))).toBe(true);
});

it('counts and generates llama summaries with matching thinking controls without changing normal requests', async () => {
  const bodies: Record<string, unknown>[] = [];
  const provider = new ChatCompletionProvider(
    'llama-server',
    'http://127.0.0.1:8080/v1',
    null,
    async (url, init) => {
      if (url.endsWith('/props'))
        return new Response(
          JSON.stringify({
            chat_template_caps: {
              supports_tools: true,
              supports_tool_calls: true,
              supports_reasoning_effort: true,
            },
          }),
        );
      bodies.push(JSON.parse(String(init.body)));
      return url.endsWith('/input_tokens') ? new Response('{"input_tokens":123}') : completed();
    },
  );
  const summary = { ...request(), purpose: 'context_summary' as const };
  await provider.countInputTokens(summary, new AbortController().signal);
  await drain(provider, summary);
  await drain(provider, request());
  expect(bodies[0]).toMatchObject({
    reasoning_effort: 'none',
    chat_template_kwargs: { enable_thinking: false },
  });
  expect(bodies[1]).toMatchObject({
    reasoning_effort: 'none',
    chat_template_kwargs: { enable_thinking: false },
  });
  expect(bodies[2]).not.toHaveProperty('reasoning_effort');
  expect(bodies[2]).not.toHaveProperty('chat_template_kwargs');
});
