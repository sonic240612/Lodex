import {
  AppError,
  type Command,
  type InferenceProvider,
  type ModelCallRecord,
  type Session,
  type Usage,
} from '@lodex/contracts';
import {
  finishSemanticCompaction,
  prepareSemanticCompaction,
  measureRequest,
} from '@lodex/context';
import type { Store } from '@lodex/storage';

/** One durable operation per user command; metadata lookup never repeats generation. */
export async function compactManually(options: {
  command: Extract<Command, { type: 'compact_context' }>;
  session: Session;
  store: Store;
  provider: InferenceProvider;
  signal: AbortSignal;
}) {
  const { command, session, store, provider, signal } = options;
  const preparation = prepareSemanticCompaction(session);
  let reservedCostUsd = 0;
  if (preparation.request.config.provider === 'openrouter') {
    const pricing = (await provider.listModels(signal)).find(
      (model) => model.id === preparation.request.config.model,
    )?.pricing;
    if (!pricing)
      throw new AppError(
        'MODEL_PRICING_UNAVAILABLE',
        '요약 모델의 가격을 확인할 수 없어 비용을 예약하지 못했습니다.',
      );
    const input =
      (await provider.countInputTokens?.(preparation.request, signal)) ??
      measureRequest(preparation.request).inputEstimateTokens;
    reservedCostUsd =
      pricing.request +
      Math.ceil(input * 1.05) * pricing.prompt +
      preparation.request.config.maxTokens * pricing.completion;
  }
  let { call } = await store.beginManualCompaction(command, reservedCostUsd);
  let summary = '',
    finishReason: string | null = null,
    toolCall = false,
    finished = false;
  const usage: Partial<Usage> = {};
  const saveCall = async (patch: Partial<ModelCallRecord>) => {
    if (!call) return;
    const updated = { ...call, ...patch, updatedAt: new Date().toISOString() };
    await store.recordModelCall(session.id, updated);
    call = updated;
  };
  try {
    for await (const event of provider.generate(preparation.request, signal)) {
      signal.throwIfAborted();
      if (event.type === 'text_delta') summary += event.text;
      else if (event.type === 'tool_call_delta') toolCall = true;
      else if (event.type === 'finished') {
        finishReason = event.reason;
        finished = true;
      } else if (event.type === 'usage') {
        if (
          call?.generationId &&
          event.usage.generationId &&
          call.generationId !== event.usage.generationId
        )
          throw new AppError('GENERATION_ID', 'OpenRouter 요청 ID가 변경되었습니다.');
        Object.assign(usage, event.usage);
        await saveCall({
          ...(usage.generationId ? { generationId: usage.generationId } : {}),
          ...(typeof usage.inputTokens === 'number' ? { inputTokens: usage.inputTokens } : {}),
          ...(typeof usage.outputTokens === 'number' ? { outputTokens: usage.outputTokens } : {}),
        });
      } else if (event.type === 'error') throw new AppError(event.code, event.message, 502);
    }
    if (finishReason !== 'stop' || toolCall)
      throw new AppError(
        'COMPACTION_MODEL_INVALID',
        '모델이 정상적인 압축 요약을 완료하지 않았습니다. 원문과 이전 요약을 유지했습니다.',
        502,
      );
    return finishSemanticCompaction(
      preparation.fallback,
      summary,
      preparation.request.config.model,
    );
  } catch (error) {
    throw error instanceof AppError
      ? error
      : new AppError(
          'COMPACTION_MODEL_FAILED',
          'LLM 컨텍스트 압축에 실패했습니다. 원문과 이전 요약을 유지했습니다. 연결을 확인하거나 빠른 압축을 사용하세요.',
          502,
        );
  } finally {
    if (call) {
      let actual = finished ? usage.costUsd : null;
      if (
        (!Number.isFinite(actual) || typeof actual !== 'number' || actual < 0) &&
        call.generationId &&
        !signal.aborted
      ) {
        try {
          const resolved = await provider.getGenerationUsage?.(
            call.generationId,
            AbortSignal.any([signal, AbortSignal.timeout(5000)]),
          );
          if (
            resolved?.generationId === call.generationId &&
            typeof resolved.costUsd === 'number' &&
            Number.isFinite(resolved.costUsd) &&
            resolved.costUsd >= 0
          ) {
            actual = resolved.costUsd;
            Object.assign(usage, resolved);
          }
        } catch {
          /* Keep an unconfirmed record for the existing reconciliation endpoint. */
        }
      }
      await saveCall({
        ...(typeof actual === 'number' && Number.isFinite(actual) && actual >= 0
          ? { status: 'settled', actualCostUsd: actual }
          : { status: 'unconfirmed' }),
        ...(typeof usage.inputTokens === 'number' ? { inputTokens: usage.inputTokens } : {}),
        ...(typeof usage.outputTokens === 'number' ? { outputTokens: usage.outputTokens } : {}),
      });
    }
  }
}
