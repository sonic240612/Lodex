import { t as localize } from './i18n';
import { useEffect, useState } from 'react';
import {
  autopilotLimitsSchema,
  resolveModelConfig,
  type Session,
  type Plan,
} from '@lodex/contracts';
import { nativeDesktop, reconcileSessionCosts, snapshot } from './bridge';
import { useWorkspace } from './state';
import type { GoalExecutionMode, GoalLimits } from './goal-execution';

export function AutopilotPanel({
  session,
  tasks,
  mode,
  goal,
  saving,
  onStart,
}: {
  session: Session | undefined;
  tasks: Plan['tasks'];
  mode: GoalExecutionMode;
  goal: string;
  saving: boolean;
  onStart: (limits: GoalLimits, taskIds: string[]) => Promise<void>;
}) {
  const workspace = useWorkspace();
  const [limits, setLimits] = useState(autopilotLimitsSchema.parse({}));
  const [selected, setSelected] = useState<string[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [costStatus, setCostStatus] = useState('');
  const taskIds = tasks.map((task) => task.id).join(',');
  useEffect(() => {
    const available = new Set(tasks.map((task) => task.id));
    setSelected((current) => current.filter((id) => available.has(id)));
  }, [taskIds]);
  const state = session?.autopilot;
  const running = session?.run?.status === 'running';
  const pendingCosts = (session?.messages ?? [])
    .flatMap((message) => message.costCalls ?? [])
    .filter((call) => call.status !== 'settled');
  async function reconcile() {
    if (!session) return;
    setBusy(true);
    setError('');
    setCostStatus('');
    try {
      const result = await reconcileSessionCosts(session);
      workspace.upsert(result.session);
      setCostStatus(
        localize('{0}개 정산 · {1}개 미확정', result.reconciled, result.remaining) +
          (result.withoutId
            ? localize(' · 요청 ID가 없는 {0}개 예약은 자동 정산할 수 없습니다.', result.withoutId)
            : result.remaining
              ? localize(' · 잠시 후 다시 조회하세요.')
              : ''),
      );
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  }
  const executionConfig = session
    ? resolveModelConfig({ ...session, mode: 'build' })
    : workspace.config;
  const usesCloud =
    executionConfig.provider === 'openrouter' ||
    (session?.routing?.subagentsEnabled &&
      (session.routing.subagent ?? session.config).provider === 'openrouter');
  const canStart =
    nativeDesktop &&
    workspace.connected &&
    !running &&
    !busy &&
    !saving &&
    (mode === 'simple' ? !!goal.trim() : !!session?.projectId) &&
    executionConfig.provider !== 'demo' &&
    !!executionConfig.model.trim();
  async function start() {
    setBusy(true);
    setError('');
    try {
      await onStart(limits, selected);
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
    <section className="autopilot-panel" aria-label={localize('목표 실행')}>
      {state && <strong>{localize('실행 상태')}</strong>}
      {state && (
        <>
          <p role="status">
            {
              {
                running: localize('실행 중'),
                paused: localize('일시 정지'),
                completed: localize('검증 통과'),
                cancelled: localize('사용자 중지'),
                interrupted: localize('이전 실행 중단'),
              }[state.status]
            }{' '}
            {!state.goalDriven &&
              localize(
                '· {0}/{1}개 작업 검증',
                state.completedTaskIds.length,
                state.taskIds.length,
              )}
          </p>
          <p>{state.reason}</p>
          {!state.goalDriven && JSON.stringify(state.plan) !== JSON.stringify(session?.plan) && (
            <p>{localize('이 기록은 편집 전 계획의 실행 결과입니다.')}</p>
          )}
          <dl className="metrics-list">
            <div>
              <dt>{localize('모델 호출')}</dt>
              <dd>{state.modelCalls}</dd>
            </div>
            <div>
              <dt>{localize('도구 호출')}</dt>
              <dd>{state.toolCalls}</dd>
            </div>
            <div>
              <dt>{localize('출력 토큰 사용·예약')}</dt>
              <dd>{state.reservedOutputTokens}</dd>
            </div>
            {(usesCloud || (state.spentCostUsd ?? 0) > 0 || (state.reservedCostUsd ?? 0) > 0) && (
              <div>
                <dt>{localize('OpenRouter 비용 사용·예약')}</dt>
                <dd>
                  ${((state.spentCostUsd ?? 0) + (state.reservedCostUsd ?? 0)).toFixed(6)}/$
                  {(state.limits.costUsd ?? 1).toFixed(2)}
                </dd>
              </div>
            )}
          </dl>
          {!!state.evidence.length && (
            <details>
              <summary>
                {localize('검증 기록 ')}
                {state.evidence.length}
                {localize('개')}
              </summary>
              <ol>
                {state.evidence.map((e, index) => (
                  <li key={index}>
                    {e.taskId
                      ? state.plan.tasks.find((t) => t.id === e.taskId)?.title
                      : localize('최종 검증')}{' '}
                    ·{' '}
                    {e.passed
                      ? e.revision === (state.workspaceRevision ?? 0) && e.source
                        ? localize('통과')
                        : localize('재검증 필요')
                      : localize('실패')}
                    <small>
                      {e.executionId
                        ? localize('명령 실행 {0}', e.executionId.slice(0, 8))
                        : localize('근거 {0}', (e.summary ?? '').slice(0, 160))}
                      {e.source === 'user'
                        ? localize(' · 사용자 확인')
                        : e.source === 'artifact'
                          ? localize(' · 파일 확인')
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
          <p>
            {localize(
              '기존 요청의 비용을 조회합니다. 목표·계획 실행의 예약은 정산까지 유지됩니다.',
            )}
          </p>
          <button
            className="secondary-button"
            disabled={!nativeDesktop || running || busy || saving}
            onClick={() => void reconcile()}
          >
            {localize('OpenRouter 비용 조회·정산')}
          </button>
        </div>
      )}
      {costStatus && <p role="status">{costStatus}</p>}
      {mode === 'advanced' && (
        <details>
          <summary>{localize('실행 범위')}</summary>
          <p>
            {localize('선택하지 않으면 전체 작업을 실행합니다. 필요한 선행 작업도 포함됩니다.')}
          </p>
          {tasks.map((task) => (
            <label className="check-field" key={task.id}>
              <input
                type="checkbox"
                checked={selected.includes(task.id)}
                disabled={running || busy || saving}
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
          <p>
            {localize('모델 호출, 도구 호출, 실행 시간과 출력 토큰에는 실행 한도를 두지 않습니다.')}
          </p>
        </details>
      )}
      {usesCloud && (
        <details>
          <summary>{localize('비용 예산')}</summary>
          <label className="budget-field">
            {localize('OpenRouter 비용 한도 (USD)')}
            <input
              type="number"
              min={0.01}
              max={1000}
              step={0.01}
              value={limits.costUsd}
              disabled={running || busy || saving}
              onChange={(e) => setLimits({ ...limits, costUsd: Number(e.target.value) })}
            />
          </label>
        </details>
      )}
      {mode === 'advanced' && (
        <p>
          {localize(
            '저장한 계획과 완료 기준을 사용합니다. Docker 명령 실행을 켜고 검증 명령을 저장한 경우에는 명령으로 확인합니다. 저장한 검증 파일은 내용·해시를 확인하며, 자동 검증 수단이 없으면 사용자 완료 확인을 요청합니다. 이후 변경하면 이전 검증이 무효화됩니다.',
          )}
        </p>
      )}
      <button className="save-plan" disabled={!canStart} onClick={() => void start()}>
        {busy || saving
          ? localize('시작 중…')
          : mode === 'simple'
            ? localize('목표 추진')
            : localize('계획 실행')}
      </button>
      {!canStart && !running && (
        <p>
          {mode === 'simple'
            ? localize('목표를 입력하고 모델을 연결하세요. 시작하면 Build 모드로 전환됩니다.')
            : localize('프로젝트 대화에서 모델을 연결하세요. 시작하면 Build 모드로 전환됩니다.')}
        </p>
      )}
      {error && (
        <p className="danger-text" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
