import { t as localize } from './i18n';
import { SettingsSurface } from './SettingsSurface';
import { AppUpdates } from './AppUpdates';
import { BackupRestorePreview } from './BackupRestorePreview';
import { useEffect, useRef, useState } from 'react';
import {
  backupSettingsSchema,
  type BackupSnapshot,
  type BackupImportPreview,
} from '@lodex/contracts';
import {
  backupSnapshot,
  configureBackups,
  createBackup,
  deleteBackup,
  exportBackup,
  nativeDesktop,
  autostartStatus,
  configureAutostart,
  previewBackup,
  restoreBackup,
} from './bridge';
import { Icon } from './icons';

export function DataManager({
  embedded = false,
  onClose,
}: {
  embedded?: boolean;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [state, setState] = useState<BackupSnapshot>({
    settings: backupSettingsSchema.parse({}),
    backups: [],
  });
  const [draft, setDraft] = useState(state.settings);
  const [dataBusy, setBusy] = useState(false);
  const [updateBusy, setUpdateBusy] = useState(false);
  const busy = dataBusy || updateBusy;
  const [loaded, setLoaded] = useState(!nativeDesktop);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [autostart, setAutostart] = useState<boolean | null>(null);
  const [restorePreview, setRestorePreview] = useState<BackupImportPreview | null>(null);
  useEffect(() => {
    dialog.current?.showModal();
    let active = true;
    if (nativeDesktop)
      void autostartStatus()
        .then((value) => {
          if (active) setAutostart(value);
        })
        .catch(() => {
          if (active)
            setError(localize('자동 시작 설정을 읽지 못했습니다. 설정을 다시 열어 주세요.'));
        });
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
    const timer = nativeDesktop
      ? setInterval(() => {
          void backupSnapshot()
            .then((value) => {
              if (active) setState(value);
            })
            .catch(() => undefined);
        }, 30000)
      : undefined;
    return () => {
      active = false;
      clearInterval(timer);
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
    <SettingsSurface
      embedded={embedded}
      className="settings-dialog"
      ref={dialog}
      onCancel={(event) => {
        if (busy) event.preventDefault();
        else onClose();
      }}
      aria-labelledby="data-manager-title"
      aria-busy={busy}
    >
      <div className="dialog-header">
        <h2 id="data-manager-title">{localize('데이터와 백업')}</h2>
        <button
          className="icon-button"
          aria-label={localize('데이터 관리 닫기')}
          disabled={busy}
          onClick={onClose}
        >
          <Icon name="close" />
        </button>
      </div>
      <div className="settings-body">
        <AppUpdates disabled={dataBusy} onBusyChange={setUpdateBusy} />
        {!nativeDesktop && (
          <p className="demo-notice">{localize('백업은 데스크톱 앱에서 사용할 수 있습니다.')}</p>
        )}
        {!loaded && !error && <p role="status">{localize('백업 목록을 불러오는 중…')}</p>}
        {state.lastFailure && (
          <p className="form-error" role="alert">
            {state.lastFailure.message} ({new Date(state.lastFailure.at).toLocaleString()})
          </p>
        )}
        <section>
          <h3>{localize('앱 시작')}</h3>
          <label className="check-field">
            <input
              type="checkbox"
              checked={autostart ?? false}
              disabled={!nativeDesktop || autostart === null || busy}
              onChange={(event) => {
                const enabled = event.target.checked;
                void operation(async () => setAutostart(await configureAutostart(enabled)));
              }}
            />
            {localize('로그인하면 시스템 트레이에서 Lodex 시작')}
          </label>
          <p>
            {localize(
              '자동 시작 후 Telegram과 백그라운드 연결을 유지합니다. 창은 트레이에서 열 수 있습니다.',
            )}
          </p>
        </section>
        <section>
          <h3>{localize('보존 정책')}</h3>
          <label className="check-field">
            <input
              type="checkbox"
              checked={draft.automatic}
              onChange={(event) => setDraft({ ...draft, automatic: event.target.checked })}
            />
            {localize('하루에 한 번 자동 백업')}
          </label>
          <div className="settings-grid">
            <label className="field">
              {localize('최대 보관 개수')}
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
              {localize('보관 기간(일)')}
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
                setStatus(localize('보존 정책을 저장했습니다.'));
              })
            }
          >
            {localize('보존 정책 저장')}
          </button>
        </section>
        <section>
          <h3>{localize('백업')}</h3>
          <p>
            {localize(
              '대화·프로젝트·계획·모델 프로필·Skills·MCP 등록을 저장합니다. API 키, OAuth 토큰, Telegram 봇 토큰과 모델 파일은 포함하지 않습니다.',
            )}
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
                  setStatus(localize('앱 데이터 폴더에 백업했습니다.'));
                })
              }
            >
              {localize('지금 백업')}
            </button>
            <button
              type="button"
              className="secondary-button"
              disabled={!loaded || busy}
              onClick={() =>
                void operation(async () => {
                  const result = await exportBackup();
                  if (result) setStatus(localize('내보냈습니다: {0}', result.path));
                })
              }
            >
              {localize('다른 위치로 내보내기')}
            </button>
            <button
              type="button"
              className="secondary-button"
              disabled={!nativeDesktop || !loaded || busy}
              onClick={() =>
                void operation(async () => {
                  setRestorePreview(null);
                  setRestorePreview(await previewBackup());
                })
              }
            >
              {localize('백업 파일에서 복원')}
            </button>
          </div>
          {restorePreview && (
            <BackupRestorePreview
              preview={restorePreview}
              busy={busy}
              onCancel={() => setRestorePreview(null)}
              onRestore={() =>
                void operation(async () => {
                  const result = await restoreBackup(restorePreview.token);
                  setRestorePreview(null);
                  setState(await backupSnapshot());
                  setStatus(
                    localize(
                      '{0}개 항목을 복원했습니다. 대화 목록과 각 설정 화면에서 확인하세요.',
                      Object.values(result.imported).reduce((sum, count) => sum + count, 0),
                    ),
                  );
                })
              }
            />
          )}
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
                    className="danger-button"
                    disabled={busy}
                    onClick={() =>
                      void operation(async () => setState(await deleteBackup(backup.name)))
                    }
                  >
                    {localize('삭제')}
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            loaded && <p>{localize('저장된 백업이 없습니다.')}</p>
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
    </SettingsSurface>
  );
}
