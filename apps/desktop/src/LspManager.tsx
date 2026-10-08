import { t as localize } from './i18n';
import { SettingsSurface } from './SettingsSurface';
import { useEffect, useState } from 'react';
import type { LanguageServerStatus, Project, LspOperation } from '@lodex/contracts';
import {
  languageServerAction,
  languageServerList,
  nativeDesktop,
  queryLanguageServer,
  registerLanguageServer,
} from './bridge';
export function LspManager({
  projects,
  selectedId,
}: {
  projects: Project[];
  selectedId: string | null;
}) {
  const [servers, setServers] = useState<LanguageServerStatus[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [projectId, setProjectId] = useState(selectedId ?? ''),
    [name, setName] = useState(''),
    [executable, setExecutable] = useState(''),
    [args, setArgs] = useState('[]'),
    [languageId, setLanguageId] = useState('typescript'),
    [extensions, setExtensions] = useState('.ts, .tsx'),
    [consent, setConsent] = useState(false),
    [editing, setEditing] = useState<LanguageServerStatus>();
  const [file, setFile] = useState(''),
    [operation, setOperation] = useState<LspOperation>('diagnostics'),
    [line, setLine] = useState(1),
    [column, setColumn] = useState(1),
    [result, setResult] = useState('');
  const refresh = async () => setServers((await languageServerList()).servers);
  useEffect(() => {
    void refresh().catch((error: unknown) => setError(String(error)));
  }, []);
  const act = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    try {
      await work();
      await refresh();
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  function edit(server: LanguageServerStatus) {
    const config = server.registration.config;
    setEditing(server);
    setProjectId(config.projectId);
    setName(config.name);
    setExecutable(config.executable);
    setArgs(JSON.stringify(config.args));
    setLanguageId(config.languageId);
    setExtensions(config.extensions.join(', '));
    setConsent(false);
  }
  return (
    <SettingsSurface
      embedded
      className="settings-form"
      aria-label={localize('언어 서버 설정')}
      aria-busy={busy}
    >
      <h2>{localize('언어 서버 · LSP')}</h2>
      <p>
        {localize(
          '프로젝트의 진단, 정의, 참조, 설명과 심볼을 조회합니다. 설치된 언어 서버를 직접 등록하세요.',
        )}
      </p>
      <label>
        {localize('프로젝트')}
        <select
          value={projectId}
          disabled={busy}
          onChange={(event) => setProjectId(event.target.value)}
        >
          <option value="">{localize('프로젝트 선택')}</option>
          {projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        {localize('이름')}
        <input value={name} disabled={busy} onChange={(event) => setName(event.target.value)} />
      </label>
      <label>
        {localize('실행파일 절대 경로')}
        <input
          value={executable}
          disabled={busy}
          onChange={(event) => setExecutable(event.target.value)}
          placeholder="C:\Program Files\nodejs\node.exe"
        />
      </label>
      <label>
        {localize('실행 인자 · JSON 배열')}
        <input
          value={args}
          disabled={busy}
          onChange={(event) => setArgs(event.target.value)}
          placeholder={'["/path/to/language-server.js", "--stdio"]'}
        />
      </label>
      <label>
        {localize('언어 ID')}
        <input
          value={languageId}
          disabled={busy}
          onChange={(event) => setLanguageId(event.target.value)}
        />
      </label>
      <label>
        {localize('파일 확장자 · 쉼표로 구분')}
        <input
          value={extensions}
          disabled={busy}
          onChange={(event) => setExtensions(event.target.value)}
        />
      </label>
      <label className="check-row">
        <input
          type="checkbox"
          checked={consent}
          disabled={busy}
          onChange={(event) => setConsent(event.target.checked)}
        />
        {localize('이 프로그램이 내 컴퓨터 권한으로 실행되는 것을 허용합니다.')}
      </label>
      <p>
        {localize(
          '등록한 프로그램은 호스트 파일과 네트워크에 접근할 수 있습니다. Plan에서도 읽기 조회에 사용되며, Lodex는 서버가 요청하는 파일 수정과 명령 실행을 허용하지 않습니다.',
        )}
      </p>
      <div className="edit-actions">
        <button
          className="primary-button"
          disabled={busy || !nativeDesktop || !projectId || !name.trim() || !executable || !consent}
          onClick={() =>
            void act(async () => {
              const values: unknown = JSON.parse(args);
              if (!Array.isArray(values) || values.some((value) => typeof value !== 'string'))
                throw new Error(localize('실행 인자는 문자열 JSON 배열이어야 합니다.'));
              await registerLanguageServer(
                {
                  projectId,
                  name,
                  executable,
                  args: values as string[],
                  languageId,
                  extensions: extensions
                    .split(',')
                    .map((value) => value.trim().toLowerCase())
                    .filter(Boolean),
                  hostExecutionConsent: true,
                },
                editing?.registration.id,
                editing?.registration.revision,
              );
              setEditing(undefined);
              setConsent(false);
            })
          }
        >
          {editing ? localize('검증 후 설정 저장') : localize('실행파일 확인 후 등록')}
        </button>
        {editing && (
          <button
            disabled={busy}
            onClick={() => {
              setEditing(undefined);
              setConsent(false);
            }}
          >
            {localize('편집 취소')}
          </button>
        )}
      </div>
      {error && (
        <p role="alert" className="error-text">
          {error}
        </p>
      )}
      <section className="integration-section">
        <h3>{localize('연결 확인')}</h3>
        <label>
          {localize('프로젝트 파일 경로')}
          <input
            value={file}
            disabled={busy}
            onChange={(event) => setFile(event.target.value)}
            placeholder="src/index.ts"
          />
        </label>
        <label>
          {localize('조회')}
          <select
            value={operation}
            onChange={(event) => setOperation(event.target.value as LspOperation)}
          >
            {(
              [
                ['diagnostics', localize('진단')],
                ['definitions', localize('정의')],
                ['references', localize('참조')],
                ['hover', localize('설명')],
                ['document_symbols', localize('문서 심볼')],
              ] as const
            ).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          {localize('줄')}
          <input
            type="number"
            min={1}
            value={line}
            onChange={(event) => setLine(Number(event.target.value))}
          />
        </label>
        <label>
          {localize('열')}
          <input
            type="number"
            min={1}
            value={column}
            onChange={(event) => setColumn(Number(event.target.value))}
          />
        </label>
        {result && <pre>{result}</pre>}
      </section>
      {servers.map((server) => (
        <section className="integration-section" key={server.registration.id}>
          <strong>{server.registration.config.name}</strong>
          <p>
            {projects.find((project) => project.id === server.registration.config.projectId)
              ?.name ?? localize('프로젝트 없음')}{' '}
            · {server.registration.config.languageId} ·{' '}
            {server.active
              ? localize('조회 중')
              : server.running
                ? localize('실행 중')
                : localize('중지됨')}
          </p>
          <p className="integration-path">{server.registration.config.executable}</p>
          {server.error && <p role="status">{server.error}</p>}
          <div className="edit-actions">
            <button disabled={busy || server.active} onClick={() => edit(server)}>
              {localize('설정 편집')}
            </button>
            <button
              disabled={busy || !server.running}
              onClick={() =>
                void act(() =>
                  languageServerAction(
                    'stop',
                    server.registration.id,
                    server.registration.revision,
                  ),
                )
              }
            >
              {localize('서버 중지')}
            </button>
            <button
              disabled={busy || server.active}
              onClick={() =>
                void act(() =>
                  languageServerAction(
                    'remove',
                    server.registration.id,
                    server.registration.revision,
                  ),
                )
              }
            >
              {localize('등록 삭제')}
            </button>
            <button
              disabled={busy || !file.trim() || server.registration.requiresReview}
              onClick={() =>
                void act(async () =>
                  setResult(
                    JSON.stringify(
                      await queryLanguageServer(server.registration.config.projectId, operation, {
                        serverId: server.registration.id,
                        path: file,
                        line,
                        column,
                      }),
                      null,
                      2,
                    ),
                  ),
                )
              }
            >
              {localize('파일 조회')}
            </button>
          </div>
        </section>
      ))}
    </SettingsSurface>
  );
}
