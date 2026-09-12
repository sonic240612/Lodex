import { randomUUID } from 'node:crypto';
import {
  AppError,
  type Activity,
  type InferenceMessage,
  type InferenceProvider,
  type Project,
  type Session,
  type ToolCall,
  type Usage,
  readyAutopilotTasks,
  activityProposal,
} from '@lodex/contracts';
import { measureRequest, type CompiledContext } from '@lodex/context';
import { runProjectTool, executeCommand } from '@lodex/tools';
import type { Store } from '@lodex/storage';
import { proposePlan } from './planning';
import { verifyAutopilot } from './autopilot';
import { runSkillTool } from './skills';
import type { RunMcp } from './mcp';
import type { RegisteredSkill } from '@lodex/skills';

export const MAX_MODEL_CALLS = 6;
const MAX_TOOL_CALLS = 12;

export class ToolCallAssembler {
  private calls = new Map<number, ToolCall>();
  add(event: { index: number; id?: string; name?: string; arguments?: string }): ToolCall {
    if (!Number.isInteger(event.index) || event.index < 0 || event.index > 3)
      throw new AppError('TOOL_FORMAT', '도구 호출 번호가 잘못되었습니다.');
    const call = this.calls.get(event.index) ?? { id: '', name: '', arguments: '' };
    if (event.id && event.id !== call.id) call.id += event.id;
    if (event.name) call.name += event.name;
    if (event.arguments) call.arguments += event.arguments;
    if (call.id.length > 200 || call.name.length > 100 || Buffer.byteLength(call.arguments) > 16384)
      throw new AppError('TOOL_LIMIT', '도구 요청이 너무 큽니다.');
    this.calls.set(event.index, call);
    return call;
  }
  finish(): ToolCall[] {
    const calls = [...this.calls.entries()].sort(([a], [b]) => a - b);
    if (
      calls.some(([index, call], position) => index !== position || !call.id || !call.name) ||
      new Set(calls.map(([, call]) => call.id)).size !== calls.length
    )
      throw new AppError('TOOL_FORMAT', '완성되지 않았거나 중복된 도구 호출입니다.');
    return calls.map(([, call]) => call);
  }
}

