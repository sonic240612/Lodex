import { useEffect, useRef, useState } from 'react';
import type { McpSelection, Session } from '@lodex/contracts';
import type { McpImport, McpRegistration } from '@lodex/mcp';
import { importMcp, nativeDesktop, registeredMcp, registerMcp, removeMcp } from './bridge';
import { Icon } from './icons';

export interface McpSelectionSave {
  mcp: McpSelection[];
  mcpCloudConsent: boolean;
  expectedVersion: number | undefined;
}
const example = JSON.stringify(
  {
    mcpServers: {
      example: {
        type: 'http',
        url: 'http://127.0.0.1:3000/mcp',
        headers: { Authorization: { secretRef: 'LODEX_MCP_EXAMPLE_TOKEN', prefix: 'Bearer ' } },
      },
    },
  },
  null,
  2,
);
export function McpManager({
  session,
  provider,
  connected,
  onClose,
  onSave,
}: {
  session: Session | undefined;
  provider: string;
  connected: boolean;
  onClose: () => void;
  onSave: (value: McpSelectionSave) => Promise<void>;
}) {
  const dialog = useRef<HTMLDialogElement>(null),
    mounted = useRef(false),
    working = useRef(false);
  const [servers, setServers] = useState<McpRegistration[]>([]),
    [loaded, setLoaded] = useState(!nativeDesktop);
  const [selected, setSelected] = useState(session?.mcp ?? []),
    [consent, setConsent] = useState(session?.mcpCloudConsent ?? false);
  const [baseVersion, setBaseVersion] = useState(session?.version);
  const [source, setSource] = useState(''),
    [candidates, setCandidates] = useState<McpImport[]>([]);
  const [previous, setPrevious] = useState<McpRegistration>();
  const [approved, setApproved] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [status, setStatus] = useState('');
  const unavailable = !nativeDesktop || !connected || !loaded;
  const running = session?.run?.status === 'running';
  const conflict = session?.version !== baseVersion;
  const stale = selected.some((selection) => {
    const server = servers.find((server) => server.id === selection.serverId);
    const tool = server?.tools.find((tool) => tool.name === selection.toolName);
    return (
      server?.revision !== selection.serverRevision ||
      !tool?.supported ||
      tool.revision !== selection.toolRevision
    );
  });
  useEffect(() => {
    mounted.current = true;
    dialog.current?.showModal();
    if (nativeDesktop)
      void registeredMcp()
        .then((values) => {
          if (mounted.current) {
            setServers(values);
            setLoaded(true);
          }
        })
        .catch((failure) => {
          if (mounted.current) setError(String(failure));
        });
    return () => {
      mounted.current = false;
    };
  }, []);
  async function operation(work: () => Promise<void>, refresh = false) {
    if (working.current || !nativeDesktop || !connected) return;
    working.current = true;
    setBusy(true);
    setError('');
    setStatus('');
    try {
      await work();
      if (refresh) {
        const next = await registeredMcp();
        if (mounted.current) {
          setServers(next);
          setLoaded(true);
        }
      }
    } catch (failure) {
      if (mounted.current) setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      working.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  function edit(server?: McpRegistration) {
    setPrevious(server);
    setSource(server ? JSON.stringify(server.config, null, 2) : '');
    setCandidates([]);
    setApproved(false);
    setError('');
  }
  return (
    <dialog
      className="settings-dialog skill-manager mcp-manager"
      ref={dialog}
      onCancel={onClose}
      aria-labelledby="mcp-title"
      aria-busy={busy}
    >
      <div className="dialog-header">
        <h2 id="mcp-title">MCP</h2>
        <button className="icon-button" aria-label="MCP 관리 닫기" onClick={onClose}>
          <Icon name="close" />
        </button>
      </div>
      <div className="settings-body">
        {!nativeDesktop && (
          <p className="demo-notice">MCP 서버 연결은 데스크톱 앱에서 사용할 수 있습니다.</p>
        )}
        <section>
          <h3>
            {session ? '이 대화의 도구' : '새 대화의 도구'} · {selected.length}/16
          </h3>
          <p>
            선택한 도구는 Build 모드에서 모델이 호출할 수 있습니다. Plan 모드와 Autopilot에서는 MCP
            실행을 지원하지 않습니다.
          </p>
          <p>
            서버는 파일이나 외부 서비스에 접근할 수 있습니다. 도구 설명과 권한을 확인하고 필요한
            도구만 선택하세요.
          </p>
          {conflict && <p role="status">대화가 변경되었습니다. 저장된 선택을 다시 불러오세요.</p>}
          <fieldset disabled={busy || unavailable || running}>
            <button
              type="button"
              onClick={() => {
                setSelected(session?.mcp ?? []);
                setConsent(session?.mcpCloudConsent ?? false);
                setBaseVersion(session?.version);
              }}
            >
              저장된 선택 불러오기
            </button>
            {selected.length > 0 && (
              <ul className="skill-selection-list">
                {selected.map((selection) => (
                  <li key={selection.serverId + selection.toolName}>
                    <span>
                      {servers.find((server) => server.id === selection.serverId)?.config.name ??
                        '제거된 서버'}{' '}
                      · {selection.toolName}
                    </span>
                    <button
                      type="button"
                      onClick={() =>
                        setSelected((current) => current.filter((value) => value !== selection))
                      }
                    >
                      선택 해제
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {provider === 'openrouter' && (
              <label className="check-field skill-consent">
                <input
                  type="checkbox"
                  checked={consent}
                  onChange={(event) => setConsent(event.target.checked)}
                />
                <span>
                  MCP 도구 설명과 결과를 OpenRouter 및 모델 제공자에게 전송하는 데 동의합니다. 이전
                  대화에 남은 내용도 포함합니다.
                </span>
              </label>
            )}
            {stale && (
              <p className="form-error">
                변경되거나 제거된 도구를 선택 해제하고 최신 목록에서 다시 선택하세요.
              </p>
            )}
            <button
              className="primary-button"
              disabled={
                conflict || stale || (provider === 'openrouter' && selected.length > 0 && !consent)
              }
              onClick={() =>
                void operation(() =>
                  onSave({
                    mcp: selected,
                    mcpCloudConsent: provider === 'openrouter' && consent,
                    expectedVersion: baseVersion,
                  }),
                )
              }
            >
              {session ? '대화에 적용' : '선택한 도구로 새 대화'}
            </button>
          </fieldset>
        </section>
        <section className="skill-catalog" aria-label="등록한 MCP 서버">
          <div className="edit-actions">
            <h3>등록한 서버</h3>
            <button
              disabled={busy || !nativeDesktop || !connected}
              onClick={() => void operation(async () => {}, true)}
            >
              목록 새로고침
            </button>
          </div>
          {loaded && !servers.length && <p>아래에서 서버 설정을 가져와 연결하세요.</p>}
          {servers.map((server) => (
            <article className="skill-card" key={server.id}>
              <strong>{server.config.name}</strong>
              <p className="skill-source">
                {server.config.transport === 'http' ? server.config.url : server.config.executable}
              </p>
              <small>
                {server.config.transport} · {server.protocol ?? '버전 미확인'} · 도구{' '}
                {server.tools.length}개
              </small>
              {server.tools.map((tool) => {
                const selection = selected.find(
                  (value) => value.serverId === server.id && value.toolName === tool.name,
                );
                return (
                  <div key={tool.name}>
                    <label className="check-field">
                      <input
                        type="checkbox"
                        checked={!!selection}
                        disabled={
                          busy ||
                          unavailable ||
                          running ||
                          !tool.supported ||
                          (!selection && selected.length >= 16)
                        }
                        onChange={(event) =>
                          setSelected((current) =>
                            event.target.checked
                              ? [
                                  ...current.filter(
                                    (value) =>
                                      !(
                                        value.serverId === server.id && value.toolName === tool.name
                                      ),
                                  ),
                                  {
                                    serverId: server.id,
                                    serverRevision: server.revision,
                                    toolName: tool.name,
                                    toolRevision: tool.revision,
                                  },
                                ]
                              : current.filter(
                                  (value) =>
                                    !(value.serverId === server.id && value.toolName === tool.name),
                                ),
                          )
                        }
                      />
                      <span>{tool.name}</span>
                    </label>
                    <details>
                      <summary>도구 설명과 입력 형식</summary>
                      <p>{tool.definition.description}</p>
                      <pre>{JSON.stringify(tool.definition.inputSchema, null, 2)}</pre>
                    </details>
                    {tool.issue && <p className="form-error">{tool.issue}</p>}
                  </div>
                );
              })}
              <div className="edit-actions">
                <button disabled={busy || unavailable || running} onClick={() => edit(server)}>
                  설정 편집·다시 검사
                </button>
                <button
                  disabled={busy || unavailable || running}
                  onClick={() =>
                    void operation(async () => {
                      await removeMcp(server);
                      if (previous?.id === server.id) edit();
                    }, true)
                  }
                >
                  목록에서 제거
                </button>
              </div>
            </article>
          ))}
        </section>
        <section>
          <h3>{previous ? `${previous.config.name} 설정 편집` : '서버 설정 가져오기'}</h3>
          <p>
            mcpServers JSON 또는 서버 하나의 설정을 붙여 넣으세요. stdio는 설치된 node·python 등의
            절대 경로와 cwd가 필요합니다.
          </p>
          <p>
            키는 앱 .env의 LODEX_MCP_ 변수로 관리합니다. env·headers에는 secretRef를 사용하세요.
            가져오기는 서버를 실행하거나 패키지를 설치하지 않습니다.
          </p>
          <details>
            <summary>HTTP 설정 예시</summary>
            <pre>{example}</pre>
          </details>
          <fieldset disabled={busy || unavailable}>
            <label className="field">
              설정 JSON
              <textarea
                rows={10}
                spellCheck={false}
                maxLength={131072}
                value={source}
                onChange={(event) => {
                  setSource(event.target.value);
                  setCandidates([]);
                  setApproved(false);
                }}
              />
            </label>
            <div className="edit-actions">
              <button
                disabled={!source.trim()}
                onClick={() =>
                  void operation(async () => {
                    const values = await importMcp(source);
                    setCandidates(values);
                    setApproved(false);
                  })
                }
              >
                설정 검사
              </button>
              {previous && <button onClick={() => edit()}>새 서버 입력</button>}
            </div>
            {candidates.map((candidate, index) => (
              <article className="skill-card" key={index}>
                <strong>{candidate.name}</strong>
                {candidate.issues.map((issue, i) => (
                  <p className="form-error" key={i}>
                    {issue}
                  </p>
                ))}
                {candidate.config && <pre>{JSON.stringify(candidate.config, null, 2)}</pre>}
              </article>
            ))}
            {candidates.some((candidate) => candidate.config) && (
              <>
                <label className="check-field skill-consent">
                  <input
                    type="checkbox"
                    checked={approved}
                    onChange={(event) => setApproved(event.target.checked)}
                  />
                  <span>
                    위 서버를 신뢰하며 연결 검사를 허용합니다. stdio 프로그램은 내 사용자 권한으로
                    실행되고 HTTP 서버에는 지정한 인증값이 전달됩니다.
                  </span>
                </label>
                {candidates
                  .filter((candidate) => candidate.config)
                  .map((candidate, index) => (
                    <button
                      className="primary-button"
                      key={index}
                      disabled={!approved || (!!previous && candidates.length !== 1)}
                      onClick={() =>
                        void operation(async () => {
                          await registerMcp(candidate.config!, previous);
                          edit();
                          setStatus(
                            '연결 검사 후 등록했습니다. 위 목록에서 사용할 도구를 선택하세요.',
                          );
                        }, true)
                      }
                    >
                      {candidate.name} 연결·등록
                    </button>
                  ))}
              </>
            )}
          </fieldset>
          <p>
            현재 도구 호출을 지원합니다. OAuth 로그인, resources·prompts, 참조·정규식·format이
            필요한 입력 형식은 후속 단계입니다.
          </p>
        </section>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        {status && <p role="status">{status}</p>}
      </div>
    </dialog>
  );
}
