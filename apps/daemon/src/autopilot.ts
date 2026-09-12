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

const taskInput = z.strictObject({ taskId: z.uuid() });
const goalInput = z.strictObject({});
export const verificationTools: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'verify_task',
      description:
        'Run the saved USER-DEFINED verification command for one ready selected task. Only exit code 0 with confirmed cleanup records a pass. Supply the task ID from the working brief. A failed check returns output so you can fix the problem and retry. Does not change manual checkboxes.',
      parameters: z.toJSONSchema(taskInput),
    },
  },
  {
    type: 'function',
    function: {
      name: 'verify_goal',
      description:
        'Finish Autopilot after every selected task has passed its check. Runs the saved final goal verification command. Call only when no proposed edits need review. A successful result ends the run; include your explanation before calling this tool.',
      parameters: z.toJSONSchema(goalInput),
    },
  },
];

export async function verifyAutopilot(options: {
  state: AutopilotState;
  name: string;
  argumentsJson: string;
  project: Project;
  config: ExecutionConfig;
  signal: AbortSignal;
  record: (execution: CommandExecution) => Promise<void>;
  executor?: typeof executeCommand;
}) {
  const { state, name } = options;
  let taskId: string | null = null,
    command: string;
  if (name === 'verify_task') {
    taskId = taskInput.parse(JSON.parse(options.argumentsJson)).taskId;
    const task = readyAutopilotTasks(state).find((task) => task.id === taskId);
    if (!task)
      throw new AppError(
        'TASK_NOT_READY',
        '선택 범위의 선행 검증을 통과한 작업만 검증할 수 있습니다.',
      );
    command = task.verificationCommand!;
  } else {
    goalInput.parse(JSON.parse(options.argumentsJson));
    if (state.taskIds.some((id) => !state.completedTaskIds.includes(id)))
      throw new AppError('GOAL_PENDING', '선택한 작업의 검증이 모두 통과해야 합니다.');
    command = state.plan.verificationCommand!;
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
