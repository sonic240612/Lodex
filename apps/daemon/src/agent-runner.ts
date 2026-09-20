import { randomUUID } from 'node:crypto';
import {
  AppError,
  autopilotLimitsSchema,
  type Activity,
  type InferenceMessage,
  type InferenceProvider,
  type Project,
  type Session,
  type ModelConfig,
  type ModelPricing,
  type Usage,
  readyAutopilotTasks,
  activityProposal,
  defaultPermissionMode,
  runCommandSchema,
} from '@lodex/contracts';
import { measureRequest, type CompiledContext } from '@lodex/context';
import { runProjectTool, executeCommand, executeHostCommand, runHostFileTool } from '@lodex/tools';
import type { Store } from '@lodex/storage';
import { proposePlan } from './planning';
import { autopilotVerificationRequest, completeGoal, verifyAutopilot } from './autopilot';
import { runSkillTool } from './skills';
import type { RunMcp } from './mcp';
import type { RegisteredSkill } from '@lodex/skills';
import { parseDelegation, runSubagents } from './subagents';
import type { ObservationPack } from './observations';

import { ToolCallAssembler, mergeDetails } from './tool-stream';
import {
  approvedDecision,
  pendingDecision,
  permissionDecision,
  type PermissionRequest,
} from './permissions';
export { ToolCallAssembler } from './tool-stream';

function aggregate(rounds: Partial<Usage>[], cloud: boolean): Partial<Usage> {
  const sum = (key: 'inputTokens' | 'outputTokens' | 'costUsd') =>
    rounds.every((r) => typeof r[key] === 'number')
      ? rounds.reduce((n, r) => n + r[key]!, 0)
      : null;
  const costUsd = sum('costUsd');
  return {
    ...rounds.at(-1),
    decodeTps: rounds.at(-1)?.decodeTps ?? null,
    prefillTps: rounds.at(-1)?.prefillTps ?? null,
    ttftMs: rounds[0]?.ttftMs ?? null,
    inputTokens: sum('inputTokens'),
    outputTokens: sum('outputTokens'),
    costUsd,
    billing: cloud ? (costUsd === null ? 'pending_reconciliation' : 'reported') : 'not_applicable',
  };
}

