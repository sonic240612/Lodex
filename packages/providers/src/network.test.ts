import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import {
  createPrivateDispatcher,
  createPrivateLookup,
  createPrivateFetch,
  connectionError,
} from './network';
import { ChatCompletionProvider } from './index';
import { defaultModelConfig } from '@lodex/contracts';
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

describe('private model server networking', () => {
  it('keeps Tailscale IPv4, IPv6 and MagicDNS endpoints for catalog and generation', async () => {
    for (const base of [
      'http://100.75.2.3:8080',
      'http://[fd7a:115c:a1e0::1234]:8080',
      'https://gpu.tailnet.ts.net',
    ]) {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockImplementation(async (url) =>
          String(url).endsWith('/models')
            ? Response.json({ data: [{ id: 'fixture' }] })
            : new Response(
                'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
                { headers: { 'content-type': 'text/event-stream' } },
              ),
        );
      const provider = new ChatCompletionProvider('llama-server', base, null, fetcher);
      expect((await provider.listModels())[0]!.id).toBe('fixture');
      for await (const _ of provider.generate(
        {
          config: { ...defaultModelConfig(), model: 'fixture', baseUrl: base },
          messages: [{ role: 'user', content: 'test' }],
        },
        new AbortController().signal,
      )) {
        /* Consume. */
      }
      expect(fetcher.mock.calls.map((call) => call[0])).toEqual([
        base + '/v1/models',
        base + '/props',
        base + '/v1/chat/completions',
      ]);
      expect(fetcher.mock.calls.every((call) => call[1]?.redirect === 'error')).toBe(true);
    }
  });
  it('uses the verified DNS answer for a real HTTP socket and preserves the Host header', async () => {
    const hits: string[] = [];
    const server = createServer((req, res) => {
      hits.push(req.headers.host!);
      res.setHeader('content-type', 'application/json');
      res.end('{"data":[{"id":"fixture"}]}');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    cleanup.push(
      () =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        }),
    );
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No port');
    const resolver = vi.fn((_host, _options, cb) =>
      cb(null, [{ address: '127.0.0.1', family: 4 }]),
    );
    const dispatcher = createPrivateDispatcher(resolver);
    cleanup.push(() => dispatcher.close());
    const fetcher = createPrivateFetch(dispatcher);
    const provider = new ChatCompletionProvider(
      'llama-server',
      `http://gpu.tailnet.ts.net:${address.port}`,
      null,
      fetcher,
    );
    expect(await provider.listModels()).toMatchObject([{ id: 'fixture' }]);
    expect(resolver.mock.calls[0]![0]).toBe('gpu.tailnet.ts.net');
    expect(hits).toEqual([
      `gpu.tailnet.ts.net:${address.port}`,
      `gpu.tailnet.ts.net:${address.port}`,
    ]);
  });
  it('rejects mixed/public DNS answers before opening a connection', async () => {
    const dispatcher = createPrivateDispatcher((_host, _options, cb) =>
      cb(null, [
        { address: '127.0.0.1', family: 4 },
        { address: '203.0.113.1', family: 4 },
      ]),
    );
    cleanup.push(() => dispatcher.close());
    const provider = new ChatCompletionProvider(
      'llama-server',
      'http://gpu.tailnet.ts.net:1234',
      null,
      createPrivateFetch(dispatcher),
    );
    await expect(provider.listModels()).rejects.toMatchObject({ code: 'SERVER_ADDRESS_DENIED' });
  });
  it('returns Tailscale DNS answers in the form requested by Node', () => {
    const lookup = createPrivateLookup((_h, _o, cb) =>
      cb(null, [
        { address: '100.75.2.3', family: 4 },
        { address: 'fd7a:115c:a1e0::1', family: 6 },
      ]),
    );
    const single = vi.fn(),
      all = vi.fn();
    lookup('gpu', {}, single);
    lookup('gpu', { all: true }, all);
    expect(single).toHaveBeenCalledWith(null, '100.75.2.3', 4);
    expect(all.mock.calls[0]![1]).toHaveLength(2);
  });
  it.each([
    ['ENOTFOUND', 'SERVER_DNS'],
    ['ECONNREFUSED', 'SERVER_REFUSED'],
    ['ETIMEDOUT', 'SERVER_UNREACHABLE'],
    ['DEPTH_ZERO_SELF_SIGNED_CERT', 'SERVER_TLS'],
  ])('explains %s instead of hiding it behind fetch failed', async (code, expected) => {
    const failure = new TypeError('fetch failed', {
      cause: Object.assign(new Error('network'), { code }),
    });
    expect(connectionError(failure, 'http://100.75.2.3:8080/v1').code).toBe(expected);
    const provider = new ChatCompletionProvider(
      'llama-server',
      'http://100.75.2.3:8080/v1',
      null,
      vi.fn<typeof fetch>().mockRejectedValue(failure),
    );
    await expect(provider.listModels()).rejects.toMatchObject({ code: expected });
  });
});
