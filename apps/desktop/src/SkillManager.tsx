import { useEffect, useRef, useState } from 'react';
import type { Session } from '@lodex/contracts';
import type { DiscoveredSkill, RegisteredSkill, SkillDialect, SkillPlatform } from '@lodex/skills';
import {
  discoverSkills,
  nativeDesktop,
  pickProjectFolder,
  registeredSkills,
  registerSkill,
  removeSkill,
} from './bridge';
import { Icon } from './icons';

type Selection = { id: string; revision: string };
export interface SkillSelectionSave {
  skills: Selection[];
  skillCloudConsent: boolean;
  expectedVersion: number | undefined;
}
type Registration = { path: string; dialect: SkillDialect; id?: string; expectedRevision?: string };
const dialectNames: Record<SkillDialect, string> = {
  standard: 'Agent Skills',
  codex: 'Codex',
  claude: 'Claude Code',
  pi: 'pi',
  opencode: 'OpenCode',
  openclaw: 'OpenClaw',
  hermes: 'Hermes Agent',
};
const blank = (): Registration => ({ path: '', dialect: 'standard' });
const failureMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));
const currentPlatform = (): SkillPlatform | null => {
  if (typeof navigator === 'undefined') return null;
  const value = `${navigator.platform} ${navigator.userAgent}`.toLowerCase();
  if (value.includes('win')) return 'windows';
  if (value.includes('mac')) return 'macos';
  if (value.includes('linux')) return 'linux';
  return null;
};
const supportsCurrentPlatform = (skill: RegisteredSkill) => {
  const platform = currentPlatform();
  return !skill.platforms?.length || (platform !== null && skill.platforms.includes(platform));
};
const samePath = (left: string, right: string) =>
  currentPlatform() === 'windows'
    ? left.toLocaleLowerCase() === right.toLocaleLowerCase()
    : left === right;

