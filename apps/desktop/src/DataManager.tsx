import { useEffect, useRef, useState } from 'react';
import { backupSettingsSchema, type BackupSnapshot } from '@lodex/contracts';
import {
  backupSnapshot,
  configureBackups,
  createBackup,
  deleteBackup,
  exportBackup,
  nativeDesktop,
} from './bridge';
import { Icon } from './icons';

export function DataManager({ onClose }: { onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [state, setState] = useState<BackupSnapshot>({
    settings: backupSettingsSchema.parse({}),
    backups: [],
  });
  const [draft, setDraft] = useState(state.settings);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(!nativeDesktop);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  useEffect(() => {
    dialog.current?.showModal();
    let active = true;
    if (nativeDesktop)
      void backupSnapshot()
        .then((value) => {
          if (!active) return;
          setState(value);
          setDraft(value.settings);
          setLoaded(true);
        })
        .catch((failure) => {
          if (active) setError(failure instanceof Error ? failure.message : String(failure));
        });
    return () => {
      active = false;
    };
  }, []);
  async function operation(work: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError('');
    setStatus('');
    try {
      await work();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  }
  return (
    <dialog
      className="settings-dialog"
      ref={dialog}
      onCancel={onClose}
      aria-labelledby="data-manager-title"
      aria-busy={busy}
    >
      <div className="dialog-header">
        <h2 id="data-manager-title">데이터와 백업</h2>
        <button className="icon-button" aria-label="데이터 관리 닫기" onClick={onClose}>
          <Icon name="close" />
        </button>
      </div>
      <div className="settings-body">
        {!nativeDesktop && <p className="demo-notice">백업은 데스크톱 앱에서 사용할 수 있습니다.</p>}
        {!loaded && !error && <p role="status">백업 목록을 불러오는 중…</p>}
        <section>
          <h3>보존 정책</h3>
          <label className="check-field">
            <input
              type="checkbox"
              checked={draft.automatic}
              onChange={(event) => setDraft({ ...draft, automatic: event.target.checked })}
            />
            하루에 한 번 자동 백업
          </label>
          <div className="settings-grid">
            <label className="field">
              최대 보관 개수
              <input
                type="number"
                min={1}
                max={100}
                value={draft.retentionCount}
                onChange={(event) =>
                  setDraft({ ...draft, retentionCount: Number(event.target.value) })
                }
              />
            </label>
            <label className="field">
              보관 기간(일)
              <input
                type="number"
                min={1}
                max={3650}
                value={draft.retentionDays}
                onChange={(event) =>
                  setDraft({ ...draft, retentionDays: Number(event.target.value) })
                }
              />
            </label>
          </div>
          <button
            type="button"
            className="secondary-button"
            disabled={!loaded || busy}
            onClick={() =>
              void operation(async () => {
                const next = await configureBackups(backupSettingsSchema.parse(draft));
                setState(next);
                setDraft(next.settings);
                setStatus('보존 정책을 저장했습니다.');
              })
            }
          >
            보존 정책 저장
          </button>
        </section>
        <section>
          <h3>백업</h3>
          <p>
            대화·프로젝트·계획·모델 프로필·Skills·MCP 등록을 저장합니다. API 키, OAuth 토큰,
            Telegram 봇 토큰과 모델 파일은 포함하지 않습니다.
          </p>
          <div className="edit-actions">
            <button
              type="button"
              className="primary-button"
              disabled={!loaded || busy}
              onClick={() =>
                void operation(async () => {
                  const next = await createBackup();
                  setState(next);
                  setStatus('앱 데이터 폴더에 백업했습니다.');
                })
              }
            >
              지금 백업
            </button>
            <button
              type="button"
              disabled={!loaded || busy}
              onClick={() =>
                void operation(async () => {
                  const result = await exportBackup();
                  if (result) setStatus(`내보냈습니다: ${result.path}`);
                })
              }
            >
              다른 위치로 내보내기
            </button>
          </div>
          {state.backups.length ? (
            <ul className="skill-selection-list">
              {state.backups.map((backup) => (
                <li key={backup.name}>
                  <span>
                    {new Date(backup.createdAt).toLocaleString()} ·{' '}
                    {(backup.bytes / 1024).toFixed(1)} KiB
                    <small> · SHA-256 {backup.sha256.slice(0, 12)}…</small>
                  </span>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void operation(async () => setState(await deleteBackup(backup.name)))
                    }
                  >
                    삭제
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            loaded && <p>저장된 백업이 없습니다.</p>
          )}
        </section>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        {status && (
          <p className="form-success" role="status">
            {status}
          </p>
        )}
      </div>
    </dialog>
  );
}
