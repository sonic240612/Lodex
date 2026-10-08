import { t as localize } from './i18n';
import { useState } from 'react';
import type { WorktreePreview, WorktreeResolution } from '@lodex/contracts';
export function WorktreeReviewPanel({
  preview,
  canApply,
  busy,
  onApply,
  onPage,
  onPaths,
}: {
  preview: WorktreePreview;
  canApply: boolean;
  busy: boolean;
  onApply: (resolutions: Record<string, WorktreeResolution>) => void;
  onPage?: ((offset: number) => void) | undefined;
  onPaths?: ((paths: string[]) => void) | undefined;
}) {
  const [selectedPaths, setSelectedPaths] = useState('');
  const [resolutions, setResolutions] = useState<Record<string, WorktreeResolution>>(() =>
    Object.fromEntries(
      preview.files
        .filter((file) => file.conflict && !file.binary)
        .map((file) => [file.path, file.merged]),
    ),
  );
  const unresolved = preview.files.some(
    (file) =>
      file.conflict &&
      (resolutions[file.path] === undefined ||
        (typeof resolutions[file.path] === 'string' &&
          /^(?:<{7}|={7}|>{7}|\|{7})(?: |$)/m.test(resolutions[file.path] as string))),
  );
  return (
    <section className="worktree-review-panel" aria-label={localize('Worktree 변경 검토')}>
      <h3>
        {localize('변경 검토 · ')}
        {preview.files.length}
        {localize('개 파일')}
      </h3>
      <p>
        {localize(
          '현재 원본의 수정도 비교합니다. 적용은 파일만 변경하며 Git 인덱스와 커밋은 유지합니다.',
        )}
      </p>
      {preview.totalPaths !== undefined && (
        <p>
          {localize('전체 ')}
          {preview.totalPaths}
          {localize('개 경로 · 현재 페이지의 변경만 적용됩니다.')}
        </p>
      )}
      {onPage && (
        <div className="edit-actions">
          <button type="button" disabled={busy || !preview.offset} onClick={() => onPage(0)}>
            {localize('첫 페이지')}
          </button>
          <button
            type="button"
            disabled={busy || preview.nextOffset == null}
            onClick={() => preview.nextOffset != null && onPage(preview.nextOffset)}
          >
            {localize('다음 페이지')}
          </button>
        </div>
      )}
      {onPaths && (
        <div className="worktree-path-selection">
          <label>
            {localize('검토할 파일 경로 · 한 줄에 하나')}
            <textarea
              rows={2}
              disabled={busy}
              value={selectedPaths}
              onChange={(event) => setSelectedPaths(event.target.value)}
              placeholder={preview.paths?.slice(0, 3).join('\n')}
            />
          </label>
          <button
            type="button"
            disabled={busy || !selectedPaths.trim()}
            onClick={() =>
              onPaths(
                selectedPaths
                  .split(/\r?\n/)
                  .map((path) => path.trim())
                  .filter(Boolean),
              )
            }
          >
            {localize('선택한 파일 검토')}
          </button>
        </div>
      )}
      {preview.files.map((file) => (
        <details key={file.path} open={file.conflict}>
          <summary>
            {file.path}
            {file.conflict
              ? localize(' · 충돌 해결 필요')
              : file.merged === null
                ? localize(' · 삭제')
                : localize(' · 적용 가능')}
          </summary>
          <pre>{file.diff}</pre>
          {file.diffTruncated && (
            <p>
              {localize(
                '차이 표시를 줄였습니다. 아래 파일 내용을 확인하거나 원본·Worktree 내용을 선택하세요.',
              )}
            </p>
          )}
          {file.diffTruncated && !file.binary && (
            <details>
              <summary>{localize('전체 파일 내용 확인')}</summary>
              <p>{localize('현재 원본')}</p>
              <pre>{file.before}</pre>
              <p>{localize('적용할 내용')}</p>
              <pre>{file.merged}</pre>
            </details>
          )}
          {file.binary && (
            <p>
              {localize('원본 ')}
              {file.beforeBytes?.toLocaleString()} bytes · SHA-256{' '}
              {file.beforeHash ?? localize('없음')}
              <br />
              Worktree {file.theirsBytes?.toLocaleString()} bytes · SHA-256{' '}
              {file.theirsHash ?? localize('없음')}
            </p>
          )}
          {file.conflict && (
            <div className="worktree-conflict-editor">
              <div className="edit-actions">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    setResolutions((current) => ({
                      ...current,
                      [file.path]: file.binary ? { choice: 'ours' } : file.before,
                    }))
                  }
                >
                  {localize('원본 유지')}
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    setResolutions((current) => ({
                      ...current,
                      [file.path]: file.binary ? { choice: 'theirs' } : file.theirs,
                    }))
                  }
                >
                  {localize('Worktree 내용 사용')}
                </button>
              </div>
              {file.binary &&
                resolutions[file.path] &&
                typeof resolutions[file.path] === 'object' && (
                  <p>
                    {(resolutions[file.path] as { choice: string }).choice === 'ours'
                      ? localize('원본 유지 선택됨')
                      : localize('Worktree 내용 선택됨')}
                  </p>
                )}
              {!file.binary && (
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
                  {localize('파일 삭제')}
                </label>
              )}
              {!file.binary && resolutions[file.path] !== null && (
                <textarea
                  aria-label={localize('충돌 해결 {0}', file.path)}
                  rows={10}
                  maxLength={2097152}
                  value={
                    typeof resolutions[file.path] === 'string'
                      ? (resolutions[file.path] as string)
                      : ''
                  }
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
      {!canApply && <p>{localize('원본 프로젝트의 Build 대화에서 실행이 끝난 뒤 적용하세요.')}</p>}
      <button
        type="button"
        className="primary-button"
        disabled={busy || !canApply || unresolved || !preview.files.length}
        onClick={() => onApply(resolutions)}
      >
        {localize('검토한 변경 적용')}
      </button>
      {unresolved && <p>{localize('충돌 표시를 제거하거나 사용할 내용을 선택하세요.')}</p>}
    </section>
  );
}