export async function runAgent(options: {
  store: Store;
  session: Session;
  provider: InferenceProvider;
  context: CompiledContext;
  controller: AbortController;
  project?: Project;
  commandExecutor?: typeof executeCommand;
  skills?: RegisteredSkill[];
  mcp?: RunMcp;
  subagents?: { config: ModelConfig; provider: InferenceProvider };
  pricing?: (config: ModelConfig) => ModelPricing | undefined;
  waitForApproval?: (activityId: string, signal: AbortSignal) => Promise<Activity>;
  applyApprovedEdit?: (activityId: string) => Promise<void>;
  observations?: ObservationPack;
}) {
  const { store, session, provider, context, controller, project } = options;
  const runId = session.run!.id;
  const persistedAutopilot =
    session.autopilot?.runId === runId ? structuredClone(session.autopilot) : undefined;
  const autopilot = persistedAutopilot
    ? {
        ...persistedAutopilot,
        limits: autopilotLimitsSchema.parse(persistedAutopilot.limits),
        spentCostUsd: persistedAutopilot.spentCostUsd ?? 0,
        reservedCostUsd: persistedAutopilot.reservedCostUsd ?? 0,
        costUnconfirmed: persistedAutopilot.costUnconfirmed ?? false,
      }
    : undefined;
  const maxModels = autopilot?.limits.modelCalls ?? Number.POSITIVE_INFINITY;
  const maxTools = autopilot?.limits.toolCalls ?? Number.POSITIVE_INFINITY;
  const remainingMs = autopilot?.limits.minutes
    ? Math.max(1, autopilot.limits.minutes * 60000 - (Date.now() - Date.parse(autopilot.startedAt)))
    : null;
  const signal = remainingMs
    ? AbortSignal.any([controller.signal, AbortSignal.timeout(remainingMs)])
    : controller.signal;
  const activities: Activity[] = [];
  const continuation: InferenceMessage[] = [];
  const rounds: Partial<Usage>[] = [];
  const usedIds = new Set<string>();
  let content = '',
    lastSave = 0,
    toolCount = 0,
    modelCount = 0;
  let emptyRounds = 0,
    repeatedResults = 0,
    previousResult = '';
  const usage = () => ({
    ...aggregate(
      [
        ...rounds,
        ...activities.flatMap((activity) =>
          (activity.subagents ?? [])
            .filter((child) => child.modelCalls > 0)
            .map((child) => child.usage ?? {}),
        ),
      ],
      session.config.provider === 'openrouter' ||
        activities.some((activity) =>
          activity.subagents?.some(
            (child) => child.modelCalls > 0 && child.provider === 'openrouter',
          ),
        ),
    ),
    decodeTps: rounds.at(-1)?.decodeTps ?? null,
    prefillTps: rounds.at(-1)?.prefillTps ?? null,
    ttftMs: rounds[0]?.ttftMs ?? null,
  });
  const save = async (terminal?: 'completed' | 'failed' | 'cancelled', error?: string) => {
    if (content.length > 262144 || Buffer.byteLength(JSON.stringify(activities)) > 262144)
      throw new AppError('OUTPUT_LIMIT', '응답 또는 활동 기록 한도를 초과했습니다.');
    await store.updateRun({
      sessionId: session.id,
      runId,
      text: content,
      activities,
      continuation,
      usage: usage(),
      ...(autopilot ? { autopilot } : {}),
      ...(terminal ? { status: terminal } : {}),
      ...(error ? { error } : {}),
    });
    lastSave = performance.now();
  };
  const authorize = async (card: Activity, request: PermissionRequest): Promise<boolean> => {
    const decision = permissionDecision(
      session.permissionMode ?? defaultPermissionMode(),
      request,
      session.run?.actor ?? 'desktop',
    );
    if (decision.action === 'allow') {
      card.approval = approvedDecision(decision);
      await save();
      return true;
    }
    if (!options.waitForApproval)
      throw new AppError('APPROVAL_UNAVAILABLE', '이 작업의 권한을 확인할 수 없습니다.', 403);
    card.approval = pendingDecision(decision);
    const approval = options.waitForApproval(card.id, signal);
    await save();
    const decided = await approval;
    if (decided.approval) card.approval = decided.approval;
    return decided.approval?.status === 'approved';
  };
  const reserveModelCall = async (config: ModelConfig, inputEstimateTokens: number) => {
    signal.throwIfAborted();
    if (modelCount >= maxModels)
      throw new AppError('STEP_LIMIT', '부모·서브에이전트의 공유 모델 호출 예산에 도달했습니다.');
    if (
      autopilot &&
      autopilot.limits.outputTokens !== null &&
      autopilot.reservedOutputTokens + config.maxTokens > autopilot.limits.outputTokens
    )
      throw new AppError(
        'OUTPUT_BUDGET',
        '부모·서브에이전트의 공유 출력 토큰 예산에 도달했습니다.',
      );
    let costReservation = 0;
    if (autopilot && config.provider === 'openrouter') {
      if (autopilot.costUnconfirmed)
        throw new AppError(
          'COST_UNCONFIRMED',
          '이전 OpenRouter 호출의 실제 비용을 확인하지 못했습니다. 비용 예약을 유지한 채 자동 실행을 멈췄습니다.',
        );
      const pricing = options.pricing?.(config);
      if (!pricing)
        throw new AppError(
          'MODEL_PRICING_UNAVAILABLE',
          'OpenRouter 모델 가격 정보를 확인할 수 없어 자동 실행을 시작하지 않았습니다.',
        );
      // Context estimates count UTF-8 bytes as tokens and add a small template margin.
      const reservedInput = Math.ceil(inputEstimateTokens * 1.05);
      costReservation =
        pricing.request + reservedInput * pricing.prompt + config.maxTokens * pricing.completion;
      if (
        autopilot.spentCostUsd + autopilot.reservedCostUsd + costReservation >
        autopilot.limits.costUsd + 1e-12
      )
        throw new AppError(
          'COST_BUDGET',
          `다음 OpenRouter 호출의 최대 예상 비용 $${costReservation.toFixed(6)}을 예약하면 비용 한도 $${autopilot.limits.costUsd.toFixed(2)}을 초과합니다.`,
        );
    }
    modelCount++;
    if (autopilot) {
      autopilot.modelCalls++;
      autopilot.reservedOutputTokens += config.maxTokens;
      autopilot.reservedCostUsd += costReservation;
    }
    await save();
    return costReservation;
  };
  const settleModelCall = async (
    config: ModelConfig,
    reservation: number,
    roundUsage: Partial<Usage>,
    completed: boolean,
  ) => {
    if (!autopilot || config.provider !== 'openrouter') return;
    const actual = roundUsage.costUsd;
    if (!completed || typeof actual !== 'number' || !Number.isFinite(actual) || actual < 0) {
      autopilot.costUnconfirmed = true;
      await save();
      throw new AppError(
        'COST_UNCONFIRMED',
        'OpenRouter가 실제 호출 비용을 반환하지 않아 예약 금액을 유지하고 자동 실행을 멈췄습니다.',
      );
    }
    autopilot.reservedCostUsd = Math.max(0, autopilot.reservedCostUsd - reservation);
    autopilot.spentCostUsd += actual;
    if (autopilot.spentCostUsd > autopilot.limits.costUsd + 1e-12) {
      await save();
      throw new AppError(
        'COST_BUDGET',
        `OpenRouter 실제 비용이 설정한 $${autopilot.limits.costUsd.toFixed(2)} 한도에 도달했습니다.`,
      );
    }
    await save();
  };
  const reserveToolCall = async () => {
    signal.throwIfAborted();
    if (toolCount >= maxTools)
      throw new AppError('STEP_LIMIT', '부모·서브에이전트의 공유 도구 호출 예산에 도달했습니다.');
    toolCount++;
    if (autopilot) autopilot.toolCalls++;
    await save();
  };
  try {
    for (;;) {
      signal.throwIfAborted();
      const request = {
        ...context.request,
        messages: options.observations
          ? await options.observations.project(session.id, [
              ...context.request.messages,
              ...continuation,
            ])
          : [...context.request.messages, ...continuation],
      };
      const manifest = {
        ...context.manifest,
        ...measureRequest(request),
        messageCount: request.messages.length,
      };
      const costReservation = await reserveModelCall(session.config, manifest.inputEstimateTokens);
      await store.updateRun({
        sessionId: session.id,
        runId,
        context: manifest,
        ...(autopilot ? { autopilot } : {}),
      });
      signal.throwIfAborted();
      const assembler = new ToolCallAssembler();
      const cards = new Map<number, Activity>();
      const details: Record<string, unknown>[] = [];
      const roundUsage: Partial<Usage> = {};
      rounds.push(roundUsage);
      let roundText = '',
        reasoning = '',
        finished: string | null = null;
      let thinking: Activity | undefined;
      let streamCompleted = false;
      try {
        for await (const event of provider.generate(request, signal)) {
          signal.throwIfAborted();
          if (finished && event.type !== 'usage')
            throw new AppError('AFTER_FINISH', '종료 이후 추가 이벤트를 받았습니다.');
          if (event.type === 'text_delta') {
            roundText += event.text;
            content += event.text;
          } else if (event.type === 'reasoning_delta' || event.type === 'provider_state_delta') {
            if (!thinking) {
              thinking = {
                id: randomUUID(),
                kind: 'thinking',
                label: 'Thinking',
                status: 'running',
                text: '',
              };
              activities.push(thinking);
            }
            if (event.type === 'reasoning_delta') {
              reasoning += event.text;
              thinking.text = reasoning;
            } else {
              if (
                event.provider !== session.config.provider ||
                event.model !== session.config.model
              )
                throw new AppError(
                  'REASONING_SCOPE',
                  '다른 모델의 reasoning 상태를 사용할 수 없습니다.',
                );
              mergeDetails(details, event.data);
            }
          } else if (event.type === 'tool_call_delta') {
            const call = assembler.add(event);
            let card = cards.get(event.index);
            if (!card) {
              card = {
                id: randomUUID(),
                kind: 'tool',
                label: call.name || '도구 요청 수신',
                status: 'running',
                text: '',
              };
              cards.set(event.index, card);
              activities.push(card);
            }
            card.label = call.name || '도구 요청 수신';
            card.arguments = call.arguments;
          } else if (event.type === 'usage') Object.assign(roundUsage, event.usage);
          else if (event.type === 'error') throw new AppError(event.code, event.message, 502);
          else if (event.type === 'finished') finished = event.reason;
          if (performance.now() - lastSave > 180) await save();
        }
        streamCompleted = true;
      } finally {
        await settleModelCall(session.config, costReservation, roundUsage, streamCompleted);
      }
      if (!finished) throw new AppError('MISSING_FINISH', '정상 종료가 확인되지 않았습니다.');
      if (
        autopilot &&
        typeof roundUsage.outputTokens === 'number' &&
        Number.isFinite(roundUsage.outputTokens) &&
        roundUsage.outputTokens >= 0
      )
        autopilot.reservedOutputTokens += roundUsage.outputTokens - session.config.maxTokens;
      if (thinking) thinking.status = 'completed';
      const calls = assembler.finish();
      const assistant: InferenceMessage = {
        role: 'assistant',
        content: roundText,
        ...(details.length
          ? { reasoningDetails: details }
          : reasoning
            ? { reasoningContent: reasoning }
            : {}),
      };
      if (finished === 'stop' && calls.length === 0) {
        continuation.push(assistant);
        signal.throwIfAborted();
        if (autopilot) {
          if (++emptyRounds >= 2)
            throw new AppError(
              'NO_PROGRESS',
              '두 번 연속 도구 실행이나 검증 없이 응답이 끝났습니다. 진행 내용을 확인하세요.',
            );
          continuation.push({
            role: 'user',
            content: autopilot.goalDriven
              ? 'The /goal run is still active. Continue doing the work. Call complete_goal only after the result exists and has been checked; otherwise explain a concrete blocker.'
              : 'Autopilot is still active. Continue the ready tasks or explain the blocker; prose alone is not verification. Ready task IDs: ' +
                JSON.stringify(readyAutopilotTasks(autopilot).map((t) => t.id)),
          });
          if (roundText) content += '\n\n';
          await save();
          continue;
        }
        await options.mcp?.close();
        await save('completed');
        return;
      }
      if (finished !== 'tool_calls' || calls.length === 0)
        throw new AppError(
          'INCOMPLETE_RESPONSE',
          '응답 종료 사유: ' + finished + '. 부분 응답을 보존했습니다.',
        );
      if (!request.tools?.length)
        throw new AppError(
          'TOOLS_UNAVAILABLE',
          '프로젝트 도구가 허용되지 않아 실행하지 않았습니다. 프로젝트 선택과 전송 설정을 확인하세요.',
        );
      if (toolCount + calls.length > maxTools)
        throw new AppError(
          'STEP_LIMIT',
          `실행 한도(모델 ${maxModels}회·도구 ${maxTools}회)에 도달했습니다. 진행 내용을 확인한 뒤 다시 실행하세요.`,
        );
      for (const call of calls) {
        if (usedIds.has(call.id))
          throw new AppError('DUPLICATE_TOOL', '이미 처리한 도구 호출 ID입니다.');
        usedIds.add(call.id);
      }
      continuation.push({ ...assistant, toolCalls: calls });
      await save(); // Durable intent before tool access.
      for (const [index, call] of calls.entries()) {
        signal.throwIfAborted();
        if (!request.tools.some((tool) => tool.function.name === call.name))
          throw new AppError(
            'TOOL_UNAVAILABLE',
            '이 요청에 제공되지 않은 도구라 실행하지 않았습니다.',
          );
        const card = cards.get(index)!;
        const skipRemaining = () => {
          for (let rest = index + 1; rest < calls.length; rest++) {
            const skipped = cards.get(rest)!;
            skipped.status = 'cancelled';
            skipped.text = 'Autopilot이 끝나거나 검토 대기 상태가 되어 실행하지 않았습니다.';
            continuation.push({
              role: 'tool',
              toolCallId: calls[rest]!.id,
              content: JSON.stringify({ skipped: true, reason: skipped.text }),
            });
          }
        };
        await reserveToolCall();
        let result: string;
        let observationResult: string | undefined;
        if (call.name === 'delegate_tasks') {
          if (!options.subagents)
            throw new AppError('SUBAGENTS_DISABLED', '서브에이전트가 활성화되지 않았습니다.');
          result = await runSubagents(parseDelegation(call.arguments), {
            ...options.subagents,
            ...(project ? { project } : {}),
            signal,
            reserveModelCall: (inputEstimateTokens) =>
              reserveModelCall(options.subagents!.config, inputEstimateTokens),
            settleModelCall: (reservation, roundUsage, completed) =>
              settleModelCall(options.subagents!.config, reservation, roundUsage, completed),
            reserveToolCall,
            onUpdate: async (records) => {
              card.subagents = records;
              await save();
            },
          });
        } else if (call.name === 'complete_goal') {
          if (!autopilot) throw new AppError('GOAL_REQUIRED', '실행 중인 /goal이 없습니다.');
          try {
            result = JSON.stringify(completeGoal(autopilot, call.arguments));
          } catch (error) {
            result = JSON.stringify({
              error: error instanceof AppError ? error.code : 'GOAL_INPUT',
              message: error instanceof AppError ? error.message : '완료 근거가 올바르지 않습니다.',
            });
          }
        } else if (call.name === 'verify_task' || call.name === 'verify_goal') {
          if (!autopilot)
            throw new AppError(
              'AUTOPILOT_REQUIRED',
              'Autopilot에서만 검증 도구를 사용할 수 있습니다.',
            );
          try {
            const verificationRequest = autopilotVerificationRequest(
              autopilot,
              call.name,
              call.arguments,
            );
            const commandAllowed =
              !verificationRequest.command ||
              !project ||
              session.execution?.backend !== 'docker' ||
              (await authorize(card, {
                kind: 'command',
                command: verificationRequest.command,
                network: session.execution.network,
                environment: 'docker',
              }));
            if (!commandAllowed)
              result = JSON.stringify({
                status: 'rejected',
                message: 'The user rejected this verification command. Do not claim it ran.',
              });
            else {
              const verification = await verifyAutopilot({
                state: autopilot,
                name: call.name,
                argumentsJson: call.arguments,
                signal,
                ...(project && session.execution?.backend === 'docker'
                  ? { project, config: session.execution }
                  : {}),
                ...(options.commandExecutor ? { executor: options.commandExecutor } : {}),
                record: async (execution) => {
                  card.execution = structuredClone(execution);
                  await store.recordExecution(session.id, card.id, execution);
                },
              });
              result = JSON.stringify(verification);
              if ('cleanupPending' in verification && verification.cleanupPending)
                throw new AppError('CLEANUP_REQUIRED', '검증 컨테이너 정리가 필요합니다.');
            }
          } catch (error) {
            if (card.execution?.cleanupPending) throw error;
            result = JSON.stringify({
              error: error instanceof AppError ? error.code : 'VERIFICATION_INPUT',
              message: error instanceof AppError ? error.message : '검증 인자가 올바르지 않습니다.',
            });
          }
        } else if (call.name === 'recall_observation') {
          if (!options.observations)
            throw new AppError('OBSERVATION_UNAVAILABLE', '보관된 도구 결과를 읽을 수 없습니다.');
          result = await options.observations.recall(session.id, call.arguments);
        } else if (call.name.startsWith('mcp_')) {
          if (!options.mcp) throw new AppError('MCP_DISABLED', 'MCP 도구가 연결되지 않았습니다.');
          if (
            !(await authorize(card, {
              kind: 'mcp',
              target: call.name,
              ...options.mcp.permission(call.name),
            }))
          )
            result = JSON.stringify({
              status: 'rejected',
              message: 'The user rejected this MCP call. Do not claim it ran.',
            });
          else
            result = await options.mcp.call({
              name: call.name,
              argumentsJson: call.arguments,
              mode: session.mode ?? 'build',
              signal,
              maxBytes: session.config.eco ? 12288 : 24576,
              record: async (audit) => {
                card.mcpCall = structuredClone(audit);
                await store.recordMcpCall(session.id, card.id, audit);
              },
            });
        } else if (call.name === 'read_skill' || call.name === 'read_skill_resource') {
          result = await runSkillTool({
            skills: options.skills ?? [],
            name: call.name,
            argumentsJson: call.arguments,
            signal,
            maxBytes: session.config.eco ? 12288 : 24576,
            record: async (provenance) => {
              card.skillRead = provenance;
              await store.recordSkillRead(session.id, card.id, provenance);
            },
          });
        } else if (call.name === 'propose_plan') {
          try {
            card.planProposal = proposePlan(call.arguments, session.plan);
            result = JSON.stringify({
              status: 'proposed',
              goal: card.planProposal.plan.goal,
              tasks: card.planProposal.plan.tasks.length,
              note: 'Awaiting user adoption in UI. Nothing executed.',
            });
          } catch {
            result = JSON.stringify({
              error: 'INVALID_PLAN',
              message: 'Provide valid JSON, unique task keys, existing dependencies and no cycles.',
            });
          }
        } else if (call.name.startsWith('host_') && call.name !== 'run_host_command') {
          if ((session.permissionMode ?? defaultPermissionMode()) !== 'full')
            throw new AppError(
              'FULL_ACCESS_REQUIRED',
              '호스트 파일 도구에는 전체 접근 권한이 필요합니다.',
              403,
            );
          const parsed = JSON.parse(call.arguments) as { path?: unknown };
          const path = typeof parsed.path === 'string' ? parsed.path : '';
          await authorize(card, { kind: 'file', paths: [path] });
          result = await runHostFileTool(call.name, call.arguments, session.mode ?? 'build');
        } else if (call.name === 'run_command') {
          if (!project || session.mode === 'plan' || session.execution?.backend !== 'docker')
            throw new AppError(
              'EXECUTION_DISABLED',
              '이 대화의 명령 실행이 허용되지 않았습니다.',
              403,
            );
          const command = runCommandSchema.parse(JSON.parse(call.arguments)).command;
          if (
            !(await authorize(card, {
              kind: 'command',
              command,
              network: session.execution.network,
              environment: 'docker',
            }))
          )
            result = JSON.stringify({
              status: 'rejected',
              message: 'The user rejected this command. Do not claim it ran.',
            });
          else {
            let capturedOutput = '';
            const execution = await (options.commandExecutor ?? executeCommand)({
              project,
              config: session.execution,
              argumentsJson: call.arguments,
              signal,
              captureOutput: (chunk) => {
                if (chunk) capturedOutput += chunk;
              },
              record: async (execution) => {
                card.execution = structuredClone(execution);
                await store.recordExecution(session.id, card.id, execution);
              },
            });
            result = JSON.stringify({
              ...(execution.status !== 'completed'
                ? { error: execution.error ?? 'COMMAND_FAILED' }
                : {}),
              executionId: execution.id,
              exitCode: execution.exitCode,
              status: execution.status,
              output: execution.output,
              truncated: execution.truncated,
              cleanupPending: execution.cleanupPending,
            });
            observationResult = JSON.stringify({
              ...(execution.status !== 'completed'
                ? { error: execution.error ?? 'COMMAND_FAILED' }
                : {}),
              executionId: execution.id,
              exitCode: execution.exitCode,
              status: execution.status,
              output: capturedOutput || execution.output,
              truncated: execution.truncated,
              cleanupPending: execution.cleanupPending,
            });
            if (execution.cleanupPending) throw new AppError('CLEANUP_REQUIRED', execution.error!);
          }
        } else if (call.name === 'run_host_command') {
          if (
            !project ||
            session.mode === 'plan' ||
            (session.permissionMode ?? defaultPermissionMode()) !== 'full'
          )
            throw new AppError(
              'FULL_ACCESS_REQUIRED',
              '호스트 명령에는 Build 모드와 전체 접근 권한이 필요합니다.',
              403,
            );
          const hostCommand = runCommandSchema.parse(JSON.parse(call.arguments)).command;
          await authorize(card, {
            kind: 'command',
            command: hostCommand,
            network: 'bridge',
            environment: 'host',
          });
          let capturedOutput = '';
          const execution = await executeHostCommand({
            project,
            argumentsJson: call.arguments,
            signal,
            captureOutput: (chunk) => {
              if (chunk) capturedOutput += chunk;
            },
            record: async (execution) => {
              card.execution = structuredClone(execution);
              await store.recordExecution(session.id, card.id, execution);
            },
          });
          result = JSON.stringify({
            ...(execution.status !== 'completed'
              ? { error: execution.error ?? 'COMMAND_FAILED' }
              : {}),
            executionId: execution.id,
            exitCode: execution.exitCode,
            status: execution.status,
            output: execution.output,
            truncated: execution.truncated,
          });
          observationResult = JSON.stringify({
            ...(execution.status !== 'completed'
              ? { error: execution.error ?? 'COMMAND_FAILED' }
              : {}),
            executionId: execution.id,
            exitCode: execution.exitCode,
            status: execution.status,
            output: capturedOutput || execution.output,
            truncated: execution.truncated,
          });
        } else {
          if (!project) throw new AppError('PROJECT_REQUIRED', '프로젝트가 필요합니다.');
          if (
            session.mode === 'plan' &&
            !['list_files', 'read_file', 'search_text'].includes(call.name)
          )
            throw new AppError('PLAN_READ_ONLY', 'Plan 모드에서는 파일을 변경할 수 없습니다.', 403);
          result = await runProjectTool(
            project,
            call.name,
            call.arguments,
            signal,
            (edit) => {
              card.edit = edit;
            },
            (changes) => {
              card.changes = changes;
            },
          );
        }
        if (activityProposal(card) && options.waitForApproval) {
          card.text = result;
          card.status = 'completed';
          const proposal = activityProposal(card)!;
          const paths =
            'files' in proposal ? proposal.files.map((file) => file.path) : [proposal.path];
          const thenRun = proposal.thenRun;
          if (thenRun && (!project || session.execution?.backend !== 'docker'))
            throw new AppError(
              'EXECUTION_DISABLED',
              '수정 후 검증을 함께 실행하려면 이 대화의 Docker 명령 실행을 켜야 합니다.',
              403,
            );
          const permission = permissionDecision(
            session.permissionMode ?? defaultPermissionMode(),
            thenRun
              ? {
                  kind: 'fusion',
                  paths,
                  command: thenRun.command,
                  network: session.execution!.network,
                  environment: 'docker',
                }
              : { kind: 'file', paths },
            session.run?.actor ?? 'desktop',
          );
          const approval = options.waitForApproval(card.id, signal);
          try {
            card.approval =
              permission.action === 'allow'
                ? approvedDecision(permission)
                : pendingDecision(permission);
            await save();
            if (permission.action === 'allow') {
              if (!options.applyApprovedEdit)
                throw new AppError('APPROVAL_UNAVAILABLE', '파일 변경을 적용할 수 없습니다.');
              await options.applyApprovedEdit(card.id);
            }
          } catch (error) {
            controller.abort(error);
            await approval.catch(() => undefined);
            throw error;
          }
          const decided = await approval;
          if (decided.approval) card.approval = decided.approval;
          if (decided.edit) card.edit = decided.edit;
          if (decided.changes) card.changes = decided.changes;
          const decision = activityProposal(decided);
          if (!decision)
            throw new AppError('EDIT_NOT_FOUND', '검토 중인 수정안을 찾을 수 없습니다.');
          if (decision.status === 'applied' && thenRun) {
            let capturedOutput = '';
            const execution = await (options.commandExecutor ?? executeCommand)({
              project: project!,
              config: session.execution!,
              argumentsJson: JSON.stringify(thenRun),
              signal,
              captureOutput: (chunk) => {
                if (chunk) capturedOutput += chunk;
              },
              record: async (execution) => {
                card.execution = structuredClone(execution);
                await store.recordExecution(session.id, card.id, execution);
              },
            });
            const combined = {
              ...(execution.status !== 'completed'
                ? { error: execution.error ?? 'COMMAND_FAILED' }
                : {}),
              status: execution.status,
              editStatus: decision.status,
              validation: {
                command: thenRun.command,
                executionId: execution.id,
                exitCode: execution.exitCode,
                output: execution.output,
                truncated: execution.truncated,
              },
              message:
                execution.status === 'completed'
                  ? 'The approved changes were applied and their fused validation passed.'
                  : 'The approved changes were applied, but their fused validation failed. Inspect the output; do not revert unless requested.',
            };
            result = JSON.stringify(combined);
            observationResult = JSON.stringify({
              ...combined,
              validation: {
                ...combined.validation,
                output: capturedOutput || execution.output,
              },
            });
            if (execution.cleanupPending) throw new AppError('CLEANUP_REQUIRED', execution.error!);
          } else {
            result = JSON.stringify({
              status: decision.status,
              editStatus: decision.status,
              message:
                decision.status === 'applied'
                  ? 'The user approved and applied the proposed changes. Continue from the updated project.'
                  : decision.status === 'rejected'
                    ? 'The user rejected the proposed changes. Do not assume they were applied.'
                    : 'The review finished with status ' +
                      decision.status +
                      '. Inspect before continuing.',
            });
          }
        }
        signal.throwIfAborted();
        card.text = card.execution
          ? JSON.stringify({
              status: card.execution.status,
              exitCode: card.execution.exitCode,
              executionId: card.execution.id,
            })
          : result;
        card.status =
          'error' in JSON.parse(result) || JSON.parse(result).isError === true
            ? 'failed'
            : 'completed';
        let contextResult = result;
        if (card.execution) {
          const data = JSON.parse(result) as {
            output?: string;
            truncated?: boolean;
            fullOutputAvailableInActivity?: boolean;
            validation?: {
              output?: string;
              truncated?: boolean;
              fullOutputAvailableInActivity?: boolean;
            };
          };
          const limit = session.config.eco ? 2400 : 6000;
          const executionResult = data.validation ?? data;
          if (executionResult.output && executionResult.output.length > limit) {
            executionResult.output =
              executionResult.output.slice(0, limit / 4) +
              '\n[context excerpt; full captured output is in the activity card]\n' +
              executionResult.output.slice((-limit * 3) / 4);
            executionResult.truncated = true;
            executionResult.fullOutputAvailableInActivity = true;
            contextResult = JSON.stringify(data);
          }
        }
        if (options.observations && session.config.eco) {
          try {
            contextResult = await options.observations.archive(
              session.id,
              call.name,
              call.id,
              observationResult ?? contextResult,
            );
          } catch {
            // Fail open: archival must never hide a tool result or stop the active run.
          }
        }
        continuation.push({ role: 'tool', content: contextResult, toolCallId: call.id });
        await save();
        if (autopilot) {
          emptyRounds = 0;
          if (autopilot.status === 'completed') {
            // Remaining calls in the same model response are never executed after completion.
            skipRemaining();
            content += '\n\n' + autopilot.reason;
            await save('completed');
            return;
          }
          if (activityProposal(card)?.status === 'proposed' || card.planProposal) {
            skipRemaining();
            autopilot.status = 'paused';
            autopilot.reason = card.planProposal
              ? '계획 제안을 검토한 뒤 다시 실행하세요.'
              : '파일 수정안을 검토하고 적용한 뒤 다시 실행하세요.';
            await save('completed');
            return;
          }
          const signature =
            call.name +
            '\n' +
            call.arguments +
            '\n' +
            (JSON.parse(result).error ? 'error' : result);
          repeatedResults = signature === previousResult ? repeatedResults + 1 : 1;
          previousResult = signature;
          if (repeatedResults >= 3)
            throw new AppError(
              'REPEATED_RESULT',
              '같은 요청과 결과가 세 번 반복되어 멈췄습니다. 원인을 확인하세요.',
            );
        }
      }
      if (roundText) content += '\n\n';
    }
  } catch (error) {
    const cancelled = controller.signal.aborted;
    const message = cancelled
      ? '사용자가 응답을 중지했습니다.'
      : signal.aborted
        ? '설정한 실행 시간을 초과했습니다.'
        : error instanceof AppError
          ? error.message
          : '모델 또는 프로젝트에 접근하지 못했습니다. 연결과 경로를 확인하세요.';
    if (autopilot) {
      autopilot.status = cancelled ? 'cancelled' : 'paused';
      autopilot.reason = message;
    }
    // Store remains authoritative: a persisted cancel always wins over a late update.
    await store.updateRun({
      sessionId: session.id,
      runId,
      text: content.slice(0, 262144),
      activities: activities.map((a) => ({ ...a, text: a.text.slice(0, 32768) })),
      usage: usage(),
      ...(autopilot ? { autopilot } : {}),
      status: cancelled ? 'cancelled' : 'failed',
      error: message,
    });
  } finally {
    await options.mcp?.close();
  }
}
