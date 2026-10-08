import { t as localize } from './i18n';
import { useEffect, useRef, useState } from 'react';
import type { Session } from '@lodex/contracts';
import { deleteSessions, snapshot } from './bridge';
import { useWorkspace } from './state';
import { Icon } from './icons';
import { historySelection, historySelectionLimit } from './history-selection';

export function ConversationHistory({
  sessions,
  title,
  onSelect,
  onDeleted,
  onError,
}: {
  sessions: Session[];
  title: string;
  onSelect: (id: string) => void;
  onDeleted: () => void;
  onError: (message: string) => void;
}) {
  const workspace = useWorkspace();
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [confirm, setConfirm] = useState<Session[] | null>(null);
  const [pending, setPending] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (confirm) dialog.current?.showModal();
  }, [confirm]);
  const { chosen, allSelected, partlySelected, limited, allIds } = historySelection(
    sessions,
    selected,
  );
  const selectAll = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (selectAll.current) selectAll.current.indeterminate = partlySelected;
  }, [partlySelected, selecting]);
  async function remove() {
    if (!confirm || pending) return;
    setPending(true);
    try {
      const result = await deleteSessions(
        confirm.map((s) => ({ sessionId: s.id, expectedVersion: s.version })),
      );
      // Do not advance the SSE cursor: other sessions may have pending events.
      workspace.removeSessions(result.event.sessionIds);
      setSelected([]);
      setSelecting(false);
      setConfirm(null);
      onDeleted();
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
      setConfirm(null);
      try {
        workspace.replace(await snapshot());
      } catch {
        /* Reconnect will refresh. */
      }
    } finally {
      setPending(false);
    }
  }
  return (
    <>
      <div className="history-caption">
        <span>
          {title} <span className="history-count">{sessions.length}</span>
        </span>
        {!!sessions.length && (
          <button
            className="history-action"
            onClick={() => {
              setSelecting(!selecting);
              setSelected([]);
            }}
          >
            {selecting ? localize('취소') : localize('선택')}
          </button>
        )}
      </div>
      {selecting && (
        <div className="history-selection">
          <label>
            <input
              type="checkbox"
              ref={selectAll}
              aria-label={limited ? localize('대화 최대 100개 선택') : localize('대화 전체 선택')}
              checked={allSelected}
              onChange={(e) => setSelected(e.target.checked ? allIds : [])}
            />{' '}
            {limited ? localize('최대 100개') : localize('전체')}
          </label>
          <button
            className="history-action danger-text"
            disabled={!chosen.length || !workspace.connected}
            onClick={() => setConfirm(chosen)}
          >
            {localize('삭제 (')}
            {chosen.length})
          </button>
        </div>
      )}
      <div className="history">
        {!sessions.length && (
          <p className="history-empty">
            {localize('첫 대화를 시작하면')}
            <br />
            {localize('이곳에 기록이 쌓입니다.')}
          </p>
        )}
        {sessions.map((item) => (
          <div className="history-row" key={item.id}>
            {selecting && (
              <input
                type="checkbox"
                aria-label={item.title + localize(' 선택')}
                title={
                  item.run?.status === 'running'
                    ? localize('응답을 중지한 뒤 삭제할 수 있습니다.')
                    : item.title
                }
                disabled={
                  item.run?.status === 'running' ||
                  (!selected.includes(item.id) && chosen.length >= historySelectionLimit)
                }
                checked={selected.includes(item.id)}
                onChange={(e) =>
                  setSelected(
                    e.target.checked
                      ? [...chosen.map((session) => session.id), item.id]
                      : selected.filter((id) => id !== item.id),
                  )
                }
              />
            )}
            <button
              className={`history-item ${item.id === workspace.selectedId ? 'selected' : ''}`}
              aria-current={item.id === workspace.selectedId ? 'page' : undefined}
              onClick={() => onSelect(item.id)}
            >
              <Icon name="chat" size={16} />
              <span>{item.title}</span>
              {item.run?.status === 'running' && <span className="status-dot pulsing" />}
            </button>
          </div>
        ))}
      </div>
      {confirm && (
        <dialog
          ref={dialog}
          className="delete-dialog"
          onCancel={(e) => {
            e.preventDefault();
            if (!pending) setConfirm(null);
          }}
          aria-labelledby="delete-title"
          aria-describedby="delete-description"
        >
          <h2 id="delete-title">
            {localize('대화 ')}
            {confirm.length}
            {localize('개 삭제')}
          </h2>
          <p id="delete-description">
            {localize(
              '메시지, 활동 기록, Goal과 할 일이 삭제됩니다. 이 작업은 되돌릴 수 없습니다. 프로젝트 폴더의 파일은 유지됩니다.',
            )}
          </p>
          <ul>
            {confirm.map((s) => (
              <li key={s.id}>{s.title}</li>
            ))}
          </ul>
          <div className="dialog-actions">
            <button autoFocus disabled={pending} onClick={() => setConfirm(null)}>
              {localize('취소')}
            </button>
            <button className="danger-button" disabled={pending} onClick={() => void remove()}>
              {pending ? localize('삭제 중…') : localize('삭제')}
            </button>
          </div>
        </dialog>
      )}
    </>
  );
}
