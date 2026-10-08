import { t as localize } from './i18n';
import { useEffect, useRef, useState } from 'react';
import {
  emptyTaskList,
  taskCostTotals,
  type ModelConfig,
  type Session,
  type TaskList,
} from '@lodex/contracts';
import { sendCommand } from './bridge';
import { useWorkspace } from './state';
import { Icon } from './icons';

const statusLabel = { pending: '대기', in_progress: '진행 중', completed: '완료', blocked: '막힘' };
export function TaskListPanel({
  session,
  ensureSession,
  onError,
}: {
  session: Session | undefined;
  ensureSession: () => Promise<Session>;
  onError: (message: string) => void;
}) {
  const stored = JSON.stringify(session?.taskList ?? emptyTaskList());
  const [draft, setDraft] = useState<TaskList>(() => JSON.parse(stored));
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [title, setTitle] = useState('');
  const baseline = useRef(stored);
  const connected = useWorkspace((state) => state.connected);
  const locked = busy || session?.run?.status === 'running';
  const modelChoices: { id: string; label: string; config: ModelConfig }[] = session
    ? [
        { id: 'base', label: localize('대화 기본 모델'), config: session.config },
        ...(['plan', 'build', 'subagent', 'summary', 'review'] as const).flatMap((role) =>
          session.routing?.[role]
            ? [
                {
                  id: role,
                  label: localize(
                    '{0} 역할',
                    localize(
                      {
                        plan: '계획',
                        build: '작업',
                        subagent: '서브에이전트',
                        summary: '요약',
                        review: '검토',
                      }[role],
                    ),
                  ),
                  config: session.routing[role]!,
                },
              ]
            : [],
        ),
      ]
    : [];
  function patchTask(
    id: string,
    update: (task: TaskList['tasks'][number]) => TaskList['tasks'][number],
  ) {
    edit({ ...draft, tasks: draft.tasks.map((task) => (task.id === id ? update(task) : task)) });
  }
  useEffect(() => {
    if (!dirty) {
      setDraft(JSON.parse(stored));
      baseline.current = stored;
    }
  }, [stored, dirty]);
  function edit(next: TaskList) {
    const first = next.tasks.findIndex((task) => task.status !== 'completed');
    setDraft({
      ...next,
      active: false,
      tasks: next.tasks.map((task, index) =>
        task.status === 'in_progress' || (task.status === 'blocked' && index !== first)
          ? { ...task, status: 'pending' }
          : task,
      ),
    });
    setDirty(true);
  }
  async function persist() {
    if (stored !== baseline.current)
      throw new Error(
        localize('저장된 작업 계획이 변경되었습니다. 최신 목록을 불러온 뒤 편집하세요.'),
      );
    const target = session ?? (await ensureSession());
    const result = await sendCommand({
      type: 'save_task_list',
      sessionId: target.id,
      expectedVersion: target.version,
      taskList: draft,
    });
    useWorkspace.getState().upsert(result.session);
    setDirty(false);
    return result.session;
  }
  async function submit(start: boolean) {
    setBusy(true);
    try {
      const target = dirty ? await persist() : (session ?? (await ensureSession()));
      if (start) {
        const result = await sendCommand({
          type: 'start_task_list',
          sessionId: target.id,
          expectedVersion: target.version,
        });
        useWorkspace.getState().upsert(result.session);
      }
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="todo-plan" aria-label={localize('작업 계획 목록')}>
      <div className="task-heading">
        <strong>To-do</strong>
        <span>
          {draft.tasks.filter((task) => task.status === 'completed').length} / {draft.tasks.length}
        </span>
      </div>
      <p className="subtle-note">
        {localize(
          'Plan에서 조사한 내용을 순서대로 진행합니다. Plan 응답이 끝나면 Build로 전환됩니다.',
        )}
      </p>
      <ol className="todo-items">
        {draft.tasks.map((task, index) => (
          <li key={task.id} className={'todo-item ' + task.status}>
            <div className="todo-item-heading">
              <span>
                {index + 1}. {localize(statusLabel[task.status])}
              </span>
              <button
                type="button"
                className="icon-button"
                disabled={locked}
                aria-label={task.title + localize(' 작업 삭제')}
                onClick={() =>
                  edit({ ...draft, tasks: draft.tasks.filter((item) => item.id !== task.id) })
                }
              >
                <Icon name="close" size={14} />
              </button>
            </div>
            <input
              className="task-title"
              aria-label={localize('작업 ') + (index + 1) + localize(' 제목')}
              disabled={locked}
              maxLength={500}
              value={task.title}
              onChange={(event) =>
                edit({
                  ...draft,
                  tasks: draft.tasks.map((item) =>
                    item.id === task.id ? { ...item, title: event.target.value } : item,
                  ),
                })
              }
            />
            <details className="task-details">
              <summary>{localize('작업 내용·결과')}</summary>
              <textarea
                className="goal-input"
                aria-label={localize('작업 ') + (index + 1) + localize(' 내용')}
                disabled={locked}
                maxLength={2000}
                value={task.details}
                onChange={(event) =>
                  edit({
                    ...draft,
                    tasks: draft.tasks.map((item) =>
                      item.id === task.id ? { ...item, details: event.target.value } : item,
                    ),
                  })
                }
              />
              {task.summary && <p className="todo-summary">{task.summary}</p>}
              <label>
                {localize('작업 모델')}
                <select
                  aria-label={localize('작업 ') + (index + 1) + localize(' 모델')}
                  disabled={locked}
                  value={
                    !task.model
                      ? ''
                      : (modelChoices.find(
                          (choice) => JSON.stringify(choice.config) === JSON.stringify(task.model),
                        )?.id ?? 'saved')
                  }
                  onChange={(event) =>
                    patchTask(task.id, (item) => {
                      const { model: _model, ...rest } = item;
                      const selected = modelChoices.find(
                        (choice) => choice.id === event.target.value,
                      );
                      return selected ? { ...rest, model: structuredClone(selected.config) } : rest;
                    })
                  }
                >
                  <option value="">{localize('현재 Build 모델 사용')}</option>
                  {modelChoices.map((choice) => (
                    <option key={choice.id} value={choice.id}>
                      {choice.label} · {choice.config.model || localize('미설정')}
                    </option>
                  ))}
                  {task.model &&
                    !modelChoices.some(
                      (choice) => JSON.stringify(choice.config) === JSON.stringify(task.model),
                    ) && (
                      <option value="saved">
                        {localize('저장된 설정 · ')}
                        {task.model.model}
                      </option>
                    )}
                </select>
              </label>
              <p className="field-hint">
                {localize(
                  '설정 → 역할별 모델에 등록한 연결을 선택합니다. 작업에 저장한 모델 설정은 역할을 바꿔도 유지됩니다.',
                )}
              </p>
              {task.model?.provider === 'openrouter' && (
                <>
                  <label className="check-row">
                    <input
                      type="checkbox"
                      checked={task.model.cloudConsent}
                      disabled={locked}
                      onChange={(event) =>
                        patchTask(task.id, (item) => ({
                          ...item,
                          model: { ...item.model!, cloudConsent: event.target.checked },
                        }))
                      }
                    />
                    {localize('이 작업을 OpenRouter로 전송 허용')}
                  </label>
                  <label className="check-row">
                    <input
                      type="checkbox"
                      checked={task.model.projectCloudConsent}
                      disabled={locked}
                      onChange={(event) =>
                        patchTask(task.id, (item) => ({
                          ...item,
                          model: { ...item.model!, projectCloudConsent: event.target.checked },
                        }))
                      }
                    />
                    {localize('프로젝트 내용과 작업 결과 전송 허용')}
                  </label>
                </>
              )}
              <label>
                {localize('작업 비용 상한 (USD)')}
                <input
                  type="number"
                  aria-label={localize('작업 ') + (index + 1) + localize(' 비용 상한')}
                  min="0.001"
                  max="1000"
                  step="0.001"
                  placeholder={localize('공유 예산 사용')}
                  disabled={locked}
                  value={task.costUsd ?? ''}
                  onChange={(event) =>
                    patchTask(task.id, (item) => {
                      const { costUsd: _cost, ...rest } = item;
                      return event.target.value
                        ? { ...rest, costUsd: Number(event.target.value) }
                        : rest;
                    })
                  }
                />
              </label>
              <p className="field-hint">
                {localize(
                  '요약·검토·서브에이전트 비용도 포함합니다. 기존 공유 예산이 더 작으면 그 한도를 따릅니다.',
                )}
              </p>
              {session &&
                (() => {
                  const cost = taskCostTotals(session, task.id);
                  return cost.spent || cost.reserved || cost.unconfirmed ? (
                    <p className="field-hint">
                      {localize('확정 $')}
                      {cost.spent.toFixed(6)}
                      {localize(' · 예약 $')}
                      {cost.reserved.toFixed(6)}
                      {cost.unconfirmed ? localize(' · 정산 대기') : ''}
                    </p>
                  ) : null;
                })()}
            </details>
          </li>
        ))}
      </ol>
      {!draft.tasks.length && (
        <p className="subtle-note">
          {localize('Plan 모드에서 조사를 요청하거나 직접 작업을 추가하세요.')}
        </p>
      )}
      <form
        className="todo-add"
        onSubmit={(event) => {
          event.preventDefault();
          if (!title.trim() || locked || draft.tasks.length >= 100) return;
          edit({
            ...draft,
            tasks: [
              ...draft.tasks,
              {
                id: crypto.randomUUID(),
                title: title.trim(),
                details: '',
                summary: '',
                status: 'pending',
              },
            ],
          });
          setTitle('');
        }}
      >
        <input
          aria-label={localize('새 작업')}
          placeholder={localize('새 작업')}
          maxLength={500}
          disabled={locked}
          value={title}
          onChange={(event) => setTitle(event.target.value)}
        />
        <button
          className="icon-button"
          aria-label={localize('작업 추가')}
          disabled={locked || !title.trim() || draft.tasks.length >= 100}
        >
          <Icon name="plus" size={16} />
        </button>
      </form>
      <div className="todo-actions">
        <button
          type="button"
          className="save-plan"
          disabled={
            locked || !connected || !dirty || draft.tasks.some((task) => !task.title.trim())
          }
          onClick={() => void submit(false)}
        >
          {localize('목록 저장')}
        </button>
        <button
          type="button"
          className="save-plan"
          disabled={
            locked ||
            !connected ||
            !draft.tasks.some((task) => task.status !== 'completed') ||
            draft.tasks.some((task) => !task.title.trim())
          }
          onClick={() => void submit(true)}
        >
          {draft.tasks.some((task) => task.status !== 'pending')
            ? localize('계속 실행')
            : localize('작업 시작')}
        </button>
      </div>
      {dirty && (
        <button
          type="button"
          className="save-plan"
          disabled={locked}
          onClick={() => {
            setDraft(JSON.parse(stored));
            baseline.current = stored;
            setDirty(false);
          }}
        >
          {localize('저장된 목록 불러오기')}
        </button>
      )}
    </section>
  );
}
