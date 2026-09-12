import { useEffect, useRef, useState } from 'react';
import type { Project, WorktreeRecord } from '@lodex/contracts';
import { createWorktree, nativeDesktop, worktreeList } from './bridge';
import { Icon } from './icons';
export function WorktreeManager({
  projects,
  selectedId,
  onOpen,
  onClose,
}: {
  projects: Project[];
  selectedId: string | null;
  onOpen: (project: Project) => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [source, setSource] = useState(selectedId ?? ''),
    [records, setRecords] = useState<WorktreeRecord[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  useEffect(() => {
    dialog.current?.showModal();
    let live = true;
    void worktreeList()
      .then((value) => {
        if (live) setRecords(value.records);
      })
      .catch((error) => {
        if (live) setError(String(error));
      });
    return () => {
      live = false;
    };
  }, []);
  async function create() {
    setBusy(true);
    setError('');
    try {
      const result = await createWorktree(source);
      setRecords((records) => [...records, result.record]);
      onOpen(result.project);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
      try {
        setRecords((await worktreeList()).records);
      } catch {
        /* Reopen refreshes. */
      }
    } finally {
      setBusy(false);
    }
  }
  return (
    <dialog
      ref={dialog}
      className="settings-dialog integration-dialog"
      onCancel={(event) => {
        if (busy) event.preventDefault();
        else onClose();
      }}
    >
      <div className="dialog-header">
        <h2>Worktree 프로젝트</h2>
        <button className="icon-button" aria-label="닫기" disabled={busy} onClick={onClose}>
          <Icon name="close" />
        </button>
      </div>
      <div className="integration-body">
        <p>
          원본의 현재 커밋에서 별도 브랜치와 폴더를 만듭니다. 원본의 미커밋 변경은 복사하지
          않습니다.
        </p>
        <p>
          새 프로젝트에서 Build 모드로 수정·검토하세요. 원본으로 병합하거나 worktree를 삭제하는
          작업은 아직 Git에서 직접 진행해야 합니다.
        </p>
        <p>Git 필터·훅 실행과 하위 모듈 초기화는 지원하지 않습니다.</p>
        <label>
          원본 프로젝트
          <select
            disabled={busy}
            value={source}
            onChange={(event) => setSource(event.target.value)}
          >
            <option value="">프로젝트 선택</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </label>
        <button
          className="primary-button"
          disabled={busy || !source || !nativeDesktop}
          onClick={() => void create()}
        >
          {busy ? '생성 중…' : 'Worktree 만들기'}
        </button>
        {error && (
          <p role="alert" className="error-text">
            {error}
          </p>
        )}
        {records.map((record) => (
          <section className="integration-section" key={record.id}>
            <strong>{record.branch}</strong>
            <p className="integration-path">{record.path}</p>
            <small>
              {record.status === 'ready'
                ? '사용 가능'
                : record.status === 'creating'
                  ? '생성 중'
                  : '중단됨 · 경로 보존'}{' '}
              · {record.baseCommit.slice(0, 12)}
            </small>
            {record.error && <p>{record.error}</p>}
            {record.projectId && projects.find((project) => project.id === record.projectId) && (
              <button
                onClick={() => onOpen(projects.find((project) => project.id === record.projectId)!)}
              >
                프로젝트 열기
              </button>
            )}
          </section>
        ))}
      </div>
    </dialog>
  );
}
