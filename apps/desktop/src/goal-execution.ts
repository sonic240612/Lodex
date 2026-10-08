import { t as localize } from './i18n';
import { autopilotLimitsSchema, type CommandInput, type Session } from '@lodex/contracts';

export type GoalExecutionMode = 'simple' | 'advanced';
export type GoalLimits = ReturnType<typeof autopilotLimitsSchema.parse>;

export function goalExecutionCommand(
  mode: GoalExecutionMode,
  session: Session,
  goal: string,
  limits: GoalLimits,
  taskIds: string[],
): CommandInput {
  const target = { sessionId: session.id, expectedVersion: session.version, limits };
  if (mode === 'simple') {
    if (!goal.trim()) throw new Error(localize('달성할 목표를 입력하세요.'));
    return { ...target, type: 'start_goal', goal: goal.trim() };
  }
  return { ...target, type: 'start_autopilot', taskIds };
}

export function loadGoalExecutionMode(session?: Session): GoalExecutionMode {
  if (session?.autopilot?.goalDriven && session.autopilot.status === 'running') return 'simple';
  try {
    const value = localStorage.getItem('lodex.goalExecutionMode');
    if (value === 'simple' || value === 'advanced') return value;
  } catch {
    /* Display preference only. */
  }
  return session?.autopilot?.goalDriven
    ? 'simple'
    : session?.plan.tasks.length
      ? 'advanced'
      : 'simple';
}

export function saveGoalExecutionMode(mode: GoalExecutionMode) {
  try {
    localStorage.setItem('lodex.goalExecutionMode', mode);
  } catch {
    /* Display preference only. */
  }
}