export function SkillManager({
  session,
  projectId,
  provider,
  connected,
  onClose,
  onSave,
}: {
  session: Session | undefined;
  projectId: string | undefined;
  provider: string;
  connected: boolean;
  onClose: () => void;
  onSave: (value: SkillSelectionSave) => Promise<void>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const mounted = useRef(false),
    busyRef = useRef(false),
    catalogRequest = useRef(0);
  const [skills, setSkills] = useState<RegisteredSkill[]>([]);
  const [discovered, setDiscovered] = useState<DiscoveredSkill[] | null>(null);
  const [loaded, setLoaded] = useState(!nativeDesktop);
  const [selected, setSelected] = useState<Selection[]>(() => session?.skills ?? []);
  const [consent, setConsent] = useState(session?.skillCloudConsent ?? false);
  const [baseVersion, setBaseVersion] = useState(session?.version);
  const [registration, setRegistration] = useState(blank);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [connectionError, setConnectionError] = useState(''),
    [status, setStatus] = useState('');
  const running = session?.run?.status === 'running';
  const unavailable = !nativeDesktop || !loaded || !connected;
  const sessionConflict = session?.version !== baseVersion;
  const currentRegistration = skills.find((skill) => skill.id === registration.id);
  const registrationConflict =
    !!registration.id && currentRegistration?.revision !== registration.expectedRevision;
  const invalidSelection = selected.some((selection) => {
    const skill = skills.find((entry) => entry.id === selection.id);
    return (
      !skill ||
      !skill.invocation.model ||
      !supportsCurrentPlatform(skill) ||
      skill.revision !== selection.revision
    );
  });

  async function refresh() {
    const request = ++catalogRequest.current;
    try {
      const next = await registeredSkills();
      if (!mounted.current || catalogRequest.current !== request) return;
      setSkills(next);
      setLoaded(true);
      setConnectionError('');
    } catch (failure) {
      if (mounted.current && catalogRequest.current === request)
        setConnectionError(failureMessage(failure));
    }
  }
  useEffect(() => {
    mounted.current = true;
    dialog.current?.showModal();
    let pending = false;
    const poll = async () => {
      if (!nativeDesktop || pending) return;
      pending = true;
      try {
        await refresh();
      } finally {
        pending = false;
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 2000);
    return () => {
      mounted.current = false;
      catalogRequest.current++;
      clearInterval(timer);
    };
  }, []);
  async function operation(work: () => Promise<void>, refreshAfter = true) {
    if (busyRef.current || unavailable) return;
    busyRef.current = true;
    catalogRequest.current++;
    setBusy(true);
    setError('');
    setStatus('');
    try {
      await work();
      if (mounted.current && refreshAfter) await refresh();
    } catch (failure) {
      if (mounted.current) {
        setError(failureMessage(failure));
        if (refreshAfter) await refresh();
      }
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  function editRegistration(skill: RegisteredSkill) {
    setRegistration({
      id: skill.id,
      expectedRevision: skill.revision,
      path: skill.source.rootPath,
      dialect: skill.dialect,
    });
    setError('');
    setStatus('');
  }
  function choose(skill: RegisteredSkill, checked: boolean) {
    setSelected((current) => {
      if (
        checked &&
        current.length >= 16 &&
        !current.some((selection) => selection.id === skill.id)
      )
        return current;
      return checked
        ? [
            ...current.filter((selection) => selection.id !== skill.id),
            { id: skill.id, revision: skill.revision },
          ]
        : current.filter((selection) => selection.id !== skill.id);
    });
    setStatus('');
  }
  return (
    <dialog
      className="settings-dialog skill-manager"
      ref={dialog}
      onCancel={onClose}
      aria-labelledby="skill-manager-title"
      aria-busy={busy}
    >
      <div className="dialog-header">
        <h2 id="skill-manager-title">스킬</h2>
        <button className="icon-button" aria-label="스킬 관리 닫기" onClick={onClose}>
          <Icon name="close" />
        </button>
      </div>
      <div className="settings-body">
        {!nativeDesktop && (
          <p className="demo-notice">스킬 등록과 대화 연결은 데스크톱 앱에서 사용할 수 있습니다.</p>
        )}
        {!loaded && <p role="status">스킬 목록을 불러오는 중…</p>}
        {connectionError && (
          <p className="form-error" role="alert">
            {connectionError}
          </p>
        )}
        <section aria-labelledby="skill-selection-title">
          <h3 id="skill-selection-title">
            {session ? '이 대화에서 사용할 스킬' : '새 대화에서 사용할 스킬'} · {selected.length}/16
          </h3>
          <p>
            선택한 스킬의 이름과 설명을 모델에 전달합니다. 지침 본문과 리소스는 모델이 필요할 때
            읽습니다.
          </p>
          <p>선택을 해제해도 이전 대화에서 읽은 스킬 내용은 남습니다.</p>
          {running && <p role="status">대화 실행이 끝나면 스킬 선택을 변경할 수 있습니다.</p>}
          {sessionConflict && (
            <div role="status" className="skill-conflict">
              <p>대화가 변경되었습니다. 저장된 선택을 다시 불러온 뒤 편집하세요.</p>
              <button
                type="button"
                disabled={busy || running}
                onClick={() => {
                  setSelected(session?.skills ?? []);
                  setConsent(session?.skillCloudConsent ?? false);
                  setBaseVersion(session?.version);
                  setError('');
                }}
              >
                저장된 선택 불러오기
              </button>
            </div>
          )}
          <fieldset disabled={busy || running || unavailable}>
            {selected.length > 0 && (
              <ul className="skill-selection-list" aria-label="선택한 스킬">
                {selected.map((selection) => {
                  const skill = skills.find((entry) => entry.id === selection.id);
                  const stale = skill?.revision !== selection.revision;
                  return (
                    <li key={selection.id}>
                      <span>
                        {skill?.name ?? '등록이 제거된 스킬'}
                        {stale && <small> · 다시 선택 필요</small>}
                      </span>
                      <button
                        type="button"
                        aria-label={`${skill?.name ?? '제거된 스킬'} 선택 해제`}
                        onClick={() =>
                          setSelected((current) =>
                            current.filter((entry) => entry.id !== selection.id),
                          )
                        }
                      >
                        선택 해제
                      </button>
                    </li>
                  );
                })}
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
                  선택한 스킬의 이름·설명·모델이 읽는 지침과 리소스를 OpenRouter 및 선택한 모델
                  제공자에게 전송하는 데 동의합니다. 이전 대화에 남은 스킬 내용도 포함합니다.
                </span>
              </label>
            )}
            {invalidSelection && (
              <p className="form-error">
                변경되거나 사용할 수 없는 스킬을 선택 해제하거나 최신 등록 정보로 다시 선택하세요.
              </p>
            )}
            <button
              className="primary-button"
              type="button"
              disabled={
                sessionConflict ||
                invalidSelection ||
                (provider === 'openrouter' && selected.length > 0 && !consent)
              }
              onClick={() =>
                void operation(async () => {
                  if (running || sessionConflict || invalidSelection) return;
                  await onSave({
                    skills: selected,
                    skillCloudConsent: provider === 'openrouter' && consent,
                    expectedVersion: baseVersion,
                  });
                }, false)
              }
            >
              {busy ? '처리 중…' : session ? '대화에 적용' : '선택한 스킬로 새 대화'}
            </button>
          </fieldset>
        </section>
        <section aria-labelledby="skill-discovery-title">
          <h3 id="skill-discovery-title">기본 위치에서 찾기</h3>
          <p>
            Codex·Claude Code·pi·OpenCode·OpenClaw·Hermes와 Agent Skills의 알려진 사용자 폴더를
            확인합니다. 프로젝트가 선택되어 있으면 프로젝트 전용 폴더도 함께 확인합니다.
          </p>
          <button
            type="button"
            disabled={unavailable || busy}
            onClick={() =>
              void operation(async () => {
                const next = await discoverSkills(projectId);
                if (mounted.current) {
                  setDiscovered(next);
                  setStatus(
                    next.length
                      ? `${next.length}개의 스킬 폴더를 찾았습니다.`
                      : '알려진 기본 위치에서 스킬을 찾지 못했습니다.',
                  );
                }
              }, false)
            }
          >
            기본 위치 검색
          </button>
          {discovered && discovered.length > 0 && (
            <ul className="skill-discovery-list" aria-label="발견한 스킬 폴더">
              {discovered.map((candidate) => {
                const registered = skills.some((skill) =>
                  samePath(skill.source.rootPath, candidate.path),
                );
                return (
                  <li key={`${candidate.dialect}:${candidate.path}`}>
                    <span>
                      <strong>{candidate.path.split(/[\\/]/).at(-1)}</strong>
                      <small>
                        {dialectNames[candidate.dialect]} ·{' '}
                        {candidate.scope === 'project' ? '프로젝트' : '사용자'}
                      </small>
                      <span className="skill-source">{candidate.path}</span>
                    </span>
                    <button
                      type="button"
                      disabled={unavailable || busy || registered}
                      onClick={() =>
                        void operation(async () => {
                          await registerSkill({
                            path: candidate.path,
                            dialect: candidate.dialect,
                          });
                          if (mounted.current)
                            setStatus(
                              `${candidate.source} 스킬을 등록했습니다. 사용할 대화에서 선택하세요.`,
                            );
                        })
                      }
                    >
                      {registered ? '등록됨' : '등록'}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
        <section className="skill-catalog" aria-label="등록한 스킬">
          <h3>등록한 스킬</h3>
          {loaded && skills.length === 0 && (
            <p>등록한 스킬이 없습니다. 아래에서 SKILL.md가 있는 폴더를 선택하세요.</p>
          )}
          {skills.map((skill) => {
            const selection = selected.find((entry) => entry.id === skill.id);
            const stale = !!selection && selection.revision !== skill.revision;
            const incompatible = !supportsCurrentPlatform(skill);
            return (
              <article className="skill-card" key={skill.id}>
                <label className="check-field">
                  <input
                    type="checkbox"
                    checked={!!selection}
                    disabled={
                      unavailable ||
                      busy ||
                      running ||
                      !skill.invocation.model ||
                      incompatible ||
                      (!selection && selected.length >= 16)
                    }
                    onChange={(event) => choose(skill, event.target.checked)}
                  />
                  <strong>{skill.name}</strong>
                </label>
                <p>{skill.description}</p>
                <small>
                  {dialectNames[skill.dialect]} · 리소스 {skill.files.length}개
                </small>
                <p className="skill-source">{skill.source.rootPath}</p>
                {!skill.invocation.model && (
                  <p>
                    모델 호출이 금지된 스킬입니다. 직접 첨부 기능은 아직 지원하지 않아 선택할 수
                    없습니다.
                  </p>
                )}
                {incompatible && (
                  <p>현재 운영체제를 지원하지 않는 스킬이므로 이 대화에서 선택할 수 없습니다.</p>
                )}
                {stale && skill.invocation.model && (
                  <div className="skill-conflict">
                    <p>등록 정보가 변경되었습니다. 아래 정보를 검토한 뒤 새 버전을 선택하세요.</p>
                    <button
                      type="button"
                      disabled={unavailable || busy || running}
                      onClick={() => choose(skill, true)}
                    >
                      새 버전 선택
                    </button>
                  </div>
                )}
                <details>
                  <summary>등록 정보·호환성</summary>
                  <dl>
                    {skill.license && (
                      <>
                        <dt>라이선스</dt>
                        <dd>{skill.license}</dd>
                      </>
                    )}
                    {skill.compatibility && (
                      <>
                        <dt>호환성</dt>
                        <dd>{skill.compatibility}</dd>
                      </>
                    )}
                    {skill.platforms?.length && (
                      <>
                        <dt>지원 운영체제</dt>
                        <dd>{skill.platforms.join(', ')}</dd>
                      </>
                    )}
                    <dt>확인 시각</dt>
                    <dd>{new Date(skill.inspectedAt).toLocaleString()}</dd>
                    <dt>등록 버전</dt>
                    <dd className="skill-revision">{skill.revision}</dd>
                  </dl>
                  {Object.entries(skill.metadata).length > 0 && (
                    <dl>
                      {Object.entries(skill.metadata).map(([key, value]) => (
                        <div key={key}>
                          <dt>{key}</dt>
                          <dd>{value}</dd>
                        </div>
                      ))}
                    </dl>
                  )}
                  <h4>의존성</h4>
                  {skill.dependencies.length ? (
                    <ul>
                      {skill.dependencies.map((dependency, index) => (
                        <li key={index}>
                          {dependency.type}: {dependency.value}
                          {dependency.transport && ` · ${dependency.transport}`} · 연결 확인 안 됨
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p>선언된 의존성 없음</p>
                  )}
                  {skill.diagnostics.length > 0 && (
                    <>
                      <h4>가져오기 안내</h4>
                      <ul>
                        {skill.diagnostics.map((diagnostic, index) => (
                          <li key={index}>
                            {diagnostic.message}
                            {diagnostic.path && ` (${diagnostic.path})`}
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                  <p>등록은 스크립트를 실행하거나 의존성을 설치하지 않습니다.</p>
                </details>
                <div className="edit-actions">
                  <button
                    type="button"
                    disabled={unavailable || busy}
                    onClick={() => editRegistration(skill)}
                  >
                    등록 설정 편집
                  </button>
                  <button
                    type="button"
                    disabled={unavailable || busy}
                    onClick={() =>
                      void operation(async () => {
                        await registerSkill({
                          path: skill.source.rootPath,
                          dialect: skill.dialect,
                          id: skill.id,
                          expectedRevision: skill.revision,
                        });
                        if (mounted.current)
                          setStatus(
                            '폴더를 다시 확인했습니다. 변경된 스킬은 새 버전으로 선택하세요.',
                          );
                      })
                    }
                  >
                    폴더 다시 확인
                  </button>
                  <button
                    type="button"
                    disabled={unavailable || busy}
                    onClick={() =>
                      void operation(async () => {
                        await removeSkill(skill.id, skill.revision);
                        if (mounted.current) {
                          if (registration.id === skill.id) setRegistration(blank());
                          setStatus('등록 목록에서 제거했습니다. 폴더와 파일은 그대로 있습니다.');
                        }
                      })
                    }
                  >
                    목록에서 제거
                  </button>
                </div>
              </article>
            );
          })}
        </section>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (registrationConflict) return;
            void operation(async () => {
              await registerSkill({ ...registration, path: registration.path.trim() });
              if (mounted.current) {
                setRegistration(blank());
                setStatus('등록했습니다. 위 목록에서 이 대화에 사용할 스킬을 선택하세요.');
              }
            });
          }}
        >
          <fieldset disabled={busy || unavailable}>
            <h3>{registration.id ? '스킬 등록 설정 편집' : '스킬 폴더 등록'}</h3>
            {registrationConflict && (
              <div className="skill-conflict" role="status">
                <p>
                  {currentRegistration
                    ? '다른 창에서 등록 정보를 변경했습니다.'
                    : '이 등록 정보가 제거되었습니다.'}
                </p>
                {currentRegistration ? (
                  <button type="button" onClick={() => editRegistration(currentRegistration)}>
                    저장된 등록 정보 불러오기
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() =>
                      setRegistration(({ id: _id, expectedRevision: _revision, ...value }) => value)
                    }
                  >
                    새 등록으로 전환
                  </button>
                )}
              </div>
            )}
            <label className="field">
              SKILL.md가 있는 폴더
              <div className="input-action">
                <input
                  required
                  maxLength={4096}
                  value={registration.path}
                  onChange={(event) =>
                    setRegistration({ ...registration, path: event.target.value })
                  }
                  placeholder="스킬 하나가 들어 있는 로컬 폴더"
                />
                <button
                  type="button"
                  onClick={() =>
                    void operation(async () => {
                      const path = await pickProjectFolder();
                      if (path && mounted.current)
                        setRegistration((current) => ({ ...current, path }));
                    }, false)
                  }
                >
                  폴더 선택
                </button>
              </div>
            </label>
            <label className="field">
              스킬 형식
              <select
                value={registration.dialect}
                onChange={(event) =>
                  setRegistration({ ...registration, dialect: event.target.value as SkillDialect })
                }
              >
                {(Object.entries(dialectNames) as [SkillDialect, string][]).map(
                  ([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ),
                )}
              </select>
            </label>
            <div className="edit-actions">
              <button
                className="primary-button"
                disabled={registrationConflict || !registration.path.trim()}
              >
                {busy ? '처리 중…' : '폴더 확인·등록'}
              </button>
              {registration.id && (
                <button type="button" onClick={() => setRegistration(blank())}>
                  새 스킬 입력
                </button>
              )}
            </div>
          </fieldset>
        </form>
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
