import { describe, expect, it } from 'vitest';
import type { Message, Session } from '@lodex/contracts';
import { historySearchTool, searchSessionHistory } from './history';

function message(
  id: string,
  role: Message['role'],
  content: string,
  status: Message['status'] = 'complete',
): Message {
  return {
    id,
    role,
    content,
    status,
    createdAt: `2026-09-24T00:00:0${id}.000Z`,
    error: null,
    usage: null,
  };
}

function session(messages: Message[], messageId = 'current'): Pick<Session, 'messages' | 'run'> {
  return {
    messages,
    run: {
      id: 'run',
      messageId,
      status: 'running',
      startedAt: '2026-09-24T00:00:00.000Z',
      finishedAt: null,
    },
  };
}

describe('searchSessionHistory', () => {
  it('searches persisted text literally and returns newest messages first', () => {
    const result = JSON.parse(
      searchSessionHistory(
        session([
          message('1', 'user', 'Remember the Alpha.Beta requirement.'),
          message('2', 'assistant', 'I kept alpha.beta in the implementation.'),
          message('3', 'user', 'AlphaXBeta must not match.'),
        ]),
        JSON.stringify({ query: 'ALPHA.BETA' }),
      ),
    );
    expect(result.totalMatches).toBe(2);
    expect(result.matches.map((match: { messageId: string }) => match.messageId)).toEqual([
      '2',
      '1',
    ]);
  });

  it('supports role and case-sensitive filters', () => {
    const result = JSON.parse(
      searchSessionHistory(
        session([
          message('1', 'user', 'Need ExactCase'),
          message('2', 'assistant', 'exactcase noted'),
        ]),
        JSON.stringify({
          query: 'ExactCase',
          roles: ['user'],
          caseSensitive: true,
          maxResults: 1,
        }),
      ),
    );
    expect(result.totalMatches).toBe(1);
    expect(result.matches[0].messageId).toBe('1');
  });

  it('excludes the current run message and any other streaming message', () => {
    const result = JSON.parse(
      searchSessionHistory(
        session(
          [
            message('1', 'user', 'needle before'),
            message('stream', 'assistant', 'needle unfinished', 'streaming'),
            message('current', 'assistant', 'needle current', 'complete'),
          ],
          'current',
        ),
        JSON.stringify({ query: 'needle' }),
      ),
    );
    expect(result.matches.map((match: { messageId: string }) => match.messageId)).toEqual(['1']);
  });

  it('bounds the result count and serialized output size', () => {
    const messages = Array.from({ length: 30 }, (_, index) =>
      message(String(index), 'assistant', `${'가'.repeat(300)} needle ${'나'.repeat(300)}`),
    );
    const output = searchSessionHistory(
      session(messages),
      JSON.stringify({ query: 'needle', maxResults: 20 }),
    );
    const result = JSON.parse(output);
    expect(Buffer.byteLength(output)).toBeLessThanOrEqual(16 * 1024 - 512);
    expect(result.returned).toBeLessThanOrEqual(20);
    expect(result.totalMatches).toBe(30);
    expect(result.truncated).toBe(true);
  });

  it('rejects unknown arguments and exposes a strict tool schema', () => {
    expect(() =>
      searchSessionHistory(session([]), JSON.stringify({ query: 'x', unexpected: true })),
    ).toThrow();
    expect(historySearchTool.function.name).toBe('search_history');
    expect(historySearchTool.function.parameters).toMatchObject({ additionalProperties: false });
  });
});
