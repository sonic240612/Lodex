import { describe, expect, it } from 'vitest';
import {
  telegramFormattedChunks,
  telegramMarkdown,
  type TelegramFormattedChunk,
} from './telegram-markdown';

const spans = (message: TelegramFormattedChunk) =>
  message.entities?.map((entity) => ({
    ...entity,
    content: message.text.slice(entity.offset, entity.offset + entity.length),
  })) ?? [];
const withoutLabels = (parts: TelegramFormattedChunk[]) =>
  parts.map((part) => part.text.replace(/^\[\d+\/\d+\]\n/, '')).join('');
const hasValidSurrogates = (text: string) =>
  [...text].every((character) => character.length === 2 || !/[\uD800-\uDFFF]/.test(character));

describe('Telegram Markdown rendering', () => {
  it('renders headings, nested styles, links, inline code and fenced code with UTF-16 offsets', () => {
    const result = telegramMarkdown(
      '# 완료 🦔\n\n**굵게 *기울게*** ~~취소~~ `a_b`\n\n' +
        '[문서](https://example.com/?a=1&b=2)\n\n```ts\nconst x = "<tag>_*";\n```',
      null,
    );
    expect(result.text).toBe('완료 🦔\n\n굵게 기울게 취소 a_b\n\n문서\n\nconst x = "<tag>_*";');
    expect(spans(result)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'bold', content: '완료 🦔', offset: 0, length: 5 }),
        expect.objectContaining({ type: 'bold', content: '굵게 기울게' }),
        expect.objectContaining({ type: 'italic', content: '기울게' }),
        expect.objectContaining({ type: 'strikethrough', content: '취소' }),
        expect.objectContaining({ type: 'code', content: 'a_b' }),
        expect.objectContaining({
          type: 'text_link',
          content: '문서',
          url: 'https://example.com/?a=1&b=2',
        }),
        expect.objectContaining({ type: 'pre', content: 'const x = "<tag>_*";', language: 'ts' }),
      ]),
    );
  });

  it('does not overlap code entities with styles or links', () => {
    const result = telegramMarkdown(
      '**앞 `code` 뒤** 그리고 [`link code`](https://example.com)',
      null,
    );
    expect(result.text).toBe('앞 code 뒤 그리고 link code');
    expect(spans(result)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'bold', content: '앞 ' }),
        expect.objectContaining({ type: 'bold', content: ' 뒤' }),
        expect.objectContaining({ type: 'code', content: 'code' }),
        expect.objectContaining({ type: 'code', content: 'link code' }),
      ]),
    );
    expect(spans(result).filter((entity) => entity.type === 'text_link')).toEqual([]);
  });

  it('renders ordered, nested, task lists and quotes without Markdown markers', () => {
    const result = telegramMarkdown(
      '3. 첫째\n4. 둘째\n   - 하위\n\n- [x] 완료\n- [ ] 대기\n\n> **인용**\n>\n> > 중첩',
      null,
    );
    expect(result.text).toBe('3. 첫째\n4. 둘째\n  • 하위\n\n☑ 완료\n☐ 대기\n\n│ 인용\n\n│ │ 중첩');
    expect(spans(result)).toContainEqual(
      expect.objectContaining({ type: 'bold', content: '인용' }),
    );
  });

  it('turns GFM tables into labeled mobile-friendly rows, preserving cell formatting', () => {
    const result = telegramMarkdown(
      '| 파일 | 상태 |\n| --- | --- |\n| `.env` | **완료** |\n| app.ts | [확인](https://example.com) |',
      null,
    );
    expect(result.text).toBe('파일: .env\n상태: 완료\n\n파일: app.ts\n상태: 확인');
    expect(spans(result)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'code', content: '.env' }),
        expect.objectContaining({ type: 'bold', content: '완료' }),
        expect.objectContaining({ type: 'text_link', content: '확인' }),
      ]),
    );
    expect(telegramMarkdown('| 제목 |\n| --- |', null).text).toBe('제목');
  });

  it('supports reference links and image labels without turning raw HTML into markup', () => {
    const result = telegramMarkdown(
      '[문서][ref] ![도표](https://example.com/chart.png)\n\n<b>literal</b> &amp; \\*글자\\*\n\n[ref]: https://example.com/docs',
      null,
    );
    expect(result.text).toBe('문서 도표\n\n<b>literal</b> & *글자*');
    expect(spans(result)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'text_link',
          content: '문서',
          url: 'https://example.com/docs',
        }),
        expect.objectContaining({
          type: 'text_link',
          content: '도표',
          url: 'https://example.com/chart.png',
        }),
      ]),
    );
    expect(telegramMarkdown('미완성 **강조 [링크](\n\n```js\nconst x = 1;', null).text).toBe(
      '미완성 **강조 [링크](\n\nconst x = 1;',
    );
  });

  it('does not attach unsafe, credentialed or local-path link destinations', () => {
    const result = telegramMarkdown(
      '[a](javascript:alert) [b](data:text/plain,x) [c](file:///C:/secret) [d](/tmp/log) [e](https://user:password@example.com) [메일](mailto:hello@example.com)',
      null,
    );
    expect(result.text).toBe('a b c d e 메일');
    expect(spans(result)).toEqual([
      expect.objectContaining({
        type: 'text_link',
        content: '메일',
        url: 'mailto:hello@example.com',
      }),
    ]);
  });

  it('uses the outer link for linked images instead of emitting forbidden nested links', () => {
    const result = telegramMarkdown(
      '[![이미지](https://example.com/image.png)](https://example.com/page)',
      null,
    );
    expect(result.text).toBe('이미지');
    expect(result.entities).toEqual([
      { type: 'text_link', offset: 0, length: 3, url: 'https://example.com/page' },
    ]);
  });

  it('keeps footnote references connected to labeled definitions', () => {
    expect(telegramMarkdown('근거[^ref]\n\n[^ref]: 자세한 설명', null).text).toBe(
      '근거[ref]\n\n[ref]: 자세한 설명',
    );
  });

  it('preserves thousands of code and style spans in a large answer', () => {
    const result = telegramMarkdown('**bold** and `code`\n\n'.repeat(5000), null);
    expect(result.entities).toHaveLength(10000);
    expect(
      spans(result).every((entity) =>
        entity.type === 'code' ? entity.content === 'code' : entity.content === 'bold',
      ),
    ).toBe(true);
  });

  it('redacts bot tokens decoded from Markdown and in link metadata', () => {
    const token = '123456:fixture_secret';
    const source =
      `**${token}** \`${token}\` 123456:fixture\\_secret\n\n` +
      `[secret](https://example.com/${encodeURIComponent(token)}) ` +
      `[decoded](https://example.com/123456&#58;fixture_secret)`;
    const parts = telegramFormattedChunks(telegramMarkdown(source, token), token);
    expect(JSON.stringify(parts)).not.toContain(token);
    expect(JSON.stringify(parts)).not.toContain(encodeURIComponent(token));
    expect(withoutLabels(parts)).toBe('[redacted] [redacted] [redacted]\n\nsecret decoded');
    expect(parts.flatMap((part) => spans(part)).some((entity) => entity.type === 'text_link')).toBe(
      false,
    );
  });

  it('redacts secrets reconstructed across code/style nodes without invalid overlaps', () => {
    const token = '123456:fixture_secret';
    const parts = telegramFormattedChunks(
      telegramMarkdown('`123456:`**fixture_secret** **이후**', token),
      token,
    );
    expect(parts[0]?.text).toBe('[redacted] 이후');
    expect(spans(parts[0]!)).toEqual([
      expect.objectContaining({ type: 'bold', content: '이후', offset: 11, length: 2 }),
    ]);
  });
});

