import { z } from 'zod';
import {
  AppError,
  artifactCheckSchema,
  readyAutopilotTasks,
  type ArtifactCheck,
  type AutopilotState,
  type CommandExecution,
  type ExecutionConfig,
  type Project,
  type ToolDefinition,
} from '@lodex/contracts';
import { digest, executeCommand, readText } from '@lodex/tools';

const evidence = z.string().trim().min(10).max(4000).optional();
const taskInput = z.strictObject({ taskId: z.uuid(), evidence });
const goalInput = z.strictObject({ evidence });
const completeGoalInput = z.strictObject({
  evidence: z.string().trim().min(1).max(4000),
  executionIds: z.array(z.uuid()).max(16).optional(),
  artifacts: z
    .array(artifactCheckSchema.required({ sha256: true }))
    .max(16)
    .optional(),
});
export const verificationTools: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'verify_task',
      description:
        'Verify a ready selected task using its saved command and artifacts. A saved command must execute in Docker or a Full Access host; unavailable commands cannot pass from prose. Without a machine verifier, provide evidence for user confirmation. Later changes invalidate earlier checks.',
      parameters: z.toJSONSchema(taskInput),
    },
  },
  {
    type: 'function',
    function: {
      name: 'verify_goal',
      description:
        'Finish the saved plan after all selected tasks have current verification. Runs the saved final command and checks saved artifacts, including earlier artifact hashes. Without a machine verifier, evidence requires user confirmation.',
      parameters: z.toJSONSchema(goalInput),
    },
  },
];
export const goalCompletionTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'complete_goal',
    description:
      'Finish /goal with concrete evidence and successful current-run executionIds, or artifacts with exact read_file SHA-256 hashes. Supplied IDs and files are checked. Evidence alone requests user confirmation. Recheck after later changes. Do not call for a plan, partial progress, or blocker.',
    parameters: z.toJSONSchema(completeGoalInput),
  },
};
export function invalidateVerification(state: AutopilotState) {
  state.workspaceRevision = (state.workspaceRevision ?? 0) + 1;
  state.completedTaskIds = [];
}
export async function verifySavedArtifacts(
  checks: ArtifactCheck[],
  project: Project | undefined,
  signal: AbortSignal,
) {
  if (checks.length && !project)
    throw new AppError('VERIFICATION_PROJECT', '산출물 검증에는 선택한 프로젝트가 필요합니다.');
  const results: { path: string; sha256: string }[] = [];
  for (const check of checks) {
    signal.throwIfAborted();
    const text = await readText(project!, check.path, signal);
    const sha256 = digest(text);
    if (check.sha256 && check.sha256 !== sha256)
      throw new AppError('VERIFICATION_STALE', `산출물이 변경되었습니다: ${check.path}`);
    if (check.contains && !text.includes(check.contains))
      throw new AppError('VERIFICATION_ARTIFACT', `산출물에 필요한 내용이 없습니다: ${check.path}`);
    results.push({ path: check.path, sha256 });
  }
  return results;
}
type VerificationRuntime = {
  project?: Project;
  signal: AbortSignal;
  confirm?: (evidence: string) => Promise<boolean>;
  executeVerification?: (command: string) => Promise<CommandExecution>;
};
export async function completeGoal(
  state: AutopilotState,
  argumentsJson: string,
  runtime: VerificationRuntime & { executions: CommandExecution[] },
) {
  if (!state.goalDriven || state.status !== 'running')
    throw new AppError('GOAL_REQUIRED', '실행 중인 /goal에서만 완료할 수 있습니다.');
  const input = completeGoalInput.parse(JSON.parse(argumentsJson));
  const ids = [...new Set(input.executionIds ?? [])];
  for (const id of ids) {
    const execution = runtime.executions.find((entry) => entry.id === id);
    if (
      !execution ||
      execution.status !== 'completed' ||
      execution.exitCode !== 0 ||
      execution.cleanupPending ||
      execution.verificationRevision !== (state.workspaceRevision ?? 0)
    )
      throw new AppError(
        'VERIFICATION_EXECUTION',
        '이후 변경이 없는 현재 실행의 성공한 명령 기록이 필요합니다.',
      );
  }
  const artifacts = await verifySavedArtifacts(
    input.artifacts ?? [],
    runtime.project,
    runtime.signal,
  );
  if (!ids.length && !artifacts.length) {
    if (!runtime.confirm)
      throw new AppError(
        'VERIFICATION_REQUIRED',
        '명령·산출물 검증 또는 사용자 완료 확인이 필요합니다.',
      );
    if (!(await runtime.confirm(input.evidence)))
      return { completed: false, error: 'VERIFICATION_REJECTED' };
  }
  runtime.signal.throwIfAborted();
  state.evidence.push({
    taskId: null,
    summary: input.evidence,
    passed: true,
    at: new Date().toISOString(),
    source: ids.length ? 'command' : artifacts.length ? 'artifact' : 'user',
    revision: state.workspaceRevision ?? 0,
    ...(ids.length ? { executionIds: ids } : {}),
    ...(artifacts.length ? { artifacts } : {}),
  });
  state.status = 'completed';
  state.reason = '목표 완료: ' + input.evidence;
  return { completed: true, evidence: input.evidence, executionIds: ids, artifacts };
}
export function autopilotVerificationRequest(
  state: AutopilotState,
  name: string,
  argumentsJson: string,
) {
  if (name === 'verify_task') {
    const input = taskInput.parse(JSON.parse(argumentsJson));
    const task = readyAutopilotTasks(state).find((entry) => entry.id === input.taskId);
    if (!task)
      throw new AppError(
        'TASK_NOT_READY',
        '선택 범위의 선행 검증을 통과한 작업만 검증할 수 있습니다.',
      );
    return {
      taskId: input.taskId as string | null,
      command: task.verificationCommand?.trim() || undefined,
      artifacts: task.verificationArtifacts ?? [],
      suppliedEvidence: input.evidence,
    };
  }
  const input = goalInput.parse(JSON.parse(argumentsJson));
  if (
    state.taskIds.some(
      (id) =>
        !state.completedTaskIds.includes(id) ||
        !state.evidence.some(
          (proof) =>
            proof.taskId === id &&
            proof.passed &&
            proof.source &&
            proof.revision === (state.workspaceRevision ?? 0),
        ),
    )
  )
    throw new AppError('GOAL_PENDING', '선택한 작업의 최신 검증이 모두 통과해야 합니다.');
  return {
    taskId: null,
    command: state.plan.verificationCommand?.trim() || undefined,
    artifacts: state.plan.verificationArtifacts ?? [],
    suppliedEvidence: input.evidence,
  };
}
export async function verifyAutopilot(
  options: VerificationRuntime & {
    state: AutopilotState;
    name: string;
    argumentsJson: string;
    config?: ExecutionConfig;
    record?: (execution: CommandExecution) => Promise<void>;
    executor?: typeof executeCommand;
  },
) {
  const { state } = options;
  const {
    taskId,
    command,
    artifacts: checks,
    suppliedEvidence,
  } = autopilotVerificationRequest(state, options.name, options.argumentsJson);
  let execution: CommandExecution | undefined;
  if (command) {
    if (options.executeVerification) execution = await options.executeVerification(command);
    else if (options.project && options.config?.backend === 'docker' && options.record)
      execution = await (options.executor ?? executeCommand)({
        project: options.project,
        config: options.config,
        argumentsJson: JSON.stringify({ command, cwd: '.', timeoutMs: 120000 }),
        signal: options.signal,
        record: options.record,
      });
    else
      throw new AppError(
        'VERIFICATION_UNAVAILABLE',
        '저장한 검증 명령을 실행할 수 없습니다. Docker를 설정하거나 전체 접근을 선택하세요. 설명으로 통과 처리하지 않았습니다.',
      );
    if (execution.status !== 'completed' || execution.exitCode !== 0 || execution.cleanupPending) {
      state.evidence.push({
        taskId,
        executionId: execution.id,
        passed: false,
        at: new Date().toISOString(),
        source: 'command',
        revision: state.workspaceRevision ?? 0,
      });
      return {
        passed: false,
        error: execution.error ?? 'VERIFICATION_FAILED',
        executionId: execution.id,
        exitCode: execution.exitCode,
        output: execution.output,
        cleanupPending: execution.cleanupPending,
      };
    }
  }
  if (!taskId) {
    try {
      for (const proof of state.evidence.filter(
        (entry) => entry.passed && entry.revision === (state.workspaceRevision ?? 0),
      ))
        await verifySavedArtifacts(proof.artifacts ?? [], options.project, options.signal);
    } catch (error) {
      if (!options.signal.aborted) invalidateVerification(state);
      throw error;
    }
  }
  const artifacts = await verifySavedArtifacts(checks, options.project, options.signal);
  if (!command && !artifacts.length) {
    if (!suppliedEvidence || !options.confirm)
      throw new AppError(
        'VERIFICATION_REQUIRED',
        '자동 검증 수단이 없으면 구체적인 결과와 사용자 완료 확인이 필요합니다.',
      );
    if (!(await options.confirm(suppliedEvidence)))
      return { passed: false, error: 'VERIFICATION_REJECTED' };
  }
  options.signal.throwIfAborted();
  state.evidence.push({
    taskId,
    ...(execution ? { executionId: execution.id } : {}),
    ...(suppliedEvidence ? { summary: suppliedEvidence } : {}),
    passed: true,
    at: new Date().toISOString(),
    source: execution ? 'command' : artifacts.length ? 'artifact' : 'user',
    revision: state.workspaceRevision ?? 0,
    ...(artifacts.length ? { artifacts } : {}),
  });
  if (taskId) state.completedTaskIds.push(taskId);
  else {
    state.status = 'completed';
    state.reason = state.wholeGoal
      ? '모든 작업과 최종 검증이 통과했습니다.'
      : '선택한 작업과 최종 검증이 통과했습니다.';
  }
  return {
    passed: true,
    ...(execution
      ? {
          executionId: execution.id,
          exitCode: execution.exitCode,
          output: execution.output,
          cleanupPending: false,
        }
      : {}),
    artifacts,
    readyTasks: readyAutopilotTasks(state).map((task) => ({ id: task.id, title: task.title })),
    completedTaskIds: state.completedTaskIds,
  };
}
