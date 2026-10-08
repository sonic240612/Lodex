import type { Session } from '@lodex/contracts';

export const historySelectionLimit = 100;

export function historySelection(sessions: Session[], selected: string[]) {
  const selectable = sessions.filter((session) => session.run?.status !== 'running');
  const chosen = selectable.filter((session) => selected.includes(session.id));
  const capacity = Math.min(historySelectionLimit, selectable.length);
  return {
    chosen,
    allSelected: capacity > 0 && chosen.length >= capacity,
    partlySelected: chosen.length > 0 && chosen.length < capacity,
    limited: selectable.length > historySelectionLimit,
    allIds: selectable.slice(0, historySelectionLimit).map((session) => session.id),
  };
}
