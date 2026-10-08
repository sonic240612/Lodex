import { expect, it } from 'vitest';
import { defaultModelConfig, defaultPlan, type Session } from '@lodex/contracts';
import { historySelection } from './history-selection';

const sessions = (count: number): Session[] =>
  Array.from({ length: count }, (_, index) => ({
    id: String(index),
    title: `Conversation ${index}`,
    version: 1,
    createdAt: '2026',
    updatedAt: '2026',
    config: defaultModelConfig(),
    plan: defaultPlan(),
    messages: [],
    run: null,
  }));

it('checks the capped select-all box for 100 of 120 conversations so the next click clears it', () => {
  const list = sessions(120);
  let selection = historySelection(list, []);
  expect(selection.limited).toBe(true);
  const selected = selection.allIds;
  selection = historySelection(list, selected);
  expect(selection.chosen).toHaveLength(100);
  expect(selection.allSelected).toBe(true);
  selection = historySelection(list, selection.allSelected ? [] : selection.allIds);
  expect(selection.chosen).toHaveLength(0);
  expect(selection.allSelected).toBe(false);
});

it('ignores stale deleted selections and removes running sessions from deletion candidates', () => {
  const list = sessions(2);
  list[0]!.run = { id: 'run', status: 'running', startedAt: '2026' } as Session['run'];
  const selection = historySelection(list, ['0', '1', 'deleted']);
  expect(selection.chosen.map((s) => s.id)).toEqual(['1']);
  expect(selection.allIds).toEqual(['1']);
  expect(selection.allSelected).toBe(true);
  expect(historySelection(sessions(3), ['1']).partlySelected).toBe(true);
});
