import { useState } from 'react';
import { autopilotLimitsSchema, resolveModelConfig, type Session } from '@lodex/contracts';
import { nativeDesktop, reconcileSessionCosts, sendCommand, snapshot } from './bridge';
import { useWorkspace } from './state';

export function AutopilotPanel({ session }: { session: Session }) {
  const workspace = useWorkspace();
  const [limits, setLimits] = useState(autopilotLimitsSchema.parse({}));
  const [selected, setSelected] = useState<string[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [costStatus, setCostStatus] = useState('');
  const state = session.autopilot;
  const running = session.run?.status === 'running';
  const pendingCosts = session.messages
    .flatMap((message) => message.costCalls ?? [])
    .filter((call) => call.status !== 'settled');
  async function reconcile() {
    setBusy(true);
    setError('');
    setCostStatus('');
    try {
      const result = await reconcileSessionCosts(session);
      workspace.upsert(result.session);
      setCostStatus(
        `${result.reconciled}개 정산 · ${result.remaining}개 미확정` +
          (result.withoutId
            ? ` · 요청 ID가 없는 ${result.withoutId}개 예약은 자동 정산할 수 없습니다.`
            : result.remaining
              ? ' · 잠시 후 다시 조회하세요.'
              : ''),
      );
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  }
  const usesCloud =
    resolveModelConfig(session).provider === 'openrouter' ||
    (session.routing?.subagentsEnabled &&
      (session.routing.subagent ?? session.config).provider === 'openrouter');
  const canStart =
    nativeDesktop &&
    workspace.connected &&
    !running &&
    !busy &&
    !!session.projectId &&
    resolveModelConfig(session).provider !== 'demo';
  async function start() {
    setBusy(true);
    setError('');
    try {
      workspace.upsert(
        (
          await sendCommand({
            type: 'start_autopilot',
            sessionId: session.id,
            expectedVersion: session.version,
            taskIds: selected,
            limits,
          })
        ).session,
      );
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
      try {
        workspace.replace(await snapshot());
      } catch {
        /* Reconnect refreshes. */
      }
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="autopilot-panel" aria-label="Autopilot">
      <strong>{state?.goalDriven ? '/goal 자동 실행' : '계획 자동 실행'}</strong>
      {state && (
        <>
          <p role="status">
            {
              {
                running: '실행 중',
                paused: '일시 정지',
                completed: '검증 통과',
                cancelled: '사용자 중지',
                interrupted: '이전 실행 중단',
              }[state.status]
            }{' '}
            {state.goalDriven
              ? '· 목표: ' + state.plan.goal
              : `· ${state.completedTaskIds.length}/${state.taskIds.length}개 작업 검증`}
          </p>
          <p>{state.reason}</p>
          {JSON.stringify(state.plan) !== JSON.stringify(session.plan) && (
            <p>이 기록은 편집 전 계획의 실행 결과입니다.</p>
          )}
          <dl className="metrics-list">
            <div>
              <dt>모델 호출</dt>
              <dd>{state.modelCalls}</dd>
            </div>
            <div>
              <dt>도구 호출</dt>
              <dd>{state.toolCalls}</dd>
            </div>
            <div>
              <dt>출력 토큰 사용·예약</dt>
              <dd>{state.reservedOutputTokens}</dd>
            </div>
            {(usesCloud || (state.spentCostUsd ?? 0) > 0 || (state.reservedCostUsd ?? 0) > 0) && (
              <div>
                <dt>OpenRouter 비용 사용·예약</dt>
                <dd>
                  ${((state.spentCostUsd ?? 0) + (state.reservedCostUsd ?? 0)).toFixed(6)}/$
                  {(state.limits.costUsd ?? 1).toFixed(2)}
                </dd>
              </div>
            )}
          </dl>
          {!!state.evidence.length && (
            <details>
              <summary>검증 기록 {state.evidence.length}개</summary>
              <ol>
                {state.evidence.map((e, index) => (
                  <li key={index}>
                    {e.taskId
                      ? state.plan.tasks.find((t) => t.id === e.taskId)?.title
                      : '최종 검증'}{' '}
                    ·{' '}
                    {e.passed
                      ? e.revision === (state.workspaceRevision ?? 0) && e.source
                        ? '통과'
                        : '재검증 필요'
                      : '실패'}
                    <small>
                      {e.executionId
                        ? `명령 실행 ${e.executionId.slice(0, 8)}`
                        : `근거 ${(e.summary ?? '').slice(0, 160)}`}
                      {e.source === 'user'
                        ? ' · 사용자 확인'
                        : e.source === 'artifact'
                          ? ' · 파일 확인'
                          : ''}
                    </small>
                  </li>
                ))}
              </ol>
            </details>
          )}
        </>
      )}
      {(state?.costUnconfirmed || pendingCosts.length > 0) && (
        <div>
          <p>기존 요청의 비용을 조회합니다. 목표·계획 실행의 예약은 정산까지 유지됩니다.</p>
          <button disabled={!nativeDesktop || running || busy} onClick={() => void reconcile()}>
            OpenRouter 비용 조회·정산
          </button>
        </div>
      )}
      {costStatus && <p role="status">{costStatus}</p>}
      {!state?.goalDriven && (
        <details>
          <summary>실행 범위·예산</summary>
          <p>선택하지 않으면 전체 작업을 실행합니다. 필요한 선행 작업도 포함됩니다.</p>
          {session.plan.tasks.map((task) => (
            <label className="check-field" key={task.id}>
              <input
                type="checkbox"
                checked={selected.includes(task.id)}
                disabled={running || busy}
                onChange={(e) =>
                  setSelected(
                    e.target.checked
                      ? [...selected, task.id]
                      : selected.filter((id) => id !== task.id),
                  )
                }
              />
              {task.title}
            </label>
          ))}
          <p>모델 호출, 도구 호출, 실행 시간과 출력 토큰에는 실행 한도를 두지 않습니다.</p>
          {usesCloud && (
            <label className="budget-field">
              OpenRouter 비용 한도 (USD)
              <input
                type="number"
                min={0.01}
                max={1000}
                step={0.01}
                value={limits.costUsd}
                disabled={running || busy}
                onChange={(e) => setLimits({ ...limits, costUsd: Number(e.target.value) })}
              />
            </label>
          )}
        </details>
      )}
      {!state?.goalDriven && (
        <p>
          저장한 계획과 완료 기준을 사용합니다. Docker 명령 실행을 켜고 검증 명령을 저장한 경우에는
          명령으로 확인합니다. 저장한 검증 파일은 내용·해시를 확인하며, 자동 검증 수단이 없으면
          사용자 완료 확인을 요청합니다. 이후 변경하면 이전 검증이 무효화됩니다.
        </p>
      )}
      {!state?.goalDriven && (
        <button className="save-plan" disabled={!canStart} onClick={() => void start()}>
          {busy ? '시작 중…' : state ? '계획 다시 실행' : '계획 실행'}
        </button>
      )}
      {!state?.goalDriven && !canStart && !running && (
        <p>프로젝트 대화에서 모델을 연결하세요. 시작하면 Build 모드로 전환됩니다.</p>
      )}
      {error && (
        <p className="danger-text" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
