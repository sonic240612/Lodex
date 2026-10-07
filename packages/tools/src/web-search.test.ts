import { expect, it, vi } from 'vitest';
import { parseSearchResults, searchWeb } from './web-search';
const html =
  '<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdoc%3Fa%3D1%26b%3D2"><b>Title</b> &amp; test</a><a class="result__snippet">Useful <b>snippet</b></a>';
it('extracts titles and snippets, decodes canonical URLs and excludes private links', () => {
  expect(
    parseSearchResults(html + '<a href="http://127.0.0.1" class="result__a">Private</a>', 5),
  ).toEqual([
    { title: 'Title & test', url: 'https://example.com/doc?a=1&b=2', snippet: 'Useful snippet' },
  ]);
  expect(parseSearchResults('<div class="no-results">No results found</div>', 5)).toEqual([]);
  expect(() => parseSearchResults('<form class="challenge-form">challenge</form>', 5)).toThrow(
    '추가 확인',
  );
  expect(() => parseSearchResults('<html>changed</html>', 5)).toThrow('결과 형식');
  expect(parseSearchResults(html.replace('Useful', 'Captcha is'), 5)[0]!.snippet).toContain(
    'Captcha is',
  );
});
it('bounds Eco output while retaining complete source URLs and valid JSON', async () => {
  const many = Array.from(
    { length: 10 },
    (_, i) =>
      `<a class="result__a" href="https://example.com/${i}">Result ${i}</a><div class="result__snippet">${'한글'.repeat(500)}</div>`,
  ).join('');
  const output = await searchWeb({
    argumentsJson: '{"query":"docs","count":10}',
    signal: new AbortController().signal,
    authorize: async () => true,
    fetcher: async () => new Response(many),
    maxBytes: 8192,
  });
  expect(Buffer.byteLength(output)).toBeLessThanOrEqual(8192);
  const result = JSON.parse(output);
  expect(result.truncated).toBe(true);
  expect(result.results.length).toBeGreaterThan(0);
  expect(result.results[0].url).toBe('https://example.com/0');
});
it('gets permission before transmitting a query and exposes snippets only', async () => {
  const fetcher = vi.fn(async () => new Response(html));
  const denied = JSON.parse(
    await searchWeb({
      argumentsJson: '{"query":"local request"}',
      signal: new AbortController().signal,
      authorize: async () => false,
      fetcher,
    }),
  );
  expect(denied.status).toBe('rejected');
  expect(fetcher).not.toHaveBeenCalled();
  let approved = '';
  const result = JSON.parse(
    await searchWeb({
      argumentsJson: '{"query":"한국어 docs","region":"kr-kr"}',
      signal: new AbortController().signal,
      authorize: async (url) => {
        approved = url;
        return true;
      },
      fetcher,
    }),
  );
  expect(new URL(approved).searchParams.get('q')).toBe('한국어 docs');
  expect(result.sourceContent).toBe('snippets_only');
  expect(fetcher).toHaveBeenCalledTimes(1);
});
