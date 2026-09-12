import { useEffect, useRef, useState } from 'react';
import type { OAuthPreparation, OAuthStatus } from '@lodex/mcp';
import {
  nativeDesktop,
  prepareMcpOAuth,
  beginMcpOAuth,
  statusMcpOAuth,
  cancelMcpOAuth,
  disconnectMcpOAuth,
  openMcpLogin,
} from './bridge';

export function McpOAuthPanel({ connected }: { connected: boolean }) {
  const mounted = useRef(false),
    working = useRef(false),
    loginId = useRef<string | undefined>(undefined);
  const [url, setUrl] = useState(''),
    [clientId, setClientId] = useState(''),
    [scope, setScope] = useState(''),
    [issuer, setIssuer] = useState('');
  const [preview, setPreview] = useState<OAuthPreparation>(),
    [approved, setApproved] = useState(false),
    [status, setStatus] = useState<OAuthStatus>();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (loginId.current) void cancelMcpOAuth(loginId.current).catch(() => undefined);
    };
  }, []);
  useEffect(() => {
    if (!status || status.status !== 'pending') return;
    let active = true,
      polling = false;
    const poll = async () => {
      if (polling) return;
      polling = true;
      try {
        const next = await statusMcpOAuth(status.id);
        if (active && mounted.current) {
          setStatus(next);
          if (next.status !== 'pending') {
            loginId.current = undefined;
            setPreview(undefined);
            setApproved(false);
          }
        }
      } catch (failure) {
        if (active && mounted.current) {
          setError(failure instanceof Error ? failure.message : String(failure));
          if (loginId.current) void cancelMcpOAuth(loginId.current).catch(() => undefined);
          loginId.current = undefined;
          setStatus(undefined);
          setPreview(undefined);
          setApproved(false);
        }
      } finally {
        polling = false;
      }
    };
    const timer = setInterval(() => void poll(), 1000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [status?.id, status?.status]);
  async function operation(work: () => Promise<void>) {
    if (working.current || !nativeDesktop || !connected) return;
    working.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await work();
    } catch (failure) {
      if (mounted.current) setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      working.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  const invalidate = () => {
    setPreview(undefined);
    setApproved(false);
    setStatus(undefined);
  };
  const pending = status?.status === 'pending';
  return (
    <section className="mcp-oauth" aria-label="MCP OAuth 로그인">
      <h3>OAuth 로그인</h3>
      <p>
        서버에서 발급한 공개 client ID를 사용합니다. PKCE와 임의 loopback 포트를 허용하는 데스크톱
        클라이언트 등록이 필요합니다.
      </p>
      <p>
        인증 토큰은 앱 .env 옆의 전용 <code>.env.mcp</code>에 저장됩니다. 로그인 후 서버 설정에{' '}
        <code>"oauth": {'{ "clientId": "발급받은 ID" }'}</code>를 추가하세요. 연결 해제 시 이 인증을
        쓰는 대화 실행도 중지됩니다.
      </p>
      <fieldset disabled={busy || pending || !nativeDesktop || !connected}>
        <label className="field">
          MCP 서버 URL
          <input
            value={url}
            maxLength={4096}
            placeholder="https://server.example/mcp"
            onChange={(event) => {
              setUrl(event.target.value);
              invalidate();
            }}
          />
        </label>
        <label className="field">
          공개 client ID
          <input
            value={clientId}
            maxLength={512}
            onChange={(event) => {
              setClientId(event.target.value);
              invalidate();
            }}
          />
        </label>
        <label className="field">
          Scope · 선택, 공백으로 구분
          <input
            value={scope}
            maxLength={4096}
            onChange={(event) => {
              setScope(event.target.value);
              invalidate();
            }}
          />
        </label>
        <label className="field">
          인증 서버 · 여러 개일 때 지정
          <input
            value={issuer}
            maxLength={4096}
            placeholder="https://auth.example"
            onChange={(event) => {
              setIssuer(event.target.value);
              invalidate();
            }}
          />
        </label>
        <div className="edit-actions">
          <button
            disabled={!url.trim() || !clientId.trim()}
            onClick={() =>
              void operation(async () => {
                const result = await prepareMcpOAuth({
                  resourceUrl: url.trim(),
                  clientId: clientId.trim(),
                  ...(scope.trim() ? { scopes: scope.trim().split(/\s+/) } : {}),
                  ...(issuer.trim() ? { authorizationServer: issuer.trim() } : {}),
                });
                if (mounted.current) {
                  setPreview(result);
                  setApproved(false);
                }
              })
            }
          >
            인증 정보 확인
          </button>
          <button
            disabled={!url.trim() || !clientId.trim()}
            onClick={() =>
              void operation(async () => {
                await disconnectMcpOAuth(url.trim(), clientId.trim());
                if (mounted.current) {
                  invalidate();
                  setNotice(
                    '앱에 저장된 인증 정보를 삭제했습니다. 제공자 측 권한은 해당 서비스에서 관리하세요.',
                  );
                }
              })
            }
          >
            앱에서 연결 해제
          </button>
        </div>
      </fieldset>
      {preview && (
        <div className="skill-card">
          <strong>로그인 전 확인</strong>
          <p className="skill-source">서버: {preview.resourceUrl}</p>
          <p className="skill-source">인증 기관: {preview.issuer}</p>
          <p>요청 scope: {preview.scopes.join(', ') || '없음'}</p>
          <p>연결할 주소</p>
          <ul>
            {preview.origins.map((origin) => (
              <li key={origin}>{origin}</li>
            ))}
          </ul>
          <label className="check-field skill-consent">
            <input
              type="checkbox"
              checked={approved}
              disabled={busy || pending}
              onChange={(event) => setApproved(event.target.checked)}
            />
            <span>위 인증 기관과 주소를 확인했으며 브라우저 로그인을 허용합니다.</span>
          </label>
          <button
            className="primary-button"
            disabled={busy || pending || !approved || Date.now() >= preview.expiresAt || !connected}
            onClick={() =>
              void operation(async () => {
                const flow = await beginMcpOAuth(preview);
                if (!mounted.current) {
                  await cancelMcpOAuth(flow.id);
                  return;
                }
                loginId.current = flow.id;
                setStatus({ id: flow.id, status: 'pending', expiresAt: flow.expiresAt });
                try {
                  await openMcpLogin(flow.authorizationUrl);
                } catch (failure) {
                  await cancelMcpOAuth(flow.id);
                  loginId.current = undefined;
                  setStatus(undefined);
                  throw failure;
                }
              })
            }
          >
            브라우저에서 로그인
          </button>
        </div>
      )}
      {status && (
        <div role="status">
          <p>
            {status.status === 'pending'
              ? '브라우저에서 로그인을 완료하세요.'
              : status.status === 'completed'
                ? '로그인했습니다. 이 서버의 OAuth 설정으로 연결할 수 있습니다.'
                : status.status === 'cancelled'
                  ? '로그인을 취소했습니다.'
                  : status.status === 'expired'
                    ? '로그인 시간이 만료되었습니다.'
                    : (status.error ?? '로그인하지 못했습니다.')}
          </p>
          {pending && (
            <button
              disabled={busy}
              onClick={() =>
                void operation(async () => {
                  setStatus(await cancelMcpOAuth(status.id));
                  loginId.current = undefined;
                })
              }
            >
              로그인 취소
            </button>
          )}
        </div>
      )}
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
    </section>
  );
}