describe('Telegram formatted chunks', () => {
  it('preserves long fenced code, emoji, link spans and labels across message boundaries', () => {
    const code = 'x'.repeat(3499) + '🦔' + '\nconst x = 1;\n'.repeat(450);
    const message = telegramMarkdown(
      '```js\n' + code + '\n```\n\n[' + '🦔'.repeat(2500) + '](https://example.com)',
      null,
    );
    const parts = telegramFormattedChunks(message);
    expect(parts.length).toBeGreaterThan(3);
    expect(withoutLabels(parts)).toBe(message.text);
    for (const part of parts) {
      expect(part.text.length).toBeLessThanOrEqual(4096);
      expect(hasValidSurrogates(part.text)).toBe(true);
      const label = part.text.match(/^\[\d+\/\d+\]\n/)![0];
      for (const entity of spans(part)) {
        expect(entity.offset).toBeGreaterThanOrEqual(label.length);
        expect(entity.offset + entity.length).toBeLessThanOrEqual(part.text.length);
        expect(hasValidSurrogates(entity.content)).toBe(true);
        if (entity.type === 'pre') expect(entity.language).toBe('js');
        if (entity.type === 'text_link') expect(entity.url).toBe('https://example.com');
      }
    }
    expect(
      parts.filter((part) => spans(part).some((span) => span.type === 'pre')).length,
    ).toBeGreaterThan(1);
    expect(
      parts.filter((part) => spans(part).some((span) => span.type === 'text_link')).length,
    ).toBeGreaterThan(1);
  });

  it('splits dense formatted lists before exceeding the entity limit without losing styles', () => {
    const message = telegramMarkdown('**단어** '.repeat(400), null);
    const parts = telegramFormattedChunks(message);
    expect(parts.length).toBeGreaterThan(1);
    expect(withoutLabels(parts)).toBe(message.text);
    expect(parts.every((part) => (part.entities?.length ?? 0) <= 90)).toBe(true);
    expect(
      parts.flatMap((part) => spans(part)).filter((entity) => entity.type === 'bold'),
    ).toHaveLength(400);
  });
});
