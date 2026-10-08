import { t as localize } from './i18n';
import { useEffect, useRef, useState } from 'react';
import { Channel, invoke } from '@tauri-apps/api/core';
import { nativeDesktop } from './bridge';

type UpdateInfo = {
  configured: boolean;
  currentVersion: string;
  available: boolean;
  token?: string;
  version?: string;
  notes?: string;
};
type UpdateProgress = {
  phase: 'downloading' | 'preparing' | 'installing';
  downloaded?: number;
  total?: number;
};

export function AppUpdates({
  disabled = false,
  onBusyChange,
}: {
  disabled?: boolean;
  onBusyChange?: (busy: boolean) => void;
}) {
  const [info, setInfo] = useState<UpdateInfo>();
  const [progress, setProgress] = useState<UpdateProgress>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const locked = useRef(false);
  useEffect(() => {
    onBusyChange?.(busy);
    return () => onBusyChange?.(false);
  }, [busy, onBusyChange]);
  async function operation(work: () => Promise<void>) {
    if (locked.current || disabled) return;
    locked.current = true;
    setBusy(true);
    setError('');
    try {
      await work();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      locked.current = false;
      setBusy(false);
      setProgress(undefined);
    }
  }
  return (
    <section className="settings-section" aria-labelledby="app-updates-title" aria-busy={busy}>
      <h3 id="app-updates-title">{localize('앱 업데이트')}</h3>
      <div className="dialog-actions">
        <button
          type="button"
          className="secondary-button"
          disabled={!nativeDesktop || busy || disabled}
          onClick={() =>
            void operation(async () => {
              setInfo(undefined);
              setConfirmed(false);
              setInfo(await invoke<UpdateInfo>('check_app_update'));
            })
          }
        >
          {localize('업데이트 확인')}
        </button>
        <button
          type="button"
          className="secondary-button"
          disabled={!nativeDesktop || busy || disabled}
          onClick={() =>
            void operation(async () => {
              await invoke('open_app_releases');
            })
          }
        >
          {localize('릴리스 페이지')}
        </button>
      </div>
      {info && (
        <p className="field-hint" role="status">
          {localize('현재 버전 ')}
          {info.currentVersion} ·{' '}
          {!info.configured
            ? localize('이 빌드에는 업데이트 서명이 설정되지 않았습니다.')
            : info.available
              ? localize('{0} 업데이트가 있습니다.', info.version)
              : localize('최신 버전입니다.')}
        </p>
      )}
      {info?.available && (
        <>
          {info.notes && (
            <details>
              <summary>{localize('변경 사항')}</summary>
              <pre className="tool-output">{info.notes}</pre>
            </details>
          )}
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={confirmed}
              disabled={busy || disabled}
              onChange={(event) => setConfirmed(event.target.checked)}
            />
            {localize('실행 중인 작업을 중지했습니다. 백업을 만들고 설치 후 앱을 다시 시작합니다.')}
          </label>
          <button
            type="button"
            className="primary-button"
            disabled={!confirmed || busy || disabled}
            onClick={() =>
              void operation(async () => {
                const channel = new Channel<UpdateProgress>();
                channel.onmessage = setProgress;
                await invoke('install_app_update', { token: info.token, progress: channel });
              })
            }
          >
            {localize('업데이트 설치')}
          </button>
        </>
      )}
      {progress && (
        <p role="status">
          {progress.phase === 'downloading'
            ? localize(
                '다운로드 중{0}',
                progress.total
                  ? ` · ${Math.min(100, Math.floor(((progress.downloaded ?? 0) / progress.total) * 100))}%`
                  : '…',
              )
            : progress.phase === 'preparing'
              ? localize('실행 상태를 확인하고 백업을 만드는 중…')
              : localize('서명 확인 완료 · 설치 중…')}
        </p>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <p className="field-hint">
        {localize(
          '이전 버전 설치 파일은 릴리스 페이지에서 받을 수 있습니다. 데이터 형식이 변경된 버전은 해당 버전의 백업과 함께 복원해야 합니다.',
        )}
      </p>
    </section>
  );
}
