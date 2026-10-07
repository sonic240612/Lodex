import { useState } from 'react';
import type { WorktreePreview } from '@lodex/contracts';
export function WorktreeReviewPanel({
  preview,
  canApply,
  busy,
  onApply,
}: {
  preview: WorktreePreview;
  canApply: boolean;
  busy: boolean;
  onApply: (resolutions: Record<string, string | null>) => void;
}) {
  const [resolutions, setResolutions] = useState<Record<string, string | null>>(() =>
    Object.fromEntries(
      preview.files.filter((file) => file.conflict).map((file) => [file.path, file.merged]),
    ),
  );
  const unresolved = preview.files.some(
    (file) =>
      file.conflict &&
      (resolutions[file.path] === undefined ||
        (typeof resolutions[file.path] === 'string' &&
          /^(?:<{7}|={7}|>{7}|\|{7})(?: |$)/m.test(resolutions[file.path]!))),
  );
  return (
    <section className="worktree-review-panel" aria-label="Worktree 변경 검토">
      <h3>변경 검토 · {preview.files.length}개 파일</h3>
      <p>현재 원본의 수정도 비교합니다. 적용은 파일만 변경하며 Git 인덱스와 커밋은 유지합니다.</p>
      {preview.files.map((file) => (
        <details key={file.path} open={file.conflict}>
          <summary>
            {file.path}
            {file.conflict
              ? ' · 충돌 해결 필요'
              : file.merged === null
                ? ' · 삭제'
                : ' · 적용 가능'}
          </summary>
          <pre>{file.diff}</pre>
          {file.conflict && (
            <div className="worktree-conflict-editor">
              <div className="edit-actions">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    setResolutions((current) => ({ ...current, [file.path]: file.before }))
                  }
                >
                  원본 유지
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    setResolutions((current) => ({ ...current, [file.path]: file.theirs }))
                  }
                >
                  Worktree 내용 사용
                </button>
              </div>
              <label className="check-row">
                <input
                  type="checkbox"
                  disabled={busy}
                  checked={resolutions[file.path] === null}
                  onChange={(event) =>
                    setResolutions((current) => ({
                      ...current,
                      [file.path]: event.target.checked ? null : (file.before ?? ''),
                    }))
                  }
                />
                파일 삭제
              </label>
              {resolutions[file.path] !== null && (
                <textarea
                  aria-label={`충돌 해결 ${file.path}`}
                  rows={10}
                  maxLength={32768}
                  value={resolutions[file.path] ?? ''}
                  disabled={busy}
                  onChange={(event) =>
                    setResolutions((current) => ({ ...current, [file.path]: event.target.value }))
                  }
                />
              )}
            </div>
          )}
        </details>
      ))}
      {!canApply && <p>원본 프로젝트의 Build 대화에서 실행이 끝난 뒤 적용하세요.</p>}
      <button
        type="button"
        className="primary-button"
        disabled={busy || !canApply || unresolved || !preview.files.length}
        onClick={() => onApply(resolutions)}
      >
        검토한 변경 적용
      </button>
      {unresolved && <p>충돌 표시를 제거하거나 사용할 내용을 선택하세요.</p>}
    </section>
  );
}
