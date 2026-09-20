import { useState } from 'react';
import type { EditProposal, ChangeSet, ChangeStatus } from '@lodex/contracts';
import { editAction, nativeDesktop, snapshot } from './bridge';
import { useWorkspace } from './state';

export const editStatusText: Record<ChangeStatus, string> = {
  proposed: '검토 대기',
  applying: '처리 중',
  applied: '적용됨',
  reverted: '되돌림 확인됨',
  rejected: '거절됨',
  conflict: '파일 변경 충돌',
  uncertain: '상태 확인 필요',
  partial: '일부 파일 적용됨',
};
export function EditReview({
  edit,
  activityId,
  sessionId,
}: {
  edit: EditProposal | ChangeSet;
  activityId: string;
  sessionId: string;
}) {
  const workspace = useWorkspace();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirmUndo, setConfirmUndo] = useState(false);
  const files = 'files' in edit ? edit.files : [edit];
  const grouped = 'files' in edit;
  const session = workspace.sessions.find((s) => s.id === sessionId);
  const readOnly = session?.mode === 'plan';
  const running = workspace.sessions.some(
    (s) => s.projectId === session?.projectId && s.run?.status === 'running',
  );
  async function act(action: 'apply' | 'check' | 'undo' | 'reject') {
    if (!session || busy) return;
    setBusy(true);
    setError('');
    try {
      workspace.upsert(
        await editAction({ sessionId, expectedVersion: session.version, activityId, action }),
      );
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
      try {
        workspace.replace(await snapshot());
      } catch {
        /* Reconnect will refresh. */
      }
    } finally {
      setBusy(false);
      setConfirmUndo(false);
    }
  }
  return (
    <div className="edit-review">
      {!nativeDesktop && <p>브라우저 표시 예제입니다. 실제 파일을 읽거나 수정하지 않습니다.</p>}
      <div className="edit-heading">
        <strong>{grouped ? `${files.length}개 파일 변경` : files[0]!.path}</strong>
        <span>{editStatusText[edit.status]}</span>
      </div>
      {edit.thenRun && (
        <div className="activity-section">
          <span>적용 후 검증 · Docker</span>
          <pre>{edit.thenRun.command}</pre>
        </div>
      )}
      {files.map((file) => (
        <div key={file.path} className="file-change">
          {grouped && (
            <div className="edit-heading">
              <strong>{file.path}</strong>
              <span>
                {'kind' in file ? '새 파일' : '수정'}
                {edit.observations?.find((o) => o.path === file.path)
                  ? ' · ' +
                    { before: '변경 전', after: '적용됨', conflict: '충돌', unknown: '확인 필요' }[
                      edit.observations.find((o) => o.path === file.path)!.state
                    ]
                  : ''}
              </span>
            </div>
          )}
          <pre className="edit-diff" aria-label={file.path + ' 변경 비교'}>
            {file.diff.split('\n').map((line, i) => (
              <span
                key={i}
                className={
                  line.startsWith('+')
                    ? 'diff-added'
                    : line.startsWith('-')
                      ? 'diff-removed'
                      : line.startsWith('@@')
                        ? 'diff-hunk'
                        : ''
                }
              >
                {line + '\n'}
              </span>
            ))}
          </pre>
        </div>
      ))}
      {grouped && (
        <p>
          모든 파일을 검토한 뒤 묶음을 적용하세요. 파일은 순서대로 변경되며, 중단되면 상태 확인 후
          남은 변경 적용 또는 되돌리기를 선택할 수 있습니다. 새 파일의 되돌리기는 생성된 파일을
          삭제합니다.
        </p>
      )}
      {edit.status === 'partial' && (
        <p role="status">
          일부 파일만 적용되었습니다. 위 파일별 상태를 확인하고 남은 변경 적용 또는 되돌리기를
          선택하세요.
        </p>
      )}
      {edit.status === 'proposed' && (
        <p>이 변경을 검토한 뒤 적용하세요. 응답이 끝나면 선택한 프로젝트의 이 파일을 수정합니다.</p>
      )}
      {edit.status === 'applied' && (
        <p>
          이 수정안의 내용이 파일에서 확인되었습니다. 테스트 실행 여부는 별도로 확인해야 합니다.
        </p>
      )}
      {edit.status === 'reverted' && <p>변경 전 원본 내용이 파일에서 확인되었습니다.</p>}
      {edit.status === 'rejected' && (
        <p>이 변경은 사용자가 거절했습니다. 파일은 수정하지 않았습니다.</p>
      )}
      {(edit.error || error) && (
        <p className="danger-text" role="alert">
          {error || edit.error}
        </p>
      )}
      <div className="edit-actions">
        {['applied', 'partial'].includes(edit.status) && !confirmUndo && (
          <button
            disabled={!nativeDesktop || !workspace.connected || busy || running || readOnly}
            onClick={() => setConfirmUndo(true)}
          >
            변경 되돌리기
          </button>
        )}
        {['proposed', 'partial'].includes(edit.status) && !confirmUndo && (
          <button
            disabled={!nativeDesktop || !workspace.connected || busy || running || readOnly}
            onClick={() => void act('apply')}
          >
            {busy ? '처리 중…' : edit.status === 'partial' ? '남은 변경 적용' : '검토한 변경 적용'}
          </button>
        )}
        {edit.status === 'proposed' && !confirmUndo && (
          <button
            disabled={!nativeDesktop || !workspace.connected || busy || running}
            onClick={() => void act('reject')}
          >
            거절
          </button>
        )}
        {edit.status !== 'applying' && (
          <button
            disabled={!nativeDesktop || !workspace.connected || busy || running}
            onClick={() => void act('check')}
          >
            파일 상태 확인
          </button>
        )}
        {running && <small>프로젝트 응답이 끝나면 적용할 수 있습니다.</small>}
        {readOnly && <small>파일 변경은 Build 모드에서 사용할 수 있습니다.</small>}
      </div>
      {confirmUndo && ['applied', 'partial'].includes(edit.status) && (
        <div className="undo-confirm" role="group" aria-label="되돌리기 확인">
          <p>
            위 diff의 변경을 취소하고 {grouped ? `${files.length}개 파일의` : files[0]!.path + '의'}{' '}
            원본 내용을 복원합니다. 새로 생성한 파일은 삭제합니다. 적용 이후 파일이 바뀌었으면
            덮어쓰지 않습니다.
          </p>
          <div className="edit-actions">
            <button
              disabled={!workspace.connected || busy || running || readOnly}
              onClick={() => void act('undo')}
            >
              되돌리기 확인
            </button>
            <button disabled={busy} onClick={() => setConfirmUndo(false)}>
              취소
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
