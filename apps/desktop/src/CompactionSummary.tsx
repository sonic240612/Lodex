import type { Session } from '@lodex/contracts';

export function lastCompaction(session: Session | undefined) {
  const candidates = [
    ...(session?.contextCompaction
      ? [
          {
            ...session.contextCompaction,
            kind: session.contextCompaction.reason === 'manual' ? '수동' : '자동',
          },
        ]
      : []),
    ...(session?.messages ?? []).flatMap((message) =>
      message.runContextCompaction
        ? [{ ...message.runContextCompaction, kind: '실행 중 자동' }]
        : [],
    ),
  ];
  return candidates.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
}
export function CompactionSummary({ session }: { session: Session | undefined }) {
  const value = lastCompaction(session);
  if (!value) return null;
  const before =
      ('originalInputTokens' in value ? value.originalInputTokens : undefined) ??
      value.originalEstimateTokens,
    after =
      ('compactedInputTokens' in value ? value.compactedInputTokens : undefined) ??
      value.compactedEstimateTokens;
  const budget = 'contextBudgetTokens' in value ? value.contextBudgetTokens : undefined;
  const reduction = before > 0 ? Math.max(0, Math.round(((before - after) / before) * 100)) : 0;
  return (
    <div
      className="compaction-summary"
      role="status"
      aria-live="polite"
      title={
        'targetLimited' in value && value.targetLimited
          ? '필수 지침과 현재 요청을 유지하여 목표 20~30%보다 사용량이 높습니다. 대화 원문은 보존됩니다.'
          : '입력 컨텍스트 토큰입니다. 서버의 토큰 계산을 지원하지 않으면 추정치를 사용합니다. 대화 원문은 보존됩니다.'
      }
    >
      <span>
        {value.kind} {value.method === 'semantic' ? 'LLM ' : ''}압축
      </span>
      <span>
        {before.toLocaleString()} → {after.toLocaleString()} 토큰 · {reduction}% 감소
        {budget ? ` · 컨텍스트 ${Math.round((after / budget) * 100)}%` : ''}
      </span>
    </div>
  );
}
