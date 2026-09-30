import { describe, expect, it, vi } from 'vitest';
import { fetchWebPage } from './web';

const signal = () => new AbortController().signal;
const args = (url = 'https://example.com/docs') => JSON.stringify({ url });
const text = (value: string, type = 'text/plain; charset=utf-8') =>
  new Response(value, { headers: { 'Content-Type': type } });

describe('web_fetch', () => {
  it('extracts readable HTML without scripts, forms, hidden content, or subrequests', async () => {
    const fetcher = vi.fn<NonNullable<Parameters<typeof fetchWebPage>[0]['fetcher']>>(async () =>
      text(
        '<html><body><h1>API &amp; usage</h1><p>Use <code>npm test</code>.</p><a href="/reference">Reference</a><script>SECRET_SCRIPT</script><form>SECRET_FORM</form><div hidden>SECRET_HIDDEN</div><iframe src="http://127.0.0.1">SECRET_IFRAME</iframe></body></html>',
        'text/html; charset=utf-8',
      ),
    );
    const authorize = vi.fn(async () => true);
    const output = JSON.parse(
      await fetchWebPage({ argumentsJson: args(), signal: signal(), fetcher, authorize }),
    );
    expect(output).toMatchObject({
      finalUrl: 'https://example.com/docs',
      status: 200,
      truncated: false,
    });
    expect(output.content).toContain('API & usage');
    expect(output.content).toContain('npm test');
    expect(output.content).toContain('https://example.com/reference');
    expect(output.content).not.toContain('SECRET');
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
      method: 'GET',
      redirect: 'manual',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
    });
    expect(authorize).toHaveBeenCalledWith('https://example.com/docs', false);
  });

  it('does not send any request when approval is rejected', async () => {
    const fetcher = vi.fn(async () => text('must not run'));
    const result = JSON.parse(
      await fetchWebPage({
        argumentsJson: args(),
        signal: signal(),
        fetcher,
        authorize: async () => false,
      }),
    );
    expect(result.status).toBe('rejected');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('revalidates and reviews every redirect before fetching it', async () => {
    const fetcher = vi
      .fn<typeof fetch>(async () => text('Final source'))
      .mockResolvedValueOnce(
        new Response(null, { status: 302, headers: { Location: 'https://docs.example.com/api' } }),
      );
    const authorize = vi.fn(async () => true);
    const result = JSON.parse(
      await fetchWebPage({ argumentsJson: args(), signal: signal(), fetcher, authorize }),
    );
    expect(authorize.mock.calls).toEqual([
      ['https://example.com/docs', false],
      ['https://docs.example.com/api', true],
    ]);
    expect(result).toMatchObject({
      finalUrl: 'https://docs.example.com/api',
      redirects: 1,
      content: 'Final source',
    });
  });

  it.each([
    'http://127.0.0.1/',
    'https://100.114.148.69/',
    'https://user:pass@example.com/',
    'http://example.com/plain',
  ])('blocks unsafe redirect %s before making another request', async (location) => {
    const fetcher = vi.fn(
      async () => new Response(null, { status: 302, headers: { Location: location } }),
    );
    const authorize = vi.fn(async () => true);
    await expect(
      fetchWebPage({ argumentsJson: args(), signal: signal(), fetcher, authorize }),
    ).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(authorize).toHaveBeenCalledTimes(1);
  });

  it('never follows a rejected redirect', async () => {
    const fetcher = vi.fn(
      async () => new Response(null, { status: 302, headers: { Location: '/next' } }),
    );
    const authorize = vi.fn(async (_url: string, redirect: boolean) => !redirect);
    const result = JSON.parse(
      await fetchWebPage({ argumentsJson: args(), signal: signal(), fetcher, authorize }),
    );
    expect(result.status).toBe('rejected');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('caps redirect loops at five hops', async () => {
    const fetcher = vi.fn(
      async () => new Response(null, { status: 301, headers: { Location: '/loop' } }),
    );
    await expect(
      fetchWebPage({
        argumentsJson: args(),
        signal: signal(),
        fetcher,
        authorize: async () => true,
      }),
    ).rejects.toMatchObject({ code: 'WEB_REDIRECT' });
    expect(fetcher).toHaveBeenCalledTimes(6);
  });

  it('bounds serialized output including escaped Unicode and reports truncation', async () => {
    const fetcher = vi.fn(async () => text('가😀"\\\n'.repeat(6000)));
    const output = await fetchWebPage({
      argumentsJson: args(),
      signal: signal(),
      fetcher,
      authorize: async () => true,
      maxBytes: 8192,
    });
    expect(Buffer.byteLength(output)).toBeLessThanOrEqual(8192);
    const result = JSON.parse(output);
    expect(result.truncated).toBe(true);
    expect(result.content).not.toContain('\uFFFD');
    expect(result.textBytes).toBeGreaterThan(Buffer.byteLength(result.content));
  });

  it('supports JSON and declared text encodings', async () => {
    const output = JSON.parse(
      await fetchWebPage({
        argumentsJson: args(),
        signal: signal(),
        fetcher: async () => text('{"value":42}', 'application/json'),
        authorize: async () => true,
      }),
    );
    expect(output.content).toBe('{"value":42}');
    const encoded = JSON.parse(
      await fetchWebPage({
        argumentsJson: args(),
        signal: signal(),
        fetcher: async () =>
          new Response(new Uint8Array([0x63, 0x61, 0x66, 0xe9]), {
            headers: { 'Content-Type': 'text/plain; charset=windows-1252' },
          }),
        authorize: async () => true,
      }),
    );
    expect(encoded.content).toBe('café');
  });

  it.each([
    [() => new Response('not found', { status: 404 }), 'WEB_HTTP'],
    [() => text('binary', 'image/png'), 'WEB_CONTENT_TYPE'],
    [() => text('x'.repeat(1024 * 1024 + 1)), 'WEB_RESPONSE_LIMIT'],
    [() => text('x\0binary'), 'WEB_BINARY'],
    [() => text('text', 'text/plain; charset=not-real'), 'WEB_ENCODING'],
  ] as const)('rejects unsupported or excessive response %#', async (response, code) => {
    await expect(
      fetchWebPage({
        argumentsJson: args(),
        signal: signal(),
        fetcher: async () => response(),
        authorize: async () => true,
      }),
    ).rejects.toMatchObject({ code });
  });

  it('cancels before network access when stopped while awaiting approval', async () => {
    const controller = new AbortController();
    const fetcher = vi.fn(async () => text('unused'));
    await expect(
      fetchWebPage({
        argumentsJson: args(),
        signal: controller.signal,
        fetcher,
        authorize: async () => {
          controller.abort();
          return true;
        },
      }),
    ).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('reports structural truncation in deeply nested HTML', async () => {
    const html = '<div>'.repeat(100) + 'deep content' + '</div>'.repeat(100);
    const result = JSON.parse(
      await fetchWebPage({
        argumentsJson: args(),
        signal: signal(),
        fetcher: async () => text(html, 'text/html'),
        authorize: async () => true,
      }),
    );
    expect(result.truncated).toBe(true);
  });
});