function mergeDetails(target: Record<string, unknown>[], value: unknown) {
  if (!Array.isArray(value))
    throw new AppError('REASONING_FORMAT', '지원하지 않는 reasoning 상태입니다.');
  for (const raw of value) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
      throw new AppError('REASONING_FORMAT', '잘못된 reasoning 상태입니다.');
    const item = raw as Record<string, unknown>;
    const index = item.index;
    if (!Number.isInteger(index) || (index as number) < 0 || (index as number) > 127)
      throw new AppError('REASONING_FORMAT', 'reasoning 상태에 유효한 index가 필요합니다.');
    let old = target.find((v) => v.index === index);
    if (!old) {
      old = {};
      target.push(old);
    }
    for (const [key, field] of Object.entries(item)) {
      if (['text', 'summary', 'data'].includes(key) && typeof field === 'string')
        old[key] = String(old[key] ?? '') + field;
      else {
        if (old[key] !== undefined && JSON.stringify(old[key]) !== JSON.stringify(field))
          throw new AppError('REASONING_FORMAT', 'reasoning 상태의 식별자가 변경되었습니다.');
        old[key] = field;
      }
    }
  }
  if (Buffer.byteLength(JSON.stringify(target)) > 131072)
    throw new AppError('REASONING_LIMIT', 'reasoning 상태 저장 한도를 초과했습니다.');
}
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
}) {
  const { store, session, provider, context, controller, project } = options;
  const runId = session.run!.id;
  const autopilot =
    session.autopilot?.runId === runId ? structuredClone(session.autopilot) : undefined;
  const maxModels = autopilot?.limits.modelCalls ?? MAX_MODEL_CALLS;
  const maxTools = autopilot?.limits.toolCalls ?? MAX_TOOL_CALLS;
  const signal = AbortSignal.any([
    controller.signal,
    AbortSignal.timeout(
      autopilot
        ? Math.max(
            1,
            autopilot.limits.minutes * 60000 - (Date.now() - Date.parse(autopilot.startedAt)),
          )
        : 300000,
    ),
  ]);
  const activities: Activity[] = [];
  const continuation: InferenceMessage[] = [];
  const rounds: Partial<Usage>[] = [];
  const usedIds = new Set<string>();
  let content = '',
    lastSave = 0,
    toolCount = 0;
  let emptyRounds = 0,
    repeatedResults = 0,
    previousResult = '';
  const usage = () => aggregate(rounds, session.config.provider === 'openrouter');
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
  try {
    for (let step = 0; step < maxModels; step++) {
      signal.throwIfAborted();
      const request = {
        ...context.request,
        messages: [...context.request.messages, ...continuation],
      };
      const manifest = {
        ...context.manifest,
        ...measureRequest(request),
        messageCount: request.messages.length,
      };
      if (autopilot) {
        if (
          autopilot.reservedOutputTokens + session.config.maxTokens >
          autopilot.limits.outputTokens
        )
          throw new AppError(
            'OUTPUT_BUDGET',
            '출력 토큰 예약 예산에 도달했습니다. 검증 완료로 표시하지 않고 멈췄습니다.',
          );
        autopilot.modelCalls++;
        autopilot.reservedOutputTokens += session.config.maxTokens;
      }
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
            if (event.provider !== session.config.provider || event.model !== session.config.model)
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
            content:
              'Autopilot is still active. Continue the ready tasks or explain the blocker; prose alone is not verification. Ready task IDs: ' +
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
      if ((!autopilot && step === maxModels - 1) || toolCount + calls.length > maxTools)
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
        if (autopilot) {
          autopilot.toolCalls++;
          await save();
        }
        let result: string;
        if (call.name === 'verify_task' || call.name === 'verify_goal') {
          if (!autopilot || !project || !session.execution)
            throw new AppError(
              'AUTOPILOT_REQUIRED',
              'Autopilot에서만 검증 도구를 사용할 수 있습니다.',
            );
          try {
            const verification = await verifyAutopilot({
              state: autopilot,
              name: call.name,
              argumentsJson: call.arguments,
              project,
              config: session.execution,
              signal,
              ...(options.commandExecutor ? { executor: options.commandExecutor } : {}),
              record: async (execution) => {
                card.execution = structuredClone(execution);
                await store.recordExecution(session.id, card.id, execution);
              },
            });
            result = JSON.stringify(verification);
            if (verification.cleanupPending)
              throw new AppError('CLEANUP_REQUIRED', '검증 컨테이너 정리가 필요합니다.');
          } catch (error) {
            if (card.execution?.cleanupPending) throw error;
            result = JSON.stringify({
              error: error instanceof AppError ? error.code : 'VERIFICATION_INPUT',
              message: error instanceof AppError ? error.message : '검증 인자가 올바르지 않습니다.',
            });
          }
        } else if (call.name.startsWith('mcp_')) {
          if (!options.mcp) throw new AppError('MCP_DISABLED', 'MCP 도구가 연결되지 않았습니다.');
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
        } else if (call.name === 'run_command') {
          if (!project || session.mode === 'plan' || session.execution?.backend !== 'docker')
            throw new AppError(
              'EXECUTION_DISABLED',
              '이 대화의 명령 실행이 허용되지 않았습니다.',
              403,
            );
          const execution = await (options.commandExecutor ?? executeCommand)({
            project,
            config: session.execution,
            argumentsJson: call.arguments,
            signal,
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
          if (execution.cleanupPending) throw new AppError('CLEANUP_REQUIRED', execution.error!);
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
          };
          const limit = session.config.eco ? 2400 : 6000;
          if (data.output && data.output.length > limit) {
            data.output =
              data.output.slice(0, limit / 4) +
              '\n[context excerpt; full captured output is in the activity card]\n' +
              data.output.slice((-limit * 3) / 4);
            data.truncated = true;
            data.fullOutputAvailableInActivity = true;
            contextResult = JSON.stringify(data);
          }
        }
        continuation.push({ role: 'tool', content: contextResult, toolCallId: call.id });
        toolCount++;
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
          if (activityProposal(card) || card.planProposal) {
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
    throw new AppError(
      'STEP_LIMIT',
      '모델 호출 예산에 도달했습니다. 아직 검증을 완료하지 못했습니다.',
    );
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
