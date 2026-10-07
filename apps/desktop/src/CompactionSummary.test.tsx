import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { defaultModelConfig, defaultPlan, type Session } from '@lodex/contracts';
import { CompactionSummary, lastCompaction } from './CompactionSummary';
const session: Session = {
  id: crypto.randomUUID(),
  title: 'test',
  version: 1,
  createdAt: '',
  updatedAt: '',
  config: defaultModelConfig(),
  plan: defaultPlan(),
  messages: [],
  run: null,
};
it('reports actual before/after estimates and reduction without ambiguous k suffixes', () => {
  const value = {
    ...session,
    contextCompaction: {
      throughMessageId: crypto.randomUUID(),
      summary: 'brief',
      createdAt: '2026-10-08T00:00:00Z',
      reason: 'automatic' as const,
      compactedMessageCount: 6,
      originalEstimateTokens: 131212,
      compactedEstimateTokens: 24800,
    },
  };
  const html = renderToStaticMarkup(<CompactionSummary session={value} />);
  expect(html).toContain('131,212 → 24,800');
  expect(html).toContain('81%');
  expect(html).toContain('자동 압축');
  value.messages.push({
    id: crypto.randomUUID(),
    role: 'assistant',
    createdAt: '',
    content: '',
    status: 'complete',
    error: null,
    usage: null,
    runContextCompaction: {
      summary: 'latest',
      throughContinuationCount: 2,
      historyCompacted: true,
      createdAt: '2026-10-08T01:00:00Z',
      count: 1,
      originalEstimateTokens: 50000,
      compactedEstimateTokens: 10000,
    },
  });
  expect(lastCompaction(value)?.kind).toBe('실행 중 자동');
});
