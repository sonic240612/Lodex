import { describe, expect, it } from 'vitest';
import { defaultPlan } from '@lodex/contracts';
import { appendPlanTask, normalizePlanDraft, removePlanTask } from './plan-draft';

describe('plan draft tasks', () => {
  it('does not append blank or duplicate transient rows', () => {
    const base = defaultPlan();
    expect(appendPlanTask(base, '   ', crypto.randomUUID())).toBe(base);
    const id = crypto.randomUUID();
    const added = appendPlanTask(base, '  Check build  ', id);
    expect(added.tasks).toEqual([{ id, title: 'Check build', done: false }]);
    expect(appendPlanTask(added, 'duplicate id', id)).toBe(added);
  });

  it('removes blank rows, duplicate ids and dependencies that no longer exist', () => {
    const first = crypto.randomUUID(),
      removed = crypto.randomUUID();
    const normalized = normalizePlanDraft({
      ...defaultPlan(),
      tasks: [
        { id: first, title: '  Keep  ', done: false, dependsOn: [removed, removed] },
        { id: removed, title: '   ', done: false },
        { id: first, title: 'duplicate', done: false },
      ],
    });
    expect(normalized.tasks).toEqual([{ id: first, title: 'Keep', done: false, dependsOn: [] }]);
  });

  it('removes a task and references to it together', () => {
    const first = crypto.randomUUID(),
      second = crypto.randomUUID();
    const plan = {
      ...defaultPlan(),
      tasks: [
        { id: first, title: 'First', done: false },
        { id: second, title: 'Second', done: false, dependsOn: [first] },
      ],
    };
    expect(removePlanTask(plan, first).tasks).toEqual([
      { id: second, title: 'Second', done: false, dependsOn: [] },
    ]);
  });
});
