import { useEffect, useRef, useState } from 'react';
import { emptyTaskList, type Session, type TaskList } from '@lodex/contracts';
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
      throw new Error('저장된 작업 계획이 변경되었습니다. 최신 목록을 불러온 뒤 편집하세요.');
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
    <section className="todo-plan" aria-label="작업 계획 목록">
      <div className="task-heading">
        <strong>To-do</strong>
        <span>
          {draft.tasks.filter((task) => task.status === 'completed').length} / {draft.tasks.length}
        </span>
      </div>
      <p className="subtle-note">
        Plan에서 조사한 내용을 순서대로 진행합니다. Plan 응답이 끝나면 Build로 전환됩니다.
      </p>
      <ol className="todo-items">
        {draft.tasks.map((task, index) => (
          <li key={task.id} className={'todo-item ' + task.status}>
            <div className="todo-item-heading">
              <span>
                {index + 1}. {statusLabel[task.status]}
              </span>
              <button
                type="button"
                className="icon-button"
                disabled={locked}
                aria-label={task.title + ' 작업 삭제'}
                onClick={() =>
                  edit({ ...draft, tasks: draft.tasks.filter((item) => item.id !== task.id) })
                }
              >
                <Icon name="close" size={14} />
              </button>
            </div>
            <input
              className="task-title"
              aria-label={'작업 ' + (index + 1) + ' 제목'}
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
              <summary>작업 내용·결과</summary>
              <textarea
                className="goal-input"
                aria-label={'작업 ' + (index + 1) + ' 내용'}
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
            </details>
          </li>
        ))}
      </ol>
      {!draft.tasks.length && (
        <p className="subtle-note">Plan 모드에서 조사를 요청하거나 직접 작업을 추가하세요.</p>
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
          aria-label="새 작업"
          placeholder="새 작업"
          maxLength={500}
          disabled={locked}
          value={title}
          onChange={(event) => setTitle(event.target.value)}
        />
        <button
          className="icon-button"
          aria-label="작업 추가"
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
          목록 저장
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
          {draft.tasks.some((task) => task.status !== 'pending') ? '계속 실행' : '작업 시작'}
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
          저장된 목록 불러오기
        </button>
      )}
    </section>
  );
}
