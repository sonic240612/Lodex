import { z } from 'zod';
import type { Session, ToolDefinition } from '@lodex/contracts';

const MAX_OUTPUT_BYTES = 16 * 1024 - 512;
const EXCERPT_CHARS = 480;
const BEFORE_MATCH_CHARS = 160;

const historySearchSchema = z.strictObject({
  query: z.string().trim().min(1).max(200),
  roles: z
    .array(z.enum(['user', 'assistant']))
    .min(1)
    .max(2)
    .optional(),
  maxResults: z.number().int().min(1).max(20).default(10),
  caseSensitive: z.boolean().default(false),
});

export const historySearchTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'search_history',
    description:
      'Search the persisted user and assistant text in this conversation, including older turns omitted from the active prompt by context compaction. The query is a literal substring, not a regular expression. Results are newest first and bounded; refine the query when truncated.',
    parameters: z.toJSONSchema(historySearchSchema),
  },
};

function excerpt(content: string, index: number, queryLength: number): string {
  const start = Math.max(0, index - BEFORE_MATCH_CHARS);
  const end = Math.min(content.length, start + Math.max(EXCERPT_CHARS, queryLength));
  return (start > 0 ? '…' : '') + content.slice(start, end) + (end < content.length ? '…' : '');
}

export function searchSessionHistory(
  session: Pick<Session, 'messages' | 'run'>,
  argumentsJson: string,
): string {
  const input = historySearchSchema.parse(JSON.parse(argumentsJson));
  const roles = new Set(input.roles ?? ['user', 'assistant']);
  const needle = input.caseSensitive ? input.query : input.query.toLowerCase();
  const matches = session.messages
    .filter(
      (message) =>
        message.id !== session.run?.messageId &&
        message.status !== 'streaming' &&
        roles.has(message.role) &&
        message.content.length > 0,
    )
    .flatMap((message) => {
      const haystack = input.caseSensitive ? message.content : message.content.toLowerCase();
      const index = haystack.indexOf(needle);
      return index < 0
        ? []
        : [
            {
              messageId: message.id,
              role: message.role,
              status: message.status,
              createdAt: message.createdAt,
              excerpt: excerpt(message.content, index, input.query.length),
            },
          ];
    })
    .reverse();

  const selected: (typeof matches)[number][] = [];
  for (const match of matches) {
    if (selected.length >= input.maxResults) break;
    const candidate = {
      query: input.query,
      totalMatches: matches.length,
      returned: selected.length + 1,
      truncated: selected.length + 1 < matches.length,
      matches: [...selected, match],
    };
    if (Buffer.byteLength(JSON.stringify(candidate)) > MAX_OUTPUT_BYTES) break;
    selected.push(match);
  }
  return JSON.stringify({
    query: input.query,
    totalMatches: matches.length,
    returned: selected.length,
    truncated: selected.length < matches.length,
    matches: selected,
  });
}
