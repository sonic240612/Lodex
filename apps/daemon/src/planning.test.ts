import { describe, expect, it } from 'vitest';
import { defaultPlan } from '@lodex/contracts';
import { proposePlan } from './planning';

describe('reviewed planning', () => {
  const draft = {
    goal: 'Ship a fix',
    criteria: 'Regression passes',
    tasks: [
      { key: 'fix', title: 'Fix', criteria: 'Correct result', dependsOn: [] },
      { key: 'test', title: 'Test', criteria: 'Run regression', dependsOn: ['fix'] },
    ],
  };
  it('converts keys to durable IDs and preserves user instructions', () => {
    const plan = { ...defaultPlan(), instructions: 'Preserve compatibility' };
    const result = proposePlan(JSON.stringify(draft), plan);
    expect(result.plan.tasks[1]!.dependsOn).toEqual([result.plan.tasks[0]!.id]);
    expect(result.plan.instructions).toBe(plan.instructions);
    expect(result.plan.includeInContext).toBe(true);
    expect(result.plan.tasks.every((t) => !t.done)).toBe(true);
    expect(plan.tasks).toEqual([]);
  });
  it('rejects duplicate, missing and cyclic dependencies', () => {
    for (const tasks of [
      [draft.tasks[0], draft.tasks[0]],
      [{ ...draft.tasks[0], dependsOn: ['missing'] }],
      [{ ...draft.tasks[0], dependsOn: ['test'] }, draft.tasks[1]],
    ])
      expect(() => proposePlan(JSON.stringify({ ...draft, tasks }), defaultPlan())).toThrow();
  });
});
