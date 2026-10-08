import { describe, expect, it } from 'vitest';
import type { Message } from '@lodex/contracts';
import { telegramAnswer, telegramChunks } from './telegram-output';

const message = (overrides: Partial<Message> = {}): Message => ({
  id: 'answer',
  role: 'assistant',
  createdAt: new Date().toISOString(),
  status: 'complete',
  content: '조사했습니다.\n최종 답변입니다.',
  error: null,
  usage: null,
  finalResponseOffset: '조사했습니다.\n'.length,
  ...overrides,
});

describe('Telegram answer formatting', () => {
  it('selects the final response and preserves older messages without offset metadata', () => {
    expect(telegramAnswer(message())).toBe('[complete]\n최종 답변입니다.');
    const legacy = message();
    delete legacy.finalResponseOffset;
    expect(telegramAnswer(legacy)).toContain('조사했습니다.');
    expect(telegramAnswer(message({ status: 'failed', error: '요청 실패' }))).toBe(
      '[failed]\n조사했습니다.\n최종 답변입니다.\n요청 실패',
    );
    expect(telegramAnswer(message({ finalResponseOffset: message().content.length }))).toBe(
      '[complete]\n작업이 완료되었습니다.',
    );
  });

  it('delivers all text without splitting surrogate pairs or leaking tokens across boundaries', () => {
    const token = 'fixture-secret-token';
    const content = 'x'.repeat(3499) + '🦔' + 'y'.repeat(3491) + token + '\n마지막 문장';
    const parts = telegramChunks(content, token);
    expect(parts.length).toBeGreaterThan(1);
    expect(
      parts.every(
        (part) =>
          part.length <= 4096 &&
          [...part].every((char) => char.length === 2 || !/[\uD800-\uDFFF]/.test(char)),
      ),
    ).toBe(true);
    expect(parts.join('')).not.toContain(token);
    expect(parts.map((part) => part.replace(/^\[\d+\/\d+\]\n/, '')).join('')).toBe(
      content.replaceAll(token, '[redacted]'),
    );
    expect(parts.at(-1)).toContain('마지막 문장');
  });

  it('preserves paragraph whitespace and represents empty output', () => {
    const content = 'first\n'.repeat(2000);
    expect(
      telegramChunks(content, null)
        .map((part) => part.replace(/^\[\d+\/\d+\]\n/, ''))
        .join(''),
    ).toBe(content);
    expect(telegramChunks('', null)).toEqual(['내용 없음']);
  });
});
