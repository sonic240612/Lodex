import { useEffect, useRef, useState } from 'react';
import type { TelegramStatus, TelegramConfig, Session } from '@lodex/contracts';
import { nativeDesktop, telegramStatus, telegramAction, saveTelegramToken } from './bridge';
import { Icon } from './icons';

export function TelegramSettings({
  sessions,
  selectedId,
  onClose,
}: {
  sessions: Session[];
  selectedId: string | null;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null),
    initialized = useRef(false);
  const [status, setStatus] = useState<TelegramStatus>(),
    [draft, setDraft] = useState<TelegramConfig>({
      enabled: false,
      sessionId: selectedId,
      allowBuild: false,
      transmissionConsent: false,
    });
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [token, setToken] = useState(''),
    [notice, setNotice] = useState(''),
    [pair, setPair] = useState<{ code: string; expiresAt: number }>();
  useEffect(() => {
    dialog.current?.showModal();
    let live = true;
    const refresh = () =>
      telegramStatus()
        .then((value) => {
          if (!live) return;
          setStatus(value);
          if (!initialized.current) {
            setDraft({ ...value.config, sessionId: value.config.sessionId ?? selectedId });
            initialized.current = true;
          }
        })
        .catch((error) => {
          if (live) setError(String(error));
        });
    void refresh();
    const timer = setInterval(() => void refresh(), 2000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [selectedId]);
  async function action(kind: 'config' | 'pair' | 'approve' | 'unpair') {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await telegramAction(
        kind,
        kind === 'config'
          ? draft
          : kind === 'approve'
            ? { userId: status!.candidate!.userId, chatId: status!.candidate!.chatId }
            : null,
      );
      if ('code' in result) setPair(result);
      else {
        setStatus(result);
        setDraft(result.config);
        if (kind !== 'config') setPair(undefined);
      }
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }
  async function saveToken(value: string | null) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await saveTelegramToken(value);
      setStatus(result);
      setDraft(result.config);
      setToken('');
      setNotice(value ? '봇 토큰을 OS 보안 저장소에 저장했습니다.' : '봇 토큰을 제거했습니다.');
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
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
        <h2>Telegram</h2>
        <button className="icon-button" aria-label="닫기" disabled={busy} onClick={onClose}>
          <Icon name="close" />
        </button>
      </div>
      <div className="integration-body">
        <label className="field">
          봇 토큰
          <div className="input-action">
            <input
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={token}
              disabled={
                busy ||
                status?.config.enabled ||
                status?.tokenSource === 'environment' ||
                status?.tokenSource === 'env_file'
              }
              placeholder={status?.configured ? '새 토큰으로 교체' : '123456789:AA…'}
              onChange={(event) => setToken(event.target.value)}
            />
            <button
              type="button"
              disabled={
                !nativeDesktop ||
                !token.trim() ||
                busy ||
                status?.config.enabled ||
                status?.tokenSource === 'environment' ||
                status?.tokenSource === 'env_file'
              }
              onClick={() => void saveToken(token.trim())}
            >
              토큰 저장
            </button>
            {status?.configured && (
              <button
                type="button"
                disabled={
                  busy ||
                  status.config.enabled ||
                  status.tokenSource === 'environment' ||
                  status.tokenSource === 'env_file'
                }
                onClick={() => void saveToken(null)}
              >
                제거
              </button>
            )}
          </div>
          <small>
            {status?.tokenSource === 'env_file'
              ? '.env에서 불러왔습니다.'
              : status?.tokenSource === 'environment'
                ? '환경 변수에서 불러왔습니다.'
                : '직접 저장한 토큰은 OS 보안 저장소에서 관리합니다.'}
          </small>
          {status?.config.enabled && <small>토큰을 변경하려면 먼저 연결을 끄고 저장하세요.</small>}
        </label>
        <p role="status">
          {status?.configured ? '토큰 설정됨' : '토큰 미설정'} ·{' '}
          {status?.running ? '수신 중' : '연결 꺼짐'}
          {status?.bot ? ' · @' + status.bot.username : ''}
        </p>
        {notice && <p role="status">{notice}</p>}
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void action('config');
          }}
        >
          <fieldset disabled={busy || !nativeDesktop}>
            <label>
              연결할 대화
              <select
                value={draft.sessionId ?? ''}
                onChange={(event) => setDraft({ ...draft, sessionId: event.target.value || null })}
              >
                <option value="">대화 선택</option>
                {sessions.map((session) => (
                  <option key={session.id} value={session.id}>
                    {session.title}
                  </option>
                ))}
              </select>
            </label>
            <label className="check-row">
              <input
                type="checkbox"
                checked={draft.enabled}
                onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })}
              />
              Telegram 연결 켜기
            </label>
            <label className="check-row">
              <input
                type="checkbox"
                checked={draft.allowBuild}
                onChange={(event) => setDraft({ ...draft, allowBuild: event.target.checked })}
              />
              Build 모드 원격 요청 허용
            </label>
            <label className="check-row">
              <input
                type="checkbox"
                checked={draft.transmissionConsent}
                onChange={(event) =>
                  setDraft({ ...draft, transmissionConsent: event.target.checked })
                }
              />
              선택한 대화의 요청·답변·목표를 Telegram으로 전송 허용
            </label>
            <button className="primary-button" disabled={!status}>
              연결 설정 저장
            </button>
          </fieldset>
        </form>
        {status?.config.enabled && !status.owner && (
          <section className="integration-section">
            <h3>계정 연결</h3>
            <button disabled={busy} onClick={() => void action('pair')}>
              연결 코드 만들기
            </button>
            {pair && pair.expiresAt > Date.now() && (
              <p>
                봇의 개인 채팅에서 <code>/pair {pair.code}</code> 전송 · 5분 이내
              </p>
            )}
            {status.candidate && (
              <>
                <p>
                  연결 요청: {status.candidate.name}
                  <br />
                  사용자 {status.candidate.userId} · 채팅 {status.candidate.chatId}
                </p>
                <button
                  className="primary-button"
                  disabled={busy}
                  onClick={() => void action('approve')}
                >
                  이 계정 연결 승인
                </button>
              </>
            )}
          </section>
        )}
        {status?.owner && (
          <section className="integration-section">
            <p>
              연결 계정: {status.owner.name} · {status.owner.userId}
            </p>
            <button disabled={busy} onClick={() => void action('unpair')}>
              계정 연결 해제
            </button>
          </section>
        )}
        <p>
          <code>/ask 메시지</code> · <code>/status</code> · <code>/plan</code> · <code>/stop</code>
        </p>
        <p>
          일반 텍스트도 요청으로 전달됩니다. 파일 적용·설정 변경은 데스크톱에서 진행하세요. 앱이
          실행 중일 때만 연결됩니다.
        </p>
        <p>연결 해제 후에도 이미 시작한 작업은 계속됩니다. 실행을 멈추려면 대화에서 중지하세요.</p>
        {!!status?.unknownDeliveries && (
          <p role="status">
            전달 결과 미확인 {status.unknownDeliveries}건 · 중복 전송을 피하려고 자동 재전송하지
            않았습니다.
          </p>
        )}
        {(error || status?.error) && (
          <p role="alert" className="error-text">
            {error || status?.error}
          </p>
        )}
      </div>
    </dialog>
  );
}
