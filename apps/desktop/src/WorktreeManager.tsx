import { SettingsSurface } from './SettingsSurface';
import { useEffect, useRef, useState } from 'react';
import type { Project, WorktreeRecord, WorktreePreview, Session } from '@lodex/contracts';
import {
  createWorktree,
  nativeDesktop,
  worktreeList,
  reviewWorktree,
  mergeWorktree,
} from './bridge';
import { WorktreeReviewPanel } from './WorktreeReviewPanel';
import { useWorkspace } from './state';
import { Icon } from './icons';
export function WorktreeManager({
  embedded = false,
  projects,
  selectedId,
  session,
  onOpen,
  onClose,
}: {
  embedded?: boolean;
  projects: Project[];
  selectedId: string | null;
  session?: Session | undefined;
  onOpen: (project: Project) => void;
  onClose: () => void;
}) {
  const [preview, setPreview] = useState<WorktreePreview>();
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
  async function review(id: string) {
    setBusy(true);
    setError('');
    try {
      setPreview(await reviewWorktree(id));
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }
  async function apply(resolutions: Record<string, string | null>) {
    if (!preview || !session) return;
    setBusy(true);
    setError('');
    try {
      const result = await mergeWorktree(session.id, preview.id, resolutions);
      useWorkspace.getState().upsert(result.session);
      setRecords((current) =>
        current.map((record) => (record.id === result.record.id ? result.record : record)),
      );
      setPreview(undefined);
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
    <SettingsSurface
      embedded={embedded}
      aria-busy={busy}
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
          새 프로젝트에서 Build 모드로 수정하고, 변경 검토에서 원본과 비교·충돌 해결·적용할 수
          있습니다. 파일 적용 뒤 Git 커밋과 Worktree 삭제는 직접 진행하세요.
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
            {record.merge && (
              <p>
                최근 적용: {record.merge.status} ·{' '}
                {record.merge.files.filter((file) => file.applied).length}/
                {record.merge.files.length}개 파일
              </p>
            )}
            <button
              disabled={busy || record.status !== 'ready' || !nativeDesktop}
              onClick={() => void review(record.id)}
            >
              변경 검토
            </button>
            {record.projectId && projects.find((project) => project.id === record.projectId) && (
              <button
                onClick={() => onOpen(projects.find((project) => project.id === record.projectId)!)}
              >
                프로젝트 열기
              </button>
            )}
          </section>
        ))}
        {preview && (
          <WorktreeReviewPanel
            key={preview.id}
            preview={preview}
            busy={busy}
            canApply={
              !!session &&
              session.projectId === preview.sourceProjectId &&
              session.mode !== 'plan' &&
              session.run?.status !== 'running'
            }
            onApply={(resolutions) => void apply(resolutions)}
          />
        )}
      </div>
    </SettingsSurface>
  );
}
