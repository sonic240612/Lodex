import { useEffect, useId, useRef, useState } from 'react';
import type { McpSelection, Session } from '@lodex/contracts';
import type { McpImport, McpRegistration } from '@lodex/mcp';
import {
  completeMcpArgument,
  importMcp,
  nativeDesktop,
  pickMcpConfig,
  previewMcpContent,
  registeredMcp,
  registerMcp,
  removeMcp,
  type McpContentPreview,
} from './bridge';
import { Icon } from './icons';
import { McpOAuthPanel } from './McpOAuthPanel';

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

function McpContentEntry({
  name,
  source,
  description,
  parameters,
  supported,
  issue,
  disabled,
  attachDisabledReason,
  preview,
  onPreview,
  onComplete,
  onInvalidate,
  onAttach,
}: {
  name: string;
  source: string;
  description: string | undefined;
  parameters: { name: string; description?: string | undefined; required?: boolean | undefined }[];
  supported: boolean;
  issue: string | undefined;
  disabled: boolean;
  attachDisabledReason: string | undefined;
  preview: McpContentPreview | undefined;
  onPreview: (arguments_: Record<string, string>) => void;
  onComplete?:
    | ((
        argumentName: string,
        value: string,
        arguments_: Record<string, string>,
      ) => Promise<string[]>)
    | undefined;
  onInvalidate: () => void;
  onAttach: (preview: McpContentPreview) => void;
}) {
  const [arguments_, setArguments] = useState<Record<string, string>>({});
  const [expired, setExpired] = useState(false);
  const [suggestions, setSuggestions] = useState<Record<string, string[]>>({});
  const [completionBusy, setCompletionBusy] = useState<string>();
  const [completionError, setCompletionError] = useState('');
  const completionId = useId().replaceAll(':', '');
  const argumentValue = (name: string) =>
    Object.hasOwn(arguments_, name) ? (arguments_[name] ?? '') : '';
  useEffect(() => {
    if (!preview) {
      setExpired(false);
      return;
    }
    const remaining = Date.parse(preview.expiresAt) - Date.now();
    setExpired(!Number.isFinite(remaining) || remaining <= 0);
    if (!Number.isFinite(remaining) || remaining <= 0) return;
    const timer = setTimeout(() => setExpired(true), remaining);
    return () => clearTimeout(timer);
  }, [preview]);
  const missing = parameters.some(
    (parameter) => parameter.required && !argumentValue(parameter.name).trim(),
  );
  return (
    <div className="mcp-content-entry">
      <strong>{name}</strong>
      <p className="skill-source">{source}</p>
      {description && <p>{description}</p>}
      <fieldset disabled={disabled || !supported}>
        {parameters.map((parameter) => {
          const values = suggestions[parameter.name] ?? [];
          const listId = `mcp-completion-${completionId}-${parameter.name}`;
          return (
            <div className="mcp-argument-row" key={parameter.name}>
              <label className="field">
                <span>
                  {parameter.name}
                  {parameter.required ? ' · 필수' : ''}
                </span>
                {parameter.description && <small>{parameter.description}</small>}
                <input
                  type="text"
                  required={parameter.required === true}
                  maxLength={4096}
                  list={values.length ? listId : undefined}
                  value={argumentValue(parameter.name)}
                  onChange={(event) => {
                    setArguments((current) => ({
                      ...current,
                      [parameter.name]: event.target.value,
                    }));
                    setSuggestions((current) => ({ ...current, [parameter.name]: [] }));
                    setCompletionError('');
                    onInvalidate();
                  }}
                />
                {!!values.length && (
                  <datalist id={listId}>
                    {values.map((value) => (
                      <option key={value} value={value} />
                    ))}
                  </datalist>
                )}
              </label>
              {onComplete && (
                <button
                  type="button"
                  disabled={completionBusy !== undefined}
                  onClick={() => {
                    setCompletionBusy(parameter.name);
                    setCompletionError('');
                    void onComplete(parameter.name, argumentValue(parameter.name), arguments_)
                      .then((values) => {
                        setSuggestions((current) => ({ ...current, [parameter.name]: values }));
                        if (!values.length) setCompletionError('추천할 값이 없습니다.');
                      })
                      .catch((failure: unknown) =>
                        setCompletionError(
                          failure instanceof Error ? failure.message : String(failure),
                        ),
                      )
                      .finally(() => setCompletionBusy(undefined));
                  }}
                >
                  {completionBusy === parameter.name ? '불러오는 중…' : '값 추천'}
                </button>
              )}
              {!!values.length && (
                <div className="mcp-completion-values" aria-label={`${parameter.name} 추천값`}>
                  <span>추천</span>
                  {values.map((value) => (
                    <button
                      type="button"
                      key={value}
                      title={value}
                      onClick={() => {
                        setArguments((current) => ({ ...current, [parameter.name]: value }));
                        onInvalidate();
                      }}
                    >
                      {value}
                    </button>
                  ))}
                </div>
              )}
            </div>
          );
        })}
        {completionError && <p className="form-error">{completionError}</p>}
        <button
          type="button"
          disabled={missing}
          onClick={() =>
            onPreview(
              Object.fromEntries(
                Object.entries(arguments_).filter(([, value]) => value.length > 0),
              ),
            )
          }
        >
          {preview ? '다시 읽기' : '내용 미리보기'}
        </button>
      </fieldset>
      {issue && <p className="form-error">{issue}</p>}
      {preview && (
        <div className="mcp-content-preview" aria-label={`${name} 미리보기`}>
          <p className="skill-source">
            {preview.kind === 'resource'
              ? '리소스'
              : preview.kind === 'resource_template'
                ? '리소스 템플릿'
                : '프롬프트'}{' '}
            · {preview.resolvedUri ?? preview.entryKey} · {preview.bytes.toLocaleString()} bytes
            <br />
            읽은 시간 {new Date(preview.readAt).toLocaleString()}
          </p>
          <pre tabIndex={0}>{preview.text}</pre>
          <p>위 내용을 확인한 뒤 첨부하면 다음 요청부터 대화의 참고 자료로 전달됩니다.</p>
          {attachDisabledReason && <p role="status">{attachDisabledReason}</p>}
          {expired && (
            <p className="form-error">미리보기가 만료되었습니다. 다시 읽은 뒤 첨부하세요.</p>
          )}
          <button
            className="primary-button"
            type="button"
            disabled={disabled || !!attachDisabledReason || expired}
            onClick={() => onAttach(preview)}
          >
            확인한 내용 첨부
          </button>
        </div>
      )}
    </div>
  );
}

