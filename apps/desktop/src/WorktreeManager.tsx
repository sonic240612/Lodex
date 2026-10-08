import { t as localize } from './i18n';
import { SettingsSurface } from './SettingsSurface';
import { useEffect, useRef, useState } from 'react';
import type {
  Project,
  WorktreeRecord,
  WorktreePreview,
  WorktreeResolution,
  Session,
} from '@lodex/contracts';
import {
  createWorktree,
  nativeDesktop,
  worktreeList,
  reviewWorktree,
  mergeWorktree,
  manageWorktree,
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
  const [archiveConfirm, setArchiveConfirm] = useState<string>();
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
  async function review(id: string, options: Parameters<typeof reviewWorktree>[1] = {}) {
    setBusy(true);
    setError('');
    try {
      setPreview(await reviewWorktree(id, options));
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }
  async function apply(resolutions: Record<string, WorktreeResolution>) {
    if (!preview || !session) return;
    setBusy(true);
    setError('');
    try {
      const result = await mergeWorktree(session.id, preview.id, resolutions);
      useWorkspace.getState().upsert(result.session);
      setRecords((current) =>
        current.map((record) => (record.id === result.record.id ? result.record : record)),
      );
      setPreview(
        preview.nextOffset == null
          ? undefined
          : await reviewWorktree(preview.worktreeId, {
              offset: preview.nextOffset,
              ...(preview.reviewVersion ? { reviewVersion: preview.reviewVersion } : {}),
            }),
      );
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
  async function manage(action: 'archive' | 'undo', record: WorktreeRecord) {
    if (!session) return;
    setBusy(true);
    setError('');
    try {
      const result = await manageWorktree(action, session.id, record.id);
      useWorkspace.getState().upsert(result.session);
      setRecords((current) =>
        current.map((item) => (item.id === result.record.id ? result.record : item)),
      );
      setArchiveConfirm(undefined);
      setPreview(undefined);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
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
        <h2>{localize('Worktree 프로젝트')}</h2>
        <button
          className="icon-button"
          aria-label={localize('닫기')}
          disabled={busy}
          onClick={onClose}
        >
          <Icon name="close" />
        </button>
      </div>
      <div className="integration-body">
        <p>
          {localize(
            '원본의 현재 커밋에서 별도 브랜치와 폴더를 만듭니다. 원본의 미커밋 변경은 복사하지 않습니다.',
          )}
        </p>
        <p>
          {localize(
            '새 프로젝트에서 Build 모드로 수정하고, 변경 검토에서 원본과 비교·충돌 해결·적용할 수 있습니다. 여러 페이지로 나눠 적용하고 최근 적용을 되돌릴 수 있습니다.',
          )}
        </p>
        <p>{localize('Git 필터·훅 실행과 하위 모듈 초기화는 지원하지 않습니다.')}</p>
        <label>
          {localize('원본 프로젝트')}
          <select
            disabled={busy}
            value={source}
            onChange={(event) => setSource(event.target.value)}
          >
            <option value="">{localize('프로젝트 선택')}</option>
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
          {busy ? localize('생성 중…') : localize('Worktree 만들기')}
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
                ? localize('사용 가능')
                : record.status === 'creating'
                  ? localize('생성 중')
                  : record.status === 'archived'
                    ? localize('정리됨 · 복구 스냅샷 보관')
                    : localize('중단됨 · 경로 보존')}{' '}
              · {record.baseCommit.slice(0, 12)}
            </small>
            {record.error && <p>{record.error}</p>}
            {record.archive && (
              <p className="integration-path">
                {localize('복구 스냅샷: ')}
                {record.archive.ref} · {record.archive.commit.slice(0, 12)}
              </p>
            )}
            {record.merge && (
              <p>
                {localize('최근 적용: ')}
                {record.merge.status} · {record.merge.files.filter((file) => file.applied).length}/
                {record.merge.files.length}
                {localize('개 파일')}
              </p>
            )}
            <button
              disabled={busy || record.status !== 'ready' || !nativeDesktop}
              onClick={() => void review(record.id)}
            >
              {localize('변경 검토')}
            </button>
            {record.status === 'ready' &&
              record.merge?.backupId &&
              record.merge.status !== 'reverted' && (
                <button
                  disabled={
                    busy ||
                    !nativeDesktop ||
                    session?.projectId !== record.sourceProjectId ||
                    session?.mode === 'plan' ||
                    session?.run?.status === 'running'
                  }
                  onClick={() => void manage('undo', record)}
                >
                  {localize('최근 적용 되돌리기')}
                </button>
              )}
            {record.status === 'ready' && (
              <button
                disabled={
                  busy ||
                  !nativeDesktop ||
                  session?.projectId !== record.sourceProjectId ||
                  session?.mode === 'plan' ||
                  session?.run?.status === 'running'
                }
                onClick={() => setArchiveConfirm(record.id)}
              >
                {localize('Worktree 정리')}
              </button>
            )}
            {archiveConfirm === record.id && (
              <div role="group" aria-label={localize('Worktree 정리 확인')}>
                <p>
                  {localize(
                    '원본에 반영했거나 명시적으로 검토한 변경만 정리합니다. 복구용 Git 스냅샷과 브랜치를 보관하고 이 Worktree 폴더를 제거합니다. 실행 중 작업과 Git 제외 파일이 있으면 중단합니다.',
                  )}
                </p>
                <button disabled={busy} onClick={() => void manage('archive', record)}>
                  {localize('스냅샷 저장 후 정리')}
                </button>
                <button disabled={busy} onClick={() => setArchiveConfirm(undefined)}>
                  {localize('취소')}
                </button>
              </div>
            )}
            {record.status === 'ready' &&
              record.projectId &&
              projects.find((project) => project.id === record.projectId) && (
                <button
                  onClick={() =>
                    onOpen(projects.find((project) => project.id === record.projectId)!)
                  }
                >
                  {localize('프로젝트 열기')}
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
            onPage={(offset) =>
              void review(preview.worktreeId, {
                offset,
                ...(offset && preview.reviewVersion
                  ? { reviewVersion: preview.reviewVersion }
                  : {}),
              })
            }
            onPaths={(paths) =>
              void review(preview.worktreeId, {
                paths,
                ...(preview.reviewVersion ? { reviewVersion: preview.reviewVersion } : {}),
              })
            }
          />
        )}
      </div>
    </SettingsSurface>
  );
}
