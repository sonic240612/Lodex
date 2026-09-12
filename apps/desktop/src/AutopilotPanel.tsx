import { useState } from 'react';
import { autopilotLimitsSchema, type Session } from '@lodex/contracts';
import { nativeDesktop, sendCommand, snapshot } from './bridge';
import { useWorkspace } from './state';

export function AutopilotPanel({ session }: { session: Session }) {
  const workspace = useWorkspace();
  const [limits, setLimits] = useState(autopilotLimitsSchema.parse({}));
  const [selected, setSelected] = useState<string[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const state = session.autopilot;
  const running = session.run?.status === 'running';
  const canStart =
    nativeDesktop &&
    workspace.connected &&
    !running &&
    !busy &&
    session.mode !== 'plan' &&
    session.config.provider === 'llama-server' &&
    session.execution?.backend === 'docker';
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
      <strong>Autopilot</strong>
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
            · {state.completedTaskIds.length}/{state.taskIds.length}개 작업 검증
          </p>
          <p>{state.reason}</p>
          {JSON.stringify(state.plan) !== JSON.stringify(session.plan) && (
            <p>이 기록은 편집 전 계획의 실행 결과입니다.</p>
          )}
          <dl className="metrics-list">
            <div>
              <dt>모델 호출</dt>
              <dd>
                {state.modelCalls}/{state.limits.modelCalls}
              </dd>
            </div>
            <div>
              <dt>도구 호출</dt>
              <dd>
                {state.toolCalls}/{state.limits.toolCalls}
              </dd>
            </div>
            <div>
              <dt>출력 토큰 사용·예약</dt>
              <dd>
                {state.reservedOutputTokens}/{state.limits.outputTokens}
              </dd>
            </div>
          </dl>
          {!!state.evidence.length && (
            <details>
              <summary>검증 기록 {state.evidence.length}개</summary>
              <ol>
                {state.evidence.map((e) => (
                  <li key={e.executionId}>
                    {e.taskId
                      ? state.plan.tasks.find((t) => t.id === e.taskId)?.title
                      : '최종 검증'}{' '}
                    · {e.passed ? '통과' : '실패'}
                    <small>실행 {e.executionId.slice(0, 8)}</small>
                  </li>
                ))}
              </ol>
            </details>
          )}
        </>
      )}
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
        {(
          [
            ['modelCalls', '모델 호출', 1, 64],
            ['toolCalls', '도구 호출', 1, 128],
            ['minutes', '시간 (분)', 1, 120],
            ['outputTokens', '출력 토큰 예산', 1024, 1048576],
          ] as const
        ).map(([key, label, min, max]) => (
          <label className="budget-field" key={key}>
            {label}
            <input
              type="number"
              min={min}
              max={max}
              value={limits[key]}
              disabled={running || busy}
              onChange={(e) => setLimits({ ...limits, [key]: Number(e.target.value) })}
            />
          </label>
        ))}
      </details>
      <p>
        저장한 계획과 검증 명령을 사용합니다. 수정안은 검토를 기다리고, 허용한 컨테이너 명령은
        프로젝트를 변경할 수 있습니다. 다시 실행하면 검증을 새로 수행합니다.
      </p>
      <button className="save-plan" disabled={!canStart} onClick={() => void start()}>
        {busy ? '시작 중…' : state ? '계획 다시 실행' : '계획 실행'}
      </button>
      {!canStart && !running && <p>로컬 모델·Build·Docker 실행 허용이 필요합니다.</p>}
      {error && (
        <p className="danger-text" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
