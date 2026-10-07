import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  autopilotLimitsSchema,
  defaultModelConfig,
  defaultPlan,
  makeCommand,
  type Session,
} from '@lodex/contracts';
import {
  goalExecutionCommand,
  loadGoalExecutionMode,
  saveGoalExecutionMode,
} from './goal-execution';

afterEach(() => vi.unstubAllGlobals());
const session: Session = {
  id: crypto.randomUUID(),
  title: 'goal',
  version: 8,
  createdAt: '',
  updatedAt: '',
  config: defaultModelConfig(),
  plan: defaultPlan(),
  messages: [],
  run: null,
};
const limits = autopilotLimitsSchema.parse({});

describe('goal execution modes', () => {
  it('starts Simple with only a trimmed goal and default limits, without tasks or criteria', () => {
    const command = makeCommand(
      goalExecutionCommand('simple', session, '  Create the app  ', limits, [crypto.randomUUID()]),
    );
    expect(command).toMatchObject({
      type: 'start_goal',
      sessionId: session.id,
      expectedVersion: 8,
      goal: 'Create the app',
      limits,
    });
    expect(command).not.toHaveProperty('taskIds');
    expect(limits).toMatchObject({
      modelCalls: null,
      toolCalls: null,
      minutes: null,
      outputTokens: null,
      costUsd: 1,
    });
  });
  it('keeps Advanced on the saved-plan execution path with selected task IDs', () => {
    const ids = [crypto.randomUUID()];
    expect(makeCommand(goalExecutionCommand('advanced', session, '', limits, ids))).toMatchObject({
      type: 'start_autopilot',
      taskIds: ids,
    });
  });
  it('rejects a blank Simple goal before creating a command', () => {
    expect(() => goalExecutionCommand('simple', session, ' \n ', limits, [])).toThrow('목표');
  });
  it('defaults new conversations to Simple and remembers a valid display preference', () => {
    let value: string | null = null;
    vi.stubGlobal('localStorage', {
      getItem: () => value,
      setItem: (_key: string, next: string) => {
        value = next;
      },
    });
    expect(loadGoalExecutionMode()).toBe('simple');
    saveGoalExecutionMode('advanced');
    expect(loadGoalExecutionMode(session)).toBe('advanced');
    value = 'invalid';
    expect(loadGoalExecutionMode()).toBe('simple');
  });
});
