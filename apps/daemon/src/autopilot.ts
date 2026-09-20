import { z } from 'zod';
import {
  AppError,
  readyAutopilotTasks,
  type AutopilotState,
  type CommandExecution,
  type ExecutionConfig,
  type Project,
  type ToolDefinition,
} from '@lodex/contracts';
import { executeCommand } from '@lodex/tools';

const evidence = z.string().trim().min(10).max(4000).optional();
const taskInput = z.strictObject({ taskId: z.uuid(), evidence });
const goalInput = z.strictObject({ evidence });
const completeGoalInput = z.strictObject({
  evidence: z.string().trim().min(1).max(4000),
});
export const verificationTools: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'verify_task',
      description:
        'Verify one ready selected task against its saved completion criteria. Supply its task ID. If a verification command is saved and Docker command execution is enabled, Lodex runs it. Otherwise include concrete inspection evidence of at least 10 characters. A failed command returns output so you can fix the problem and retry. Does not change manual checkboxes.',
      parameters: z.toJSONSchema(taskInput),
    },
  },
  {
    type: 'function',
    function: {
      name: 'verify_goal',
      description:
        'Finish Autopilot after every selected task has passed. If a final verification command is saved and Docker command execution is enabled, Lodex runs it. Otherwise include concrete final inspection evidence of at least 10 characters. Call only when no proposed edits need review.',
      parameters: z.toJSONSchema(goalInput),
    },
  },
];
export const goalCompletionTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'complete_goal',
    description:
      'Finish a /goal run only after the requested outcome has actually been produced and checked. Provide concise, concrete completion evidence. Do not call this for a plan, partial progress, or an unresolved blocker.',
    parameters: z.toJSONSchema(completeGoalInput),
  },
};

export function completeGoal(state: AutopilotState, argumentsJson: string) {
  if (!state.goalDriven || state.status !== 'running')
    throw new AppError('GOAL_REQUIRED', '실행 중인 /goal에서만 완료할 수 있습니다.');
  const { evidence } = completeGoalInput.parse(JSON.parse(argumentsJson));
  state.status = 'completed';
  state.reason = '목표 완료: ' + evidence;
  return { completed: true, evidence };
}

export async function verifyAutopilot(options: {
  state: AutopilotState;
  name: string;
  argumentsJson: string;
  project?: Project;
  config?: ExecutionConfig;
  signal: AbortSignal;
  record?: (execution: CommandExecution) => Promise<void>;
  executor?: typeof executeCommand;
}) {
  const { state, name } = options;
  let taskId: string | null = null,
    command: string | undefined,
    suppliedEvidence: string | undefined;
  if (name === 'verify_task') {
    const input = taskInput.parse(JSON.parse(options.argumentsJson));
    taskId = input.taskId;
    suppliedEvidence = input.evidence;
    const task = readyAutopilotTasks(state).find((task) => task.id === taskId);
    if (!task)
      throw new AppError(
        'TASK_NOT_READY',
        '선택 범위의 선행 검증을 통과한 작업만 검증할 수 있습니다.',
      );
    command = task.verificationCommand?.trim() || undefined;
  } else {
    const input = goalInput.parse(JSON.parse(options.argumentsJson));
    suppliedEvidence = input.evidence;
    if (state.taskIds.some((id) => !state.completedTaskIds.includes(id)))
      throw new AppError('GOAL_PENDING', '선택한 작업의 검증이 모두 통과해야 합니다.');
    command = state.plan.verificationCommand?.trim() || undefined;
  }
  if (!command || !options.project || !options.config || !options.record) {
    if (!suppliedEvidence)
      throw new AppError(
        'EVIDENCE_REQUIRED',
        'Docker 검증 명령을 사용하지 않는 경우 완료 기준을 확인한 구체적인 근거가 필요합니다.',
      );
    state.evidence.push({
      taskId,
      summary: suppliedEvidence,
      passed: true,
      at: new Date().toISOString(),
    });
    if (taskId) state.completedTaskIds.push(taskId);
    else {
      state.status = 'completed';
      state.reason = state.wholeGoal
        ? '모든 작업을 완료 기준과 제출된 근거로 확인했습니다.'
        : '선택한 작업을 완료 기준과 제출된 근거로 확인했습니다.';
    }
    return {
      passed: true,
      evidence: suppliedEvidence,
      readyTasks: readyAutopilotTasks(state).map((task) => ({ id: task.id, title: task.title })),
      completedTaskIds: state.completedTaskIds,
    };
  }
  const execution = await (options.executor ?? executeCommand)({
    project: options.project,
    config: options.config,
    argumentsJson: JSON.stringify({ command, cwd: '.', timeoutMs: 120000 }),
    signal: options.signal,
    record: options.record,
  });
  const passed =
    execution.status === 'completed' && execution.exitCode === 0 && !execution.cleanupPending;
  state.evidence.push({ taskId, executionId: execution.id, passed, at: new Date().toISOString() });
  if (passed && taskId) state.completedTaskIds.push(taskId);
  else if (passed) {
    state.status = 'completed';
    state.reason = state.wholeGoal
      ? '모든 작업과 최종 검증 명령이 통과했습니다.'
      : '선택한 작업과 최종 검증 명령이 통과했습니다. 선택 밖의 작업은 완료 처리하지 않았습니다.';
  }
  return {
    ...(passed ? {} : { error: execution.error ?? 'VERIFICATION_FAILED' }),
    passed,
    executionId: execution.id,
    exitCode: execution.exitCode,
    output: execution.output,
    truncated: execution.truncated,
    cleanupPending: execution.cleanupPending,
    readyTasks: readyAutopilotTasks(state).map((task) => ({ id: task.id, title: task.title })),
    completedTaskIds: state.completedTaskIds,
  };
}
