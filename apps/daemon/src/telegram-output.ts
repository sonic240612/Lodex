import type { Message } from '@lodex/contracts';
import { telegramFormattedChunks, telegramMarkdown } from './telegram-markdown';

/** Only assistant content is Markdown; operational prefixes and error details stay literal. */
export function telegramReplyChunks(message: Message, token: string | null, prefix = '') {
  const offset = message.status === 'complete' ? (message.finalResponseOffset ?? 0) : 0;
  const answer =
    message.content.slice(offset) ||
    (message.status === 'complete' ? '작업이 완료되었습니다.' : '답변 내용 없음');
  const rendered = telegramMarkdown(answer, token);
  const header = `${prefix}[${message.status}]\n`;
  return telegramFormattedChunks(
    {
      text: header + rendered.text + (message.error ? '\n' + message.error : ''),
      ...(rendered.entities
        ? {
            entities: rendered.entities.map((entity) => ({
              ...entity,
              offset: entity.offset + header.length,
            })),
          }
        : {}),
    },
    token,
  );
}

/** The transcript contains progress updates; only the completed response belongs in the reply. */
export function telegramAnswer(message: Message) {
  const offset = message.status === 'complete' ? (message.finalResponseOffset ?? 0) : 0;
  const answer = message.content.slice(offset);
  return (
    `[${message.status}]\n` +
    (answer || (message.status === 'complete' ? '작업이 완료되었습니다.' : '답변 내용 없음')) +
    (message.error ? '\n' + message.error : '')
  );
}

/** Reserve space for part labels and split UTF-16 safely below Telegram's 4,096-character limit. */
export function telegramChunks(text: string, token: string | null): string[] {
  // Redact before splitting so even a token spanning a boundary cannot escape.
  const clean = (token ? text.replaceAll(token, '[redacted]') : text) || '내용 없음';
  const limit = 3500;
  const parts: string[] = [];
  for (let start = 0; start < clean.length;) {
    let end = Math.min(start + limit, clean.length);
    if (end < clean.length) {
      const paragraph = clean.lastIndexOf('\n', end - 1);
      if (paragraph >= start + limit / 2) end = paragraph + 1;
      if (/[\uD800-\uDBFF]/.test(clean[end - 1]!) && /[\uDC00-\uDFFF]/.test(clean[end]!)) end--;
    }
    parts.push(clean.slice(start, end));
    start = end;
  }
  return parts.length === 1
    ? parts
    : parts.map((part, index) => `[${index + 1}/${parts.length}]\n${part}`);
}