export function McpManager({
  session,
  projectPath,
  provider,
  connected,
  onClose,
  onSave,
  onAttach,
  onRemoveAttachment,
}: {
  session: Session | undefined;
  projectPath?: string | undefined;
  provider: string;
  connected: boolean;
  onClose: () => void;
  onSave: (value: McpSelectionSave) => Promise<void>;
  onAttach: (
    preview: McpContentPreview,
    cloudConsent: boolean,
    expectedVersion: number | undefined,
  ) => Promise<void>;
  onRemoveAttachment: (id: string, expectedVersion: number | undefined) => Promise<void>;
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
  const [sourceFile, setSourceFile] = useState<{ path: string; cwd?: string }>();
  const [previous, setPrevious] = useState<McpRegistration>();
  const [preview, setPreview] = useState<McpContentPreview>();
  const [approved, setApproved] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [status, setStatus] = useState('');
  const unavailable = !nativeDesktop || !connected || !loaded;
  const running = session?.run?.status === 'running';
  const conflict = session?.version !== baseVersion;
  const attachments = session?.mcpAttachments ?? [];
  const attachDisabledReason =
    attachments.length >= 8
      ? '첨부는 최대 8개입니다. 기존 첨부를 제거한 뒤 추가하세요.'
      : provider === 'openrouter' && !consent
        ? '위에서 OpenRouter 전송에 동의한 뒤 첨부할 수 있습니다.'
        : undefined;
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
          setPreview((current) =>
            current &&
            next.some(
              (server) =>
                server.id === current.serverId && server.revision === current.serverRevision,
            )
              ? current
              : undefined,
          );
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
    setSourceFile(undefined);
    setCandidates([]);
    setApproved(false);
    setError('');
  }
  function readContent(
    server: McpRegistration,
    kind: 'resource' | 'resource_template' | 'prompt',
    entryKey: string,
    entryRevision: string,
    arguments_: Record<string, string>,
  ) {
    void operation(async () => {
      setPreview(undefined);
      const value = await previewMcpContent({
        serverId: server.id,
        serverRevision: server.revision,
        kind,
        entryKey,
        entryRevision,
        ...(kind === 'prompt' || kind === 'resource_template' ? { arguments: arguments_ } : {}),
      });
      if (mounted.current) setPreview(value);
    });
  }
  async function completeArgument(
    server: McpRegistration,
    kind: 'resource_template' | 'prompt',
    entryKey: string,
    entryRevision: string,
    argumentName: string,
    value: string,
    arguments_: Record<string, string>,
  ) {
    const result = await completeMcpArgument({
      serverId: server.id,
      serverRevision: server.revision,
      kind,
      entryKey,
      entryRevision,
      argumentName,
      value,
      arguments: Object.fromEntries(
        Object.entries(arguments_).filter(([, argument]) => argument.length > 0),
      ),
    });
    return result.values;
  }
  function attachContent(value: McpContentPreview) {
    void operation(async () => {
      await onAttach(value, provider === 'openrouter' && consent, baseVersion);
      if (mounted.current) {
        setPreview(undefined);
        setStatus('확인한 내용을 대화에 첨부했습니다.');
      }
    });
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
            도구를 호출하지 않습니다.
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
                setPreview(undefined);
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
                  MCP 도구 설명·결과와 첨부한 내용을 OpenRouter 및 모델 제공자에게 전송하는 데
                  동의합니다. 이전 대화에 남은 내용도 포함합니다.
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
        <section aria-label="대화에 첨부한 MCP 자료">
          <h3>첨부한 자료 · {attachments.length}/8</h3>
          <p>
            리소스와 프롬프트는 아래에서 직접 미리 보고 첨부할 수 있습니다. Plan과 Build 모두 첨부
            시점의 내용을 사용하며 서버의 변경 사항을 자동으로 가져오지 않습니다.
          </p>
          {!attachments.length && <p>첨부한 자료가 없습니다.</p>}
          {attachments.map((attachment) => (
            <article className="skill-card mcp-attachment" key={attachment.id}>
              <strong>
                {servers.find((server) => server.id === attachment.serverId)?.config.name ??
                  '저장된 서버 자료'}
              </strong>
              <p className="skill-source">
                {attachment.kind === 'resource'
                  ? '리소스'
                  : attachment.kind === 'resource_template'
                    ? '리소스 템플릿'
                    : '프롬프트'}{' '}
                · {attachment.resolvedUri ?? attachment.entryKey}
                <br />
                {attachment.bytes.toLocaleString()} bytes ·{' '}
                {new Date(attachment.readAt).toLocaleString()}
              </p>
              <details>
                <summary>첨부한 내용 보기</summary>
                <pre tabIndex={0}>{attachment.text}</pre>
              </details>
              <button
                type="button"
                disabled={busy || unavailable || running || conflict}
                onClick={() =>
                  void operation(async () => {
                    await onRemoveAttachment(attachment.id, baseVersion);
                    if (mounted.current)
                      setStatus(
                        '첨부 자료를 제거했습니다. 이전 대화에 전송된 내용은 남아 있습니다.',
                      );
                  })
                }
              >
                첨부 제거
              </button>
            </article>
          ))}
          {attachments.length >= 8 && (
            <p role="status">새 자료를 첨부하려면 기존 첨부를 제거하세요.</p>
          )}
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
                {server.config.transport === 'stdio' ? server.config.executable : server.config.url}
              </p>
              <small>
                {server.config.transport} · {server.protocol ?? '버전 미확인'} · 도구{' '}
                {server.tools.length}개 · 리소스 {server.resources?.length ?? 0}개 · 프롬프트{' '}
                {server.prompts?.length ?? 0}개{server.supportsCompletions ? ' · 인자 추천' : ''}
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
              <details className="mcp-content-catalog">
                <summary>리소스·프롬프트 찾아보기</summary>
                <p>
                  미리보기를 누르면 등록한 서버에 연결해 내용을 읽습니다. stdio 프로그램이
                  실행되거나 HTTP 서버에 요청이 전달될 수 있습니다.
                </p>
                {server.resources === undefined && server.prompts === undefined ? (
                  <p>이 서버를 다시 검사하면 리소스와 프롬프트 목록을 가져옵니다.</p>
                ) : (
                  <>
                    <h4>리소스</h4>
                    {!server.resources?.length && <p>등록된 리소스가 없습니다.</p>}
                    {server.resources?.map((resource) => {
                      const current =
                        preview?.serverId === server.id &&
                        preview.kind === 'resource' &&
                        preview.entryKey === resource.uri
                          ? preview
                          : undefined;
                      return (
                        <McpContentEntry
                          key={server.revision + resource.uri}
                          name={resource.name}
                          source={
                            resource.uri +
                            (resource.definition.mimeType
                              ? ` · ${resource.definition.mimeType}`
                              : '')
                          }
                          description={resource.definition.description}
                          parameters={[]}
                          supported={resource.supported}
                          issue={resource.issue}
                          disabled={busy || unavailable || running || conflict}
                          attachDisabledReason={attachDisabledReason}
                          preview={current}
                          onPreview={(arguments_) =>
                            readContent(
                              server,
                              'resource',
                              resource.uri,
                              resource.revision,
                              arguments_,
                            )
                          }
                          onInvalidate={() => {
                            if (current) setPreview(undefined);
                          }}
                          onAttach={attachContent}
                        />
                      );
                    })}
                    <h4>프롬프트</h4>
                    {!server.prompts?.length && <p>등록된 프롬프트가 없습니다.</p>}
                    {server.prompts?.map((prompt) => {
                      const current =
                        preview?.serverId === server.id &&
                        preview.kind === 'prompt' &&
                        preview.entryKey === prompt.name
                          ? preview
                          : undefined;
                      return (
                        <McpContentEntry
                          key={server.revision + prompt.name}
                          name={prompt.name}
                          source="서버 프롬프트"
                          description={prompt.definition.description}
                          parameters={prompt.definition.arguments ?? []}
                          supported={prompt.supported}
                          issue={prompt.issue}
                          disabled={busy || unavailable || running || conflict}
                          attachDisabledReason={attachDisabledReason}
                          preview={current}
                          onPreview={(arguments_) =>
                            readContent(server, 'prompt', prompt.name, prompt.revision, arguments_)
                          }
                          onComplete={
                            server.supportsCompletions
                              ? (argumentName, value, arguments_) =>
                                  completeArgument(
                                    server,
                                    'prompt',
                                    prompt.name,
                                    prompt.revision,
                                    argumentName,
                                    value,
                                    arguments_,
                                  )
                              : undefined
                          }
                          onInvalidate={() => {
                            if (current) setPreview(undefined);
                          }}
                          onAttach={attachContent}
                        />
                      );
                    })}
                    {!!server.resourceTemplates?.length && (
                      <>
                        <h4>리소스 템플릿</h4>
                        {server.resourceTemplates.map((template) => {
                          const current =
                            preview?.serverId === server.id &&
                            preview.kind === 'resource_template' &&
                            preview.entryKey === template.uriTemplate
                              ? preview
                              : undefined;
                          return (
                            <McpContentEntry
                              key={server.revision + template.uriTemplate}
                              name={template.name}
                              source={
                                template.uriTemplate +
                                (template.definition.mimeType
                                  ? ` · ${template.definition.mimeType}`
                                  : '')
                              }
                              description={template.definition.description}
                              parameters={template.variables.map((name) => ({
                                name,
                                required: true,
                              }))}
                              supported={template.supported}
                              issue={template.issue}
                              disabled={busy || unavailable || running || conflict}
                              attachDisabledReason={attachDisabledReason}
                              preview={current}
                              onPreview={(arguments_) =>
                                readContent(
                                  server,
                                  'resource_template',
                                  template.uriTemplate,
                                  template.revision,
                                  arguments_,
                                )
                              }
                              onComplete={
                                server.supportsCompletions
                                  ? (argumentName, value, arguments_) =>
                                      completeArgument(
                                        server,
                                        'resource_template',
                                        template.uriTemplate,
                                        template.revision,
                                        argumentName,
                                        value,
                                        arguments_,
                                      )
                                  : undefined
                              }
                              onInvalidate={() => {
                                if (current) setPreview(undefined);
                              }}
                              onAttach={attachContent}
                            />
                          );
                        })}
                      </>
                    )}
                  </>
                )}
              </details>
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
                      if (preview?.serverId === server.id) setPreview(undefined);
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
            Codex TOML, Claude·pi 계열 mcpServers JSON, OpenCode JSONC, Hermes YAML 또는 서버 하나의
            설정을 붙여 넣으세요. stdio는 설치된 node·python 등의 절대 경로가 필요하며, 기존 SSE
            서버는 transport를 sse로 지정할 수 있습니다.
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
              MCP 설정
              <textarea
                rows={10}
                spellCheck={false}
                maxLength={131072}
                value={source}
                onChange={(event) => {
                  setSource(event.target.value);
                  setSourceFile(undefined);
                  setCandidates([]);
                  setApproved(false);
                }}
              />
            </label>
            {sourceFile && <p className="skill-source">불러온 파일: {sourceFile.path}</p>}
            <div className="edit-actions">
              <button
                type="button"
                onClick={() =>
                  void operation(async () => {
                    const selected = await pickMcpConfig();
                    if (!selected || !mounted.current) return;
                    setSource(selected.text);
                    setSourceFile({
                      path: selected.path,
                      ...(selected.cwd ? { cwd: selected.cwd } : {}),
                    });
                    setCandidates([]);
                    setApproved(false);
                  }, false)
                }
              >
                설정 파일 선택
              </button>
              <button
                disabled={!source.trim()}
                onClick={() =>
                  void operation(async () => {
                    const values = await importMcp(source, sourceFile?.cwd ?? projectPath);
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
                {candidate.warnings.map((warning, i) => (
                  <p role="status" key={`warning-${i}`}>
                    {warning}
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
                    실행되고 HTTP·SSE 서버에는 지정한 인증값이 전달됩니다.
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
                            '연결 검사 후 등록했습니다. 위 목록에서 도구를 선택하거나 자료를 미리 보세요.',
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
            첨부는 정적·매개변수형 텍스트 리소스와 프롬프트를 지원합니다. 이미지·파일 데이터와
            참조·정규식·format이 필요한 도구 입력 형식은 지원하지 않습니다.
          </p>
        </section>
        <McpOAuthPanel connected={connected} />
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
