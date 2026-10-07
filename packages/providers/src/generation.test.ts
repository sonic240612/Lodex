import { describe, expect, it, vi } from 'vitest';
import { defaultModelConfig } from '@lodex/contracts';
import { ChatCompletionProvider } from './index';

describe('OpenRouter generation accounting', () => {
  it('queries the fixed metadata URL with encoded identity and authoritative final cost', async () => {
    const fetcher = vi.fn(async (_url: string, _init: RequestInit) =>
      Response.json({
        data: {
          id: 'gen a&b',
          finish_reason: 'stop',
          total_cost: 0.004,
          native_tokens_prompt: 15,
          native_tokens_completion: 4,
          usage: 999,
        },
      }),
    );
    const provider = new ChatCompletionProvider(
      'openrouter',
      'https://untrusted.invalid',
      'fixture-secret',
      fetcher,
    );
    expect(
      await provider.getGenerationUsage('gen a&b', new AbortController().signal),
    ).toMatchObject({ generationId: 'gen a&b', costUsd: 0.004, inputTokens: 15, outputTokens: 4 });
    expect(fetcher.mock.calls[0]?.[0]).toBe(
      'https://openrouter.ai/api/v1/generation?id=gen%20a%26b',
    );
  });
  it('keeps missing, unfinished, malformed and mismatched metadata unconfirmed', async () => {
    for (const data of [
      { id: 'gen', total_cost: 0 },
      { id: 'gen', finish_reason: 'stop', total_cost: -1 },
      { id: 'other', finish_reason: 'stop', total_cost: 1 },
    ]) {
      const provider = new ChatCompletionProvider('openrouter', '', null, async () =>
        Response.json({ data }),
      );
      if (data.id === 'other')
        await expect(
          provider.getGenerationUsage('gen', new AbortController().signal),
        ).rejects.toMatchObject({ code: 'GENERATION_ID' });
      else
        expect(await provider.getGenerationUsage('gen', new AbortController().signal)).toBeNull();
    }
    const missing = new ChatCompletionProvider(
      'openrouter',
      '',
      null,
      async () => new Response('', { status: 404 }),
    );
    expect(await missing.getGenerationUsage('gen', new AbortController().signal)).toBeNull();
  });
  it('accepts finalized cancellation and rejects an oversized metadata response', async () => {
    const cancelled = new ChatCompletionProvider('openrouter', '', null, async () =>
      Response.json({ data: { id: 'gen', cancelled: true, total_cost: 0 } }),
    );
    expect(await cancelled.getGenerationUsage('gen', new AbortController().signal)).toMatchObject({
      costUsd: 0,
    });
    const huge = new ChatCompletionProvider(
      'openrouter',
      '',
      null,
      async () => new Response('x'.repeat(65537)),
    );
    await expect(
      huge.getGenerationUsage('gen', new AbortController().signal),
    ).rejects.toMatchObject({ code: 'GENERATION_FORMAT' });
  });
  it('reports generation identity before text and detects identity changes in a stream', async () => {
    const event = (id: string, text: string) =>
      'data: ' + JSON.stringify({ id, choices: [{ delta: { content: text } }] }) + '\n\n';
    const provider = new ChatCompletionProvider(
      'openrouter',
      '',
      null,
      async () =>
        new Response(event('gen-1', 'hello') + event('gen-2', 'bad'), {
          headers: { 'content-type': 'text/event-stream' },
        }),
    );
    const iterator = provider
      .generate(
        {
          config: { ...defaultModelConfig(), provider: 'openrouter' },
          messages: [{ role: 'user', content: 'test' }],
        },
        new AbortController().signal,
      )
      [Symbol.asyncIterator]();
    expect((await iterator.next()).value).toMatchObject({ type: 'started' });
    expect((await iterator.next()).value).toEqual({
      type: 'usage',
      usage: { generationId: 'gen-1' },
    });
    await iterator.next(); // ttft
    expect((await iterator.next()).value).toMatchObject({ type: 'text_delta', text: 'hello' });
    await expect(iterator.next()).rejects.toMatchObject({ code: 'GENERATION_ID' });
  });
});
