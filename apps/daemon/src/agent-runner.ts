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
} from '@lodex/contracts';
import { measureRequest, type CompiledContext } from '@lodex/context';
import { runProjectTool } from '@lodex/tools';
import type { Store } from '@lodex/storage';

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
}) {
  const { store, session, provider, context, controller, project } = options;
  const runId = session.run!.id;
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(300000)]);
  const activities: Activity[] = [];
  const continuation: InferenceMessage[] = [];
  const rounds: Partial<Usage>[] = [];
  const usedIds = new Set<string>();
  let content = '',
    lastSave = 0,
    toolCount = 0;
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
      ...(terminal ? { status: terminal } : {}),
      ...(error ? { error } : {}),
    });
    lastSave = performance.now();
  };
  try {
    for (let step = 0; step < MAX_MODEL_CALLS; step++) {
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
      await store.updateRun({ sessionId: session.id, runId, context: manifest });
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
        await save('completed');
        return;
      }
      if (finished !== 'tool_calls' || calls.length === 0)
        throw new AppError(
          'INCOMPLETE_RESPONSE',
          '응답 종료 사유: ' + finished + '. 부분 응답을 보존했습니다.',
        );
      if (!project || !request.tools?.length)
        throw new AppError(
          'TOOLS_UNAVAILABLE',
          '프로젝트 도구가 허용되지 않아 실행하지 않았습니다. 프로젝트 선택과 전송 설정을 확인하세요.',
        );
      if (step === MAX_MODEL_CALLS - 1 || toolCount + calls.length > MAX_TOOL_CALLS)
        throw new AppError(
          'STEP_LIMIT',
          '실행 한도(모델 6회·도구 12회)에 도달했습니다. 진행 내용을 확인한 뒤 이어서 요청하세요.',
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
          throw new AppError('TOOL_UNAVAILABLE', '이 요청에 제공되지 않은 도구입니다.');
        const card = cards.get(index)!;
        const result = await runProjectTool(
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
        signal.throwIfAborted();
        card.text = result;
        card.status = 'error' in JSON.parse(result) ? 'failed' : 'completed';
        continuation.push({ role: 'tool', content: result, toolCallId: call.id });
        toolCount++;
        await save();
      }
      if (roundText) content += '\n\n';
    }
  } catch (error) {
    const cancelled = controller.signal.aborted;
    const message = cancelled
      ? '사용자가 응답을 중지했습니다.'
      : signal.aborted
        ? '응답 대기 시간(5분)을 초과했습니다.'
        : error instanceof AppError
          ? error.message
          : '모델 또는 프로젝트에 접근하지 못했습니다. 연결과 경로를 확인하세요.';
    // Store remains authoritative: a persisted cancel always wins over a late update.
    await store.updateRun({
      sessionId: session.id,
      runId,
      text: content.slice(0, 262144),
      activities: activities.map((a) => ({ ...a, text: a.text.slice(0, 32768) })),
      usage: usage(),
      status: cancelled ? 'cancelled' : 'failed',
      error: message,
    });
  }
}
