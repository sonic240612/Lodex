import { AppError, type InferenceProvider, type Session } from '@lodex/contracts';
import type { Store } from '@lodex/storage';

/** Metadata GETs only. Never regenerates a response or repeats an external tool. */
export async function reconcileCosts(store: Store, session: Session, provider: InferenceProvider) {
  if (session.run?.status === 'running')
    throw new AppError('BUSY', '진행 중인 응답이 끝난 뒤 비용을 조회하세요.', 409);
  let current = session,
    reconciled = 0;
  const pending = session.messages
    .flatMap((message) => message.costCalls ?? [])
    .filter((call) => call.status !== 'settled');
  for (const call of pending.filter((entry) => entry.generationId).slice(0, 4)) {
    try {
      const usage = await provider.getGenerationUsage?.(
        call.generationId!,
        AbortSignal.timeout(3000),
      );
      if (
        !usage ||
        usage.generationId !== call.generationId ||
        typeof usage.costUsd !== 'number' ||
        !Number.isFinite(usage.costUsd) ||
        usage.costUsd < 0
      )
        continue;
      current = await store.recordModelCall(session.id, {
        ...call,
        status: 'settled',
        actualCostUsd: usage.costUsd,
        ...(typeof usage.inputTokens === 'number' ? { inputTokens: usage.inputTokens } : {}),
        ...(typeof usage.outputTokens === 'number' ? { outputTokens: usage.outputTokens } : {}),
        updatedAt: new Date().toISOString(),
      });
      reconciled++;
    } catch (error) {
      if (error instanceof AppError && ['GENERATION_HTTP', 'COST_RECORD'].includes(error.code))
        throw error;
      // Missing/delayed metadata and outages leave reservations unchanged.
    }
  }
  current = await store.session(session.id);
  const remaining = current.messages
    .flatMap((message) => message.costCalls ?? [])
    .filter((call) => call.status !== 'settled');
  const legacy =
    current.autopilot?.costBaseline?.unconfirmed ||
    (current.autopilot?.costUnconfirmed && !remaining.length);
  return {
    session: current,
    reconciled,
    remaining: remaining.length + (legacy ? 1 : 0),
    withoutId: remaining.filter((call) => !call.generationId).length + (legacy ? 1 : 0),
  };
}
