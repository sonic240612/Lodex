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

it('shows LLM token counts and the resulting context percentage', () => {
  const value: Session = {
    ...session,
    messages: [
      {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: '',
        createdAt: '',
        status: 'complete',
        error: null,
        usage: null,
        runContextCompaction: {
          summary: 'summary',
          method: 'semantic',
          throughContinuationCount: 2,
          historyCompacted: true,
          createdAt: '2026-10-08T01:00:00Z',
          count: 1,
          originalEstimateTokens: 200000,
          compactedEstimateTokens: 70000,
          originalInputTokens: 81000,
          compactedInputTokens: 25000,
          contextBudgetTokens: 100000,
          targetRatio: 0.25,
        },
      },
    ],
  };
  const html = renderToStaticMarkup(<CompactionSummary session={value} />);
  expect(html).toContain('LLM 압축');
  expect(html).toContain('81,000 → 25,000');
  expect(html).toContain('컨텍스트 25%');
  value.messages[0]!.runContextCompaction!.strategy = 'incremental';
  const eco = renderToStaticMarkup(<CompactionSummary session={value} />);
  expect(eco).toContain('Eco 자동 요약');
  expect(eco).not.toContain('증분');
});
