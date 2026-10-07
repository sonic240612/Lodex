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
  const before = value.originalEstimateTokens,
    after = value.compactedEstimateTokens;
  const reduction = before > 0 ? Math.max(0, Math.round(((before - after) / before) * 100)) : 0;
  return (
    <div
      className="compaction-summary"
      role="status"
      aria-live="polite"
      title="입력 컨텍스트의 추정 토큰입니다. 대화 원문은 보존됩니다."
    >
      <span>{value.kind} 압축</span>
      <span>
        {before.toLocaleString()} → {after.toLocaleString()} 토큰 · {reduction}% 감소
      </span>
    </div>
  );
}
