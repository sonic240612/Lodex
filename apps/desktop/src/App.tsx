import { useEffect, useRef, useState, lazy, Suspense, type FormEvent } from 'react';
import {
  modelConfigSchema,
  defaultPlan,
  type ModelConfig,
  type ModelDescriptor,
  type Plan,
  type Session,
  type AgentMode,
  type LocalProfile,
  type AgentRoutingConfig,
  resolveModelConfig,
  autopilotLimitsSchema,
  defaultPermissionMode,
  type PermissionMode,
} from '@lodex/contracts';
import {
  approvalAction,
  models,
  nativeDesktop,
  saveKey,
  sendCommand,
  snapshot,
  subscribe,
} from './bridge';
import { Icon, Logo } from './icons';
import { useWorkspace } from './state';
import { ActivityCards } from './ActivityCards';
import { loadLastModelConfig } from './model-preference';
import { ProjectDialog } from './ProjectDialog';
import { Markdown } from './Markdown';
import { ConversationHistory } from './ConversationHistory';
import { ExecutionPanel } from './ExecutionPanel';
import { AutopilotPanel } from './AutopilotPanel';
import { appendPlanTask, normalizePlanDraft, removePlanTask } from './plan-draft';
import type { SkillSelectionSave } from './SkillManager';
import type { McpSelectionSave } from './McpManager';
import type { McpContentPreview } from '@lodex/contracts';
const McpManager = lazy(() =>
  import('./McpManager').then((module) => ({ default: module.McpManager })),
);
const ModelManager = lazy(() =>
  import('./ModelManager').then((module) => ({ default: module.ModelManager })),
);
const SkillManager = lazy(() =>
  import('./SkillManager').then((module) => ({ default: module.SkillManager })),
);
const RoutingSettings = lazy(() =>
  import('./RoutingSettings').then((module) => ({ default: module.RoutingSettings })),
);
const TelegramSettings = lazy(() =>
  import('./TelegramSettings').then((module) => ({ default: module.TelegramSettings })),
);
const WorktreeManager = lazy(() =>
  import('./WorktreeManager').then((module) => ({ default: module.WorktreeManager })),
);

const providerName = (provider: string) =>
  provider === 'openrouter' ? 'OpenRouter' : provider === 'demo' ? '데모' : 'llama-server';
const messageError = (error: unknown) => (error instanceof Error ? error.message : String(error));
const permissionLabel: Record<PermissionMode, string> = {
  ask: '승인 요청',
  auto: '대신 승인',
  full: '전체 접근',
};

export function App() {
  const workspace = useWorkspace();
  const session = workspace.sessions.find((s) => s.id === workspace.selectedId);
  const [settings, setSettings] = useState(false);
  const [modelManager, setModelManager] = useState(false);
  const [routingSettings, setRoutingSettings] = useState(false);
  const [telegramSettings, setTelegramSettings] = useState(false);
  const [worktreeManager, setWorktreeManager] = useState(false);
  const [skillManager, setSkillManager] = useState(false);
  const [mcpManager, setMcpManager] = useState(false);
  const [projectDialog, setProjectDialog] = useState(false);
  const [permissionMenu, setPermissionMenu] = useState(false);
  const [confirmFullAccess, setConfirmFullAccess] = useState(false);
  const [showActivities, setShowActivities] = useState(() => {
    try {
      return localStorage.getItem('lodex.showActivities') !== 'false';
    } catch {
      return true;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem('lodex.showActivities', String(showActivities));
    } catch {
      /* Display preference only. */
    }
  }, [showActivities]);
  const [planOpen, setPlanOpen] = useState(window.innerWidth >= 1180);
  const [sidebarOpen, setSidebarOpen] = useState(window.innerWidth > 760);
  const [error, setError] = useState('');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [newMode, setNewMode] = useState<AgentMode>('plan');
  const mode = session?.mode ?? newMode;
  const [light, setLight] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const config = session ? resolveModelConfig(session) : workspace.config;
  const contextProvider =
    config.provider === 'openrouter' ||
    (session?.routing?.subagentsEnabled &&
      (session.routing.subagent ?? session.config).provider === 'openrouter')
      ? 'openrouter'
      : config.provider;
  const running = session?.run?.status === 'running';
  const permissionMode = session?.permissionMode ?? defaultPermissionMode();
  const pendingApproval = session?.messages
    .flatMap((message) => message.activities ?? [])
    .find((activity) => activity.approval?.status === 'pending');
  const project = workspace.projects.find((p) => p.id === workspace.selectedProjectId);
  const visibleSessions = workspace.sessions.filter(
    (s) => (s.projectId ?? null) === workspace.selectedProjectId,
  );

  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'n') {
        event.preventDefault();
        useWorkspace.getState().select(null);
        setText('');
        composer.current?.focus();
      }
    };
    window.addEventListener('keydown', shortcut);
    return () => window.removeEventListener('keydown', shortcut);
  }, []);

  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if (event.ctrlKey && !event.altKey && !event.shiftKey && event.code === 'Period') {
        event.preventDefault();
        if (!busy && !running && workspace.connected)
          void changeMode(mode === 'plan' ? 'build' : 'plan');
      }
    };
    window.addEventListener('keydown', shortcut);
    return () => window.removeEventListener('keydown', shortcut);
  }, [busy, mode, running, session?.id, session?.version, workspace.connected]);

  useEffect(() => {
    let disposed = false,
      cleanup: (() => void) | undefined,
      timer: ReturnType<typeof setTimeout> | undefined;
    let retries = 0;
    const connect = async () => {
      try {
        const state = await snapshot();
        if (disposed) return;
        if (nativeDesktop && !loadLastModelConfig() && state.sessions[0])
          useWorkspace.getState().setConfig(state.sessions[0].config);
        useWorkspace.getState().replace(state);
        retries = 0;
        cleanup = await subscribe(
          state.lastSeq,
          (event) => {
            if (!disposed) useWorkspace.getState().event(event);
          },
          retry,
        );
        if (disposed) cleanup();
      } catch (failure) {
        if (!disposed) {
          setError(messageError(failure));
          retry();
        }
      }
    };
    const retry = () => {
      if (disposed) return;
      useWorkspace.getState().setConnected(false);
      clearTimeout(timer);
      timer = setTimeout(
        () => {
          void connect();
        },
        Math.min(1000 * 2 ** retries++, 15000),
      );
    };
    void connect();
    return () => {
      disposed = true;
      cleanup?.();
      clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    end.current?.scrollIntoView({ behavior: running ? 'instant' : 'smooth', block: 'end' });
  }, [session?.id, session?.messages.at(-1)?.content, running]);
  async function createSession(
    modelConfig = workspace.config,
    routing = session?.routing,
  ): Promise<Session> {
    const result = await sendCommand({
      type: 'create_session',
      sessionId: crypto.randomUUID(),
      title: '새 대화',
      config: modelConfig,
      ...(routing ? { routing } : {}),
      projectId: workspace.selectedProjectId,
      mode,
    });
    workspace.upsert(result.session);
    workspace.setConfig(modelConfig);
    workspace.select(result.session.id);
    return result.session;
  }
  async function submit(event?: FormEvent) {
    event?.preventDefault();
    if (!text.trim() || busy || running || !workspace.connected) return;
    if (config.provider !== 'demo' && !config.model) {
      setSettings(true);
      return;
    }
    const content = text.trim();
    const goal = content.match(/^\/goal(?:\s+([\s\S]+))?$/i);
    if (goal && !goal[1]?.trim()) {
      setError('사용법: /goal 달성할 목표');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const target = session ?? (await createSession());
      const result = await sendCommand(
        goal
          ? {
              type: 'start_goal',
              sessionId: target.id,
              expectedVersion: target.version,
              goal: goal[1]!.trim(),
              limits: autopilotLimitsSchema.parse({}),
            }
          : {
              type: 'send_message',
              sessionId: target.id,
              expectedVersion: target.version,
              content,
            },
      );
      workspace.upsert(result.session);
      setText('');
    } catch (failure) {
      setError(messageError(failure));
    } finally {
      setBusy(false);
    }
  }
  async function cancel() {
    if (!session?.run || busy) return;
    setBusy(true);
    try {
      const result = await sendCommand({
        type: 'cancel_run',
        sessionId: session.id,
        runId: session.run.id,
      });
      workspace.upsert(result.session);
    } catch (failure) {
      setError(messageError(failure));
    } finally {
      setBusy(false);
    }
  }
  async function compactContext() {
    if (!session || busy || running || !workspace.connected) return;
    setBusy(true);
    setError('');
    try {
      const result = await sendCommand({
        type: 'compact_context',
        sessionId: session.id,
        expectedVersion: session.version,
      });
      workspace.upsert(result.session);
    } catch (failure) {
      setError(messageError(failure));
    } finally {
      setBusy(false);
    }
  }
  async function changePermissionMode(value: PermissionMode) {
    if (!session || busy || !workspace.connected) {
      setError('먼저 대화를 만드세요.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const result = await sendCommand({
        type: 'set_permission_mode',
        sessionId: session.id,
        expectedVersion: session.version,
        mode: value,
      });
      workspace.upsert(result.session);
      setPermissionMenu(false);
    } catch (failure) {
      setError(messageError(failure));
    } finally {
      setBusy(false);
    }
  }
  async function decideApproval(action: 'approve' | 'reject') {
    if (!session || !pendingApproval || busy) return;
    setBusy(true);
    setError('');
    try {
      let updated = await approvalAction({
        sessionId: session.id,
        expectedVersion: session.version,
        activityId: pendingApproval.id,
        action,
      });
      workspace.upsert(updated);
      if (
        action === 'approve' &&
        updated.autopilot?.goalDriven &&
        updated.autopilot.status === 'paused'
      ) {
        updated = (
          await sendCommand({
            type: 'resume_goal',
            sessionId: updated.id,
            expectedVersion: updated.version,
          })
        ).session;
        workspace.upsert(updated);
      }
    } catch (failure) {
      setError(messageError(failure));
      try {
        workspace.replace(await snapshot());
      } catch {
        /* Reconnect refreshes. */
      }
    } finally {
      setBusy(false);
    }
  }
  async function applyConfig(value: ModelConfig) {
    workspace.setConfig(value);
    if (session?.messages.length) await createSession(value);
    else if (session) {
      const result = await sendCommand({
        type: 'configure_session',
        sessionId: session.id,
        expectedVersion: session.version,
        config: value,
      });
      workspace.upsert(result.session);
    }
    setSettings(false);
  }
  async function applyRouting(routing: AgentRoutingConfig) {
    if (!session || session.messages.length)
      await createSession(session?.config ?? workspace.config, routing);
    else {
      const result = await sendCommand({
        type: 'configure_routing',
        sessionId: session.id,
        expectedVersion: session.version,
        routing,
      });
      workspace.upsert(result.session);
    }
    setRoutingSettings(false);
  }
  async function chooseLocalModel(profile: LocalProfile) {
    const config: ModelConfig = {
      ...workspace.config,
      provider: 'llama-server',
      model: profile.name,
      baseUrl: 'http://127.0.0.1:8080/v1',
      managedModelId: profile.id,
      managedModelVersion: profile.version,
      contextBudgetTokens: profile.settings.contextSize,
      maxTokens: Math.max(1, Math.min(1048576, Math.floor(profile.settings.contextSize * 0.2))),
      autoMaxTokens: true,
      cloudConsent: false,
      projectCloudConsent: false,
    };
    await createSession(config, { subagentsEnabled: false });
    workspace.setConfig(config);
    setModelManager(false);
  }
  async function applySkills(value: SkillSelectionSave) {
    const target = session ?? (await createSession());
    const result = await sendCommand({
      type: 'configure_skills',
      sessionId: target.id,
      expectedVersion: value.expectedVersion ?? target.version,
      skills: value.skills,
      skillCloudConsent: value.skillCloudConsent,
    });
    workspace.upsert(result.session);
    setSkillManager(false);
  }
  async function applyMcp(value: McpSelectionSave) {
    const target = session ?? (await createSession());
    const result = await sendCommand({
      type: 'configure_mcp',
      sessionId: target.id,
      expectedVersion: value.expectedVersion ?? target.version,
      mcp: value.mcp,
      mcpCloudConsent: value.mcpCloudConsent,
    });
    workspace.upsert(result.session);
    setMcpManager(false);
  }
  async function attachMcp(
    preview: McpContentPreview,
    consent: boolean,
    expectedVersion: number | undefined,
  ) {
    const target = session ?? (await createSession());
    const result = await sendCommand({
      type: 'attach_mcp_content',
      sessionId: target.id,
      expectedVersion: expectedVersion ?? target.version,
      previewId: preview.id,
      mcpCloudConsent: consent,
    });
    workspace.upsert(result.session);
    setMcpManager(false);
  }
  async function removeMcpAttachment(id: string, expectedVersion: number | undefined) {
    if (!session) return;
    const result = await sendCommand({
      type: 'remove_mcp_content',
      sessionId: session.id,
      expectedVersion: expectedVersion ?? session.version,
      attachmentId: id,
    });
    workspace.upsert(result.session);
    setMcpManager(false);
  }
  async function changeMode(value: AgentMode) {
    if (!session) {
      setNewMode(value);
      return;
    }
    setBusy(true);
    try {
      workspace.upsert(
        (
          await sendCommand({
            type: 'set_mode',
            sessionId: session.id,
            expectedVersion: session.version,
            mode: value,
          })
        ).session,
      );
    } catch (failure) {
      setError(messageError(failure));
    } finally {
      setBusy(false);
    }
  }
  const latestAssistant = session?.messages.filter((m) => m.role === 'assistant').at(-1);
  const latestUsage = latestAssistant?.usage;
  const compactionIsNewer =
    !!session?.contextCompaction &&
    (!session.run ||
      Date.parse(session.contextCompaction.createdAt) > Date.parse(session.run.startedAt));
  const contextBase = compactionIsNewer
    ? session!.contextCompaction!.compactedEstimateTokens
    : (latestUsage?.inputTokens ?? session?.run?.context?.inputEstimateTokens ?? 0);
  const generatedEstimate =
    !compactionIsNewer && latestAssistant && latestAssistant.id === session?.run?.messageId
      ? (latestUsage?.outputTokens ?? new TextEncoder().encode(latestAssistant.content).length)
      : 0;
  const contextUsed = Math.max(0, contextBase + generatedEstimate);
  const contextPercent = Math.min(
    100,
    Math.max(0, Math.round((contextUsed / Math.max(1, config.contextBudgetTokens)) * 100)),
  );
  return (
    <div
      className={`app ${light ? 'light' : ''} ${sidebarOpen ? '' : 'sidebar-closed'} ${planOpen ? '' : 'plan-closed'}`}
    >
      <aside className="sidebar" aria-label="대화 탐색">
        <div className="brand">
          <span className="brand-mark">
            <Logo />
          </span>
          <strong>Lodex</strong>
          <span className="version">0.1</span>
          <button
            className="icon-button collapse-sidebar"
            aria-label="사이드바 접기"
            onClick={() => setSidebarOpen(false)}
          >
            <Icon name="panel" size={18} />
          </button>
        </div>
        <button
          className="new-chat"
          onClick={() => {
            workspace.select(null);
            setText('');
            composer.current?.focus();
          }}
        >
          <Icon name="plus" size={18} />새 대화<span>⌘ / Ctrl N</span>
        </button>
        <div className="nav-caption">워크스페이스</div>
        <button
          className={`nav-item ${!project ? 'active' : ''}`}
          onClick={() => {
            workspace.selectProject(null);
            setText('');
            composer.current?.focus();
          }}
        >
          <Icon name="chat" size={18} />
          일반 대화
        </button>
        <button className="nav-item" onClick={() => setPlanOpen((value) => !value)}>
          <Icon name="goal" size={18} />
          작업 계획
        </button>
        <button className="nav-item" onClick={() => setModelManager(true)}>
          <Icon name="chip" size={18} />
          로컬 모델 관리
        </button>
        <button className="nav-item" onClick={() => setRoutingSettings(true)}>
          <Icon name="bolt" size={18} />
          역할별 모델{session?.routing?.subagentsEnabled ? ' · 서브에이전트' : ''}
        </button>
        <button className="nav-item" onClick={() => setSkillManager(true)}>
          <Icon name="bolt" size={18} />
          스킬{session?.skills?.length ? ` · ${session.skills.length}` : ''}
        </button>
        <button className="nav-item" onClick={() => setMcpManager(true)}>
          <Icon name="bolt" />
          MCP{session?.mcp?.length ? ` · ${session.mcp.length}` : ''}
        </button>
        <button className="nav-item" onClick={() => setTelegramSettings(true)}>
          <Icon name="chat" size={18} />
          Telegram
        </button>
        <button className="nav-item" onClick={() => setWorktreeManager(true)}>
          <Icon name="folder" size={18} />
          Worktree
        </button>
        <div className="history-caption">
          <span>프로젝트</span>
          <button
            className="icon-button"
            aria-label="프로젝트 추가"
            onClick={() => setProjectDialog(true)}
          >
            <Icon name="plus" size={16} />
          </button>
        </div>
        <div className="project-list">
          {workspace.projects.map((item) => (
            <button
              key={item.id}
              title={item.path}
              className={`nav-item ${project?.id === item.id ? 'active' : ''}`}
              onClick={() => {
                workspace.selectProject(item.id);
                setText('');
              }}
            >
              <Icon name="folder" size={17} />
              <span>{item.name}</span>
            </button>
          ))}
          {!workspace.projects.length && (
            <button className="project-empty" onClick={() => setProjectDialog(true)}>
              로컬 폴더 연결
            </button>
          )}
        </div>
        <ConversationHistory
          key={workspace.selectedProjectId ?? 'general'}
          sessions={visibleSessions}
          title={project ? project.name + ' 대화' : '최근 대화'}
          onSelect={(id) => {
            workspace.select(id);
            setText('');
          }}
          onDeleted={() => setText('')}
          onError={setError}
        />
        <div className="sidebar-bottom">
          <div className="local-card">
            <span className={`status-dot ${workspace.connected ? 'online' : ''}`} />
            <div>
              <strong>{workspace.connected ? '워크스페이스 준비됨' : '데몬에 연결하는 중'}</strong>
              <small>
                {nativeDesktop
                  ? '대화는 이 기기에 저장됩니다'
                  : '브라우저 UI 미리보기 · 임시 데이터'}
              </small>
            </div>
          </div>
          <button className="profile-button" onClick={() => setSettings(true)}>
            <span className="avatar">L</span>
            <span>
              <strong>내 워크스페이스</strong>
              <small>로컬 우선 · 개인 설정</small>
            </span>
            <Icon name="settings" size={18} />
          </button>
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <div className="topbar-left">
            {
              <button
                className={`icon-button ${sidebarOpen ? 'mobile-sidebar-toggle' : ''}`}
                aria-label={sidebarOpen ? '사이드바 닫기' : '사이드바 열기'}
                onClick={() => setSidebarOpen(!sidebarOpen)}
              >
                <Icon name="panel" />
              </button>
            }
            <button className="model-picker" onClick={() => setSettings(true)}>
              <span className="model-name">{config.model || '모델 연결'}</span>
              <Icon name="down" size={15} />
            </button>
          </div>
          <div className="topbar-right">
            <span className="mode-badge" title={project?.path}>
              {project
                ? project.name + ' · ' + (mode === 'plan' ? 'Plan' : 'Build')
                : '대화 · 계획 편집'}
            </span>
            <button
              className="activity-toggle"
              aria-pressed={showActivities}
              onClick={() => setShowActivities(!showActivities)}
            >
              {showActivities ? '활동 숨기기' : '활동 표시'}
            </button>
            <button
              className="icon-button"
              aria-label={light ? '어두운 테마' : '밝은 테마'}
              onClick={() => setLight(!light)}
            >
              <Icon name="moon" size={18} />
            </button>
            <button
              className={`icon-button ${planOpen ? 'is-active' : ''}`}
              aria-label="작업 계획 패널 열기/닫기"
              aria-expanded={planOpen}
              onClick={() => setPlanOpen(!planOpen)}
            >
              <Icon name="panel" size={19} />
            </button>
          </div>
        </header>
        {!nativeDesktop && (
          <div className="preview-banner">
            UI 미리보기입니다. 실제 모델 연결과 영구 저장은 데스크톱 앱에서 사용할 수 있습니다.
          </div>
        )}
        <div className={`conversation ${session?.messages.length ? 'has-messages' : ''}`}>
          {!session?.messages.length ? (
            <div className="welcome">
              <div className="welcome-logo">
                <Logo size={64} />
              </div>
              <div className="eyebrow">YOUR MODELS. YOUR WORKSPACE.</div>
              <h1>무엇을 만들어 볼까요?</h1>
              <p>
                생각을 정리하고, 목표를 세우고.
                <br />내 모델과 함께 시작하는 나만의 작업 공간.
              </p>
              <div className="suggestions">
                <button
                  onClick={() => {
                    setText('만들고 싶은 프로그램의 개발 단계를 함께 정리해 줘.');
                    composer.current?.focus();
                  }}
                >
                  <Icon name="chat" />
                  <strong>아이디어 구체화</strong>
                  <span>생각을 실행 가능한 단계로</span>
                </button>
                <button
                  onClick={() => {
                    setText('/goal ');
                    composer.current?.focus();
                  }}
                >
                  <Icon name="goal" />
                  <strong>지속 목표 실행</strong>
                  <span>/goal로 완료까지 진행</span>
                </button>
                <button onClick={() => setSettings(true)}>
                  <Icon name="chip" />
                  <strong>내 모델 연결</strong>
                  <span>로컬 서버 또는 OpenRouter</span>
                </button>
              </div>
              <span className="welcome-note">
                <Icon name="info" size={14} />
                {nativeDesktop
                  ? 'llama-server는 설정한 서버로, OpenRouter는 전송 동의 후 연결합니다.'
                  : '데모 화면에는 실제 모델 응답이나 성능 수치를 표시하지 않습니다.'}
              </span>
            </div>
          ) : (
            <div className="messages" aria-live="polite" aria-relevant="additions text">
              {session.messages.map((message) => (
                <article key={message.id} className={`message ${message.role}`}>
                  {showActivities && message.activities?.length ? (
                    <ActivityCards activities={message.activities} sessionId={session.id} />
                  ) : null}
                  {!showActivities &&
                    message.activities?.some(
                      (a) =>
                        (a.changes || a.edit) &&
                        !['applied', 'reverted', 'rejected'].includes(
                          (a.changes || a.edit)!.status,
                        ),
                    ) && (
                      <button className="review-reveal" onClick={() => setShowActivities(true)}>
                        파일 수정안 확인
                      </button>
                    )}
                  {!showActivities &&
                    message.activities?.some(
                      (a) =>
                        a.planProposal?.status === 'proposed' ||
                        a.execution?.cleanupPending ||
                        a.execution?.status === 'failed',
                    ) && (
                      <button className="review-reveal" onClick={() => setShowActivities(true)}>
                        계획 제안·명령 결과 확인
                      </button>
                    )}
                  <div className="message-body">
                    {(message.content ? <Markdown text={message.content} /> : null) ||
                      (message.status === 'streaming' ? (
                        <span className="thinking">
                          <i />
                          <i />
                          <i />
                        </span>
                      ) : (
                        '응답 내용이 없습니다.'
                      ))}
                  </div>
                  {message.error && (
                    <p className="message-error">
                      <Icon name="info" size={15} />
                      {message.error}
                    </p>
                  )}
                  {['cancelled', 'interrupted', 'failed'].includes(message.status) && (
                    <span className="message-status">
                      {message.status === 'cancelled'
                        ? '중지됨'
                        : message.status === 'interrupted'
                          ? '이전 실행이 중단됨'
                          : '응답 미완료'}
                    </span>
                  )}
                  {message.usage?.costUsd !== null && message.usage?.costUsd !== undefined && (
                    <span className="message-status">
                      제공자 보고 비용 ${message.usage.costUsd.toFixed(6)}
                    </span>
                  )}
                </article>
              ))}
              <div ref={end} />
            </div>
          )}
        </div>
        <div className="composer-area">
          {pendingApproval?.approval && (
            <div className="permission-banner" role="alertdialog" aria-label="작업 권한 요청">
              <div>
                <strong>
                  {pendingApproval.approval.kind === 'file'
                    ? '파일 변경 권한 요청'
                    : pendingApproval.approval.kind === 'command'
                      ? '명령 실행 권한 요청'
                      : 'MCP 작업 권한 요청'}
                </strong>
                <span>
                  {pendingApproval.approval.reason} ·{' '}
                  {pendingApproval.arguments || pendingApproval.label}
                </span>
              </div>
              <button disabled={busy} onClick={() => void decideApproval('reject')}>
                거절
              </button>
              <button
                className="permission-allow"
                disabled={busy || mode === 'plan'}
                onClick={() => void decideApproval('approve')}
              >
                수락
              </button>
            </div>
          )}
          {error && (
            <div className="error-banner" role="alert">
              <Icon name="info" size={17} />
              <span>{error}</span>
              <button
                className="icon-button"
                aria-label="오류 알림 닫기"
                onClick={() => setError('')}
              >
                <Icon name="close" size={15} />
              </button>
            </div>
          )}
          <form
            className="composer"
            onSubmit={(event) => {
              void submit(event);
            }}
          >
            <textarea
              ref={composer}
              aria-label="메시지"
              placeholder={project ? project.name + '에서 작업 요청하기' : '메시지 보내기'}
              value={text}
              rows={2}
              maxLength={64000}
              onChange={(event) => setText(event.target.value)}
              onKeyDown={(event) => {
                if (
                  event.key === 'Enter' &&
                  !event.shiftKey &&
                  !event.nativeEvent.isComposing &&
                  event.keyCode !== 229
                ) {
                  event.preventDefault();
                  void submit();
                }
              }}
            />
            <div className="composer-toolbar">
              <select
                className="mode-select"
                aria-label="에이전트 모드"
                title="Ctrl + . 로 전환"
                value={mode}
                disabled={busy || running || !workspace.connected}
                onChange={(event) => void changeMode(event.target.value as AgentMode)}
              >
                <option value="plan">Plan</option>
                <option value="build">Build</option>
              </select>
              <button type="button" className="provider-tag" onClick={() => setSettings(true)}>
                <Icon name={config.provider === 'openrouter' ? 'cloud' : 'chip'} size={15} />
                {providerName(config.provider)}
                <Icon name="down" size={12} />
              </button>
              <div className="permission-control">
                <button
                  type="button"
                  className={`autopilot-toggle permission-${permissionMode}`}
                  aria-label={`Autopilot 권한: ${permissionLabel[permissionMode]}`}
                  aria-haspopup="menu"
                  aria-expanded={permissionMenu}
                  disabled={!session || busy || running || !workspace.connected}
                  title="작업 승인 정책 선택"
                  onClick={() => setPermissionMenu((open) => !open)}
                >
                  <span className="status-dot" />
                  Autopilot · {permissionLabel[permissionMode]}
                  <Icon name="down" size={12} />
                </button>
                {permissionMenu && (
                  <div className="permission-menu" role="menu" aria-label="Autopilot 권한 단계">
                    {(['ask', 'auto', 'full'] as const).map((value) => (
                      <button
                        type="button"
                        role="menuitemradio"
                        aria-checked={permissionMode === value}
                        className={permissionMode === value ? 'selected' : ''}
                        key={value}
                        onClick={() => {
                          setPermissionMenu(false);
                          if (value === 'full' && permissionMode !== 'full')
                            setConfirmFullAccess(true);
                          else void changePermissionMode(value);
                        }}
                      >
                        <strong>{permissionLabel[value]}</strong>
                        <span>
                          {value === 'ask'
                            ? '변경과 외부 작업 전에 확인'
                            : value === 'auto'
                              ? '일반 작업은 자동, 위험 작업은 확인'
                              : '호스트와 네트워크를 추가 확인 없이 사용'}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
              {config.eco && (
                <span className="eco-tag">
                  <Icon name="leaf" size={14} />
                  Eco
                </span>
              )}
              <div className="composer-spacer" />
              <span className="composer-hint">Ctrl + . 모드 전환 · Shift + Enter 줄바꿈</span>
              {running ? (
                <button
                  type="button"
                  className="send-button stop-button"
                  aria-label="응답 중지"
                  disabled={busy}
                  onClick={() => {
                    void cancel();
                  }}
                >
                  <Icon name="stop" size={16} />
                </button>
              ) : (
                <button
                  type="submit"
                  className="send-button"
                  aria-label="메시지 보내기"
                  disabled={!text.trim() || busy || !workspace.connected}
                >
                  <Icon name="arrow" size={20} />
                </button>
              )}
            </div>
          </form>
          <div className="composer-footer">
            <span>
              {running
                ? '응답을 생성하는 중입니다.'
                : project
                  ? config.provider === 'openrouter' && !config.projectCloudConsent
                    ? '프로젝트 파일 전송이 꺼져 있습니다. 설정에서 허용할 수 있습니다.'
                    : mode === 'plan'
                      ? '파일을 읽고 계획을 제안합니다. 파일 변경은 Build에서 가능합니다.'
                      : permissionMode === 'ask'
                        ? '변경과 실행은 승인 후 진행합니다.'
                        : permissionMode === 'auto'
                          ? '일반 작업은 자동 승인하고 위험 작업은 확인합니다.'
                          : '전체 접근으로 호스트 파일·명령·네트워크를 사용할 수 있습니다.'
                  : '프로젝트를 연결하면 파일을 살펴보며 작업할 수 있습니다.'}
            </span>
            <div className="context-meter">
              <button
                type="button"
                className="context-meter-trigger"
                aria-label={`컨텍스트 사용량 ${contextPercent}%`}
                aria-haspopup="dialog"
              >
                <span className="context-meter-track" aria-hidden="true">
                  <span style={{ width: contextPercent + '%' }} />
                </span>
                컨텍스트 {contextPercent}%
              </button>
              <div className="context-popover" role="dialog" aria-label="컨텍스트 상세 정보">
                <strong>컨텍스트 사용량</strong>
                <dl>
                  <div>
                    <dt>현재 / 예산</dt>
                    <dd>
                      {contextUsed.toLocaleString()} / {config.contextBudgetTokens.toLocaleString()}
                    </dd>
                  </div>
                  <div>
                    <dt>토큰 생성 속도</dt>
                    <dd>
                      {latestUsage?.decodeTps
                        ? latestUsage.decodeTps.value.toFixed(1) + ' tok/s'
                        : '미측정'}
                    </dd>
                  </div>
                  <div>
                    <dt>프리필 속도</dt>
                    <dd>
                      {latestUsage?.prefillTps
                        ? latestUsage.prefillTps.value.toFixed(1) + ' tok/s'
                        : '미측정'}
                    </dd>
                  </div>
                  <div>
                    <dt>첫 토큰 지연</dt>
                    <dd>
                      {latestUsage?.ttftMs
                        ? (latestUsage.ttftMs.value / 1000).toFixed(2) + ' s'
                        : '미측정'}
                    </dd>
                  </div>
                </dl>
                <button
                  type="button"
                  className="compact-context-button"
                  disabled={
                    !session?.messages.some((message) => message.status === 'complete') ||
                    busy ||
                    running
                  }
                  onClick={() => void compactContext()}
                >
                  <Icon name="leaf" size={14} />
                  지금 컨텍스트 압축
                </button>
                {session?.contextCompaction && (
                  <small>
                    최근 압축: {session.contextCompaction.compactedMessageCount}개 메시지 ·{' '}
                    {session.contextCompaction.reason === 'eco'
                      ? 'ECO 자동'
                      : session.contextCompaction.reason === 'automatic'
                        ? '용량 초과 자동'
                        : '수동'}
                  </small>
                )}
              </div>
            </div>
          </div>
        </div>
      </main>

      {planOpen && (
        <aside className="plan-panel" aria-label="작업 계획과 할 일">
          <div className="plan-header">
            <Icon name="goal" size={19} />
            <strong>작업 계획</strong>
            <span className="small-badge">편집</span>
          </div>
          <PlanEditor
            key={session?.id ?? 'new'}
            session={session}
            ensureSession={createSession}
            onError={setError}
          />
          <div className="run-panel">
            {session?.projectId && <ExecutionPanel key={session.id} session={session} />}
            <div className="section-label">현재 실행</div>
            <div className="run-state">
              <span className={`status-dot ${running ? 'pulsing' : ''}`} />
              {running ? '모델 응답 생성 중' : '대기 중'}
            </div>
            <dl className="metrics-list">
              <div>
                <dt>생성 속도</dt>
                <dd>
                  {latestUsage?.decodeTps ? latestUsage.decodeTps.value.toFixed(1) + ' tok/s' : '—'}
                </dd>
              </div>
              <div>
                <dt>프리필 속도</dt>
                <dd>
                  {latestUsage?.prefillTps
                    ? latestUsage.prefillTps.value.toFixed(1) + ' tok/s'
                    : '—'}
                </dd>
              </div>
              <div>
                <dt>첫 토큰 지연</dt>
                <dd>
                  {latestUsage?.ttftMs ? (latestUsage.ttftMs.value / 1000).toFixed(2) + ' s' : '—'}
                </dd>
              </div>
              <div>
                <dt>출력 토큰</dt>
                <dd>{latestUsage?.outputTokens ?? '—'}</dd>
              </div>
              <div>
                <dt>비용</dt>
                <dd>
                  {latestUsage?.costUsd != null
                    ? '$' + latestUsage.costUsd.toFixed(6)
                    : config.provider === 'openrouter' && latestUsage
                      ? '확인 대기'
                      : '—'}
                </dd>
              </div>
            </dl>
            <p className="subtle-note">
              속도는 엔진 보고값, 첫 토큰 지연은 앱 측정값입니다. 제공되지 않은 수치는 추정하지
              않습니다.
            </p>
          </div>
          {session?.run?.context && (
            <details className="context-report">
              <summary>
                입력 구성 · 추정 {session.run.context.inputEstimateTokens.toLocaleString()} 토큰
              </summary>
              <dl className="metrics-list">
                <div>
                  <dt>앱 예산</dt>
                  <dd>{session.run.context.contextBudgetTokens.toLocaleString()}</dd>
                </div>
                <div>
                  <dt>출력 예약 / 여유</dt>
                  <dd>
                    {session.run.context.outputReserveTokens.toLocaleString()} /{' '}
                    {session.run.context.safetyReserveTokens.toLocaleString()}
                  </dd>
                </div>
                <div>
                  <dt>대화 이력</dt>
                  <dd>{session.run.context.historyMessageIds.length}개 메시지</dd>
                </div>
                <div>
                  <dt>미완료 응답 제외</dt>
                  <dd>{session.run.context.excludedMessageIds.length}개</dd>
                </div>
                <div>
                  <dt>저장한 계획·지침</dt>
                  <dd>{session.run.context.planIncluded ? '포함' : '제외'}</dd>
                </div>
              </dl>
              <p className="subtle-note">
                마지막 요청 기준입니다. UTF-8 바이트를 이용한 보수적 추정으로, 실제 토큰 수·엔진
                한도와 다를 수 있습니다. 완료된 대화는 생략하지 않습니다.
              </p>
            </details>
          )}
          {session && (session.projectId || session.autopilot) && (
            <AutopilotPanel key={session.id} session={session} />
          )}
        </aside>
      )}
      {confirmFullAccess && (
        <FullAccessDialog
          onClose={() => setConfirmFullAccess(false)}
          onConfirm={() => {
            setConfirmFullAccess(false);
            void changePermissionMode('full');
          }}
        />
      )}
      {modelManager && (
        <Suspense fallback={<div role="status">모델 관리 화면을 여는 중…</div>}>
          <ModelManager onClose={() => setModelManager(false)} onChoose={chooseLocalModel} />
        </Suspense>
      )}
      {skillManager && (
        <Suspense fallback={<div role="status">스킬 관리 화면을 여는 중…</div>}>
          <SkillManager
            key={session?.id ?? 'new'}
            session={session}
            provider={contextProvider}
            connected={workspace.connected}
            onClose={() => setSkillManager(false)}
            onSave={applySkills}
          />
        </Suspense>
      )}
      {mcpManager && (
        <Suspense fallback={null}>
          <McpManager
            session={session}
            provider={contextProvider}
            connected={workspace.connected}
            onClose={() => setMcpManager(false)}
            onSave={applyMcp}
            onAttach={attachMcp}
            onRemoveAttachment={removeMcpAttachment}
          />
        </Suspense>
      )}
      {projectDialog && (
        <ProjectDialog
          onClose={() => setProjectDialog(false)}
          onAdded={(project) => {
            workspace.upsertProject(project);
            workspace.selectProject(project.id);
            setText('');
            setProjectDialog(false);
          }}
        />
      )}
      {settings && (
        <Settings
          config={session?.config ?? workspace.config}
          hasMessages={!!session?.messages.length}
          running={!!running}
          onClose={() => setSettings(false)}
          onSave={applyConfig}
        />
      )}
      {routingSettings && (
        <Suspense fallback={null}>
          <RoutingSettings
            base={session?.config ?? workspace.config}
            routing={session?.routing}
            hasMessages={!!session?.messages.length}
            running={!!running}
            onClose={() => setRoutingSettings(false)}
            onSave={applyRouting}
          />
        </Suspense>
      )}
      {telegramSettings && (
        <Suspense fallback={null}>
          <TelegramSettings
            sessions={workspace.sessions}
            selectedId={session?.id ?? null}
            onClose={() => setTelegramSettings(false)}
          />
        </Suspense>
      )}
      {worktreeManager && (
        <Suspense fallback={null}>
          <WorktreeManager
            projects={workspace.projects}
            selectedId={workspace.selectedProjectId}
            onClose={() => setWorktreeManager(false)}
            onOpen={(project) => {
              workspace.upsertProject(project);
              workspace.selectProject(project.id);
              setText('');
              setWorktreeManager(false);
            }}
          />
        </Suspense>
      )}
    </div>
  );
}

export function FullAccessDialog({
  onClose,
  onConfirm,
}: {
  onClose: () => void;
  onConfirm: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  return (
    <dialog
      ref={dialog}
      className="delete-dialog full-access-dialog"
      aria-labelledby="full-access-title"
      onCancel={onClose}
      onClick={(event) => {
        if (event.target === dialog.current) onClose();
      }}
    >
      <h2 id="full-access-title">전체 접근을 사용하시겠어요?</h2>
      <p>이 대화의 모델과 도구에 다음 권한을 추가 승인 없이 허용합니다.</p>
      <ul>
        <li>프로젝트 밖의 파일을 읽고 수정할 수 있습니다.</li>
        <li>호스트 명령과 네트워크를 제한 없이 사용할 수 있습니다.</li>
        <li>.env, SSH 키, 인증 파일을 읽을 수 있습니다.</li>
        <li>OpenRouter 사용 시 파일 내용이나 명령 출력이 전송될 수 있습니다.</li>
        <li>Telegram에서도 원격 전체 접근 작업을 실행할 수 있습니다.</li>
      </ul>
      <div className="dialog-actions">
        <button type="button" onClick={onClose}>
          취소
        </button>
        <button type="button" className="danger-button" onClick={onConfirm}>
          전체 접근 사용
        </button>
      </div>
    </dialog>
  );
}

function PlanEditor({
  session,
  ensureSession,
  onError,
}: {
  session: Session | undefined;
  ensureSession: () => Promise<Session>;
  onError: (error: string) => void;
}) {
  const [draft, setDraft] = useState<Plan>(session?.plan ?? defaultPlan());
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [taskTitle, setTaskTitle] = useState('');
  const addingTask = useRef(false);
  const connected = useWorkspace((state) => state.connected);
  const storedPlan = JSON.stringify(session?.plan ?? defaultPlan());
  const editBase = useRef(storedPlan);
  useEffect(() => {
    if (!dirty) {
      setDraft(JSON.parse(storedPlan) as Plan);
      editBase.current = storedPlan;
    }
  }, [storedPlan, dirty]);
  const completed = draft.tasks.filter((task) => task.done).length;
  const update = (value: Plan | ((current: Plan) => Plan)) => {
    setDraft((current) => (typeof value === 'function' ? value(current) : value));
    setDirty(true);
  };
  async function save() {
    setSaving(true);
    try {
      if (storedPlan !== editBase.current)
        throw new Error(
          '편집 중 저장된 계획이 변경되었습니다. 저장된 계획을 불러온 뒤 다시 편집하세요.',
        );
      const cleaned = normalizePlanDraft(draft);
      if (JSON.stringify(cleaned) !== JSON.stringify(draft)) setDraft(cleaned);
      const target = session ?? (await ensureSession());
      const result = await sendCommand({
        type: 'save_plan',
        sessionId: target.id,
        expectedVersion: target.version,
        plan: cleaned,
      });
      useWorkspace.getState().upsert(result.session);
      setDirty(false);
    } catch (failure) {
      onError(messageError(failure));
    } finally {
      setSaving(false);
    }
  }
  function addTask(event: FormEvent) {
    event.preventDefault();
    const title = taskTitle.trim();
    if (!title || addingTask.current) return;
    addingTask.current = true;
    update((current) => appendPlanTask(current, title, crypto.randomUUID()));
    setTaskTitle('');
  }
  useEffect(() => {
    if (!taskTitle) addingTask.current = false;
  }, [taskTitle]);
  return (
    <div className="plan-editor">
      <label className="section-label" htmlFor="goal">
        계획 목표
      </label>
      <textarea
        id="goal"
        className="goal-input"
        rows={3}
        maxLength={4000}
        placeholder="이번 작업에서 이루고 싶은 목표를 적어 보세요."
        value={draft.goal}
        onChange={(event) => update({ ...draft, goal: event.target.value })}
      />
      <label className="section-label" htmlFor="plan-instructions">
        고정 지침
      </label>
      <textarea
        id="plan-instructions"
        className="goal-input"
        rows={2}
        maxLength={4000}
        placeholder="계속 지킬 제약과 완료 기준을 적어 주세요."
        value={draft.instructions}
        onChange={(event) => update({ ...draft, instructions: event.target.value })}
      />
      <label className="section-label" htmlFor="goal-criteria">
        목표 완료 기준
      </label>
      <textarea
        id="goal-criteria"
        className="goal-input"
        rows={2}
        maxLength={4000}
        value={draft.criteria ?? ''}
        placeholder="어떤 결과로 완료를 확인할까요?"
        onChange={(event) => update({ ...draft, criteria: event.target.value })}
      />
      <label className="section-label" htmlFor="goal-verification">
        최종 검증 명령
      </label>
      <textarea
        id="goal-verification"
        className="goal-input"
        rows={2}
        maxLength={8000}
        value={draft.verificationCommand ?? ''}
        placeholder="예: npm test"
        onChange={(event) => update({ ...draft, verificationCommand: event.target.value })}
      />
      <label className="check-field plan-context-choice">
        <input
          type="checkbox"
          checked={draft.includeInContext}
          onChange={(event) => update({ ...draft, includeInContext: event.target.checked })}
        />
        <span>저장한 목표·할 일·고정 지침을 다음 모델 요청에 포함</span>
      </label>
      <p className="subtle-note">
        OpenRouter 대화에서는 포함한 내용이 외부 제공자에게 전송됩니다. 저장한 변경은 다음 요청부터
        적용됩니다.
      </p>
      <div className="task-heading">
        <span className="section-label">할 일</span>
        <span>
          {completed} / {draft.tasks.length}
        </span>
      </div>
      <div className="progress-track">
        <div
          style={{
            width: draft.tasks.length ? (completed / draft.tasks.length) * 100 + '%' : '0%',
          }}
        />
      </div>
      <div className="task-list">
        {draft.tasks.length === 0 ? (
          <div className="empty-tasks">
            <Icon name="check" size={22} />
            <p>
              큰 목표를 작은 단계로
              <br />
              나누어 보세요.
            </p>
          </div>
        ) : (
          draft.tasks.map((task, index) => (
            <div key={task.id}>
              <div className={`task-row ${task.done ? 'done' : ''}`}>
                <input
                  type="checkbox"
                  aria-label={task.title + ' 완료'}
                  checked={task.done}
                  onChange={(event) =>
                    update((current) => ({
                      ...current,
                      tasks: current.tasks.map((item) =>
                        item.id === task.id ? { ...item, done: event.target.checked } : item,
                      ),
                    }))
                  }
                />
                <input
                  className="task-title"
                  aria-label="할 일 제목"
                  value={task.title}
                  maxLength={500}
                  onChange={(event) =>
                    update((current) => ({
                      ...current,
                      tasks: current.tasks.map((item) =>
                        item.id === task.id ? { ...item, title: event.target.value } : item,
                      ),
                    }))
                  }
                  onBlur={() => {
                    const title = task.title.trim();
                    if (title && title === task.title) return;
                    update((current) =>
                      title
                        ? {
                            ...current,
                            tasks: current.tasks.map((item) =>
                              item.id === task.id ? { ...item, title } : item,
                            ),
                          }
                        : removePlanTask(current, task.id),
                    );
                  }}
                  placeholder="할 일 제목"
                />
                <button
                  type="button"
                  className="icon-button"
                  aria-label={task.title + ' 삭제'}
                  onClick={() => update((current) => removePlanTask(current, task.id))}
                >
                  <Icon name="close" size={13} />
                </button>
              </div>
              <details className="task-details">
                <summary>완료 기준·선행 작업·순서</summary>
                <label>
                  작업 검증 명령
                  <textarea
                    className="goal-input"
                    rows={2}
                    maxLength={8000}
                    aria-label={task.title + ' 검증 명령'}
                    placeholder="예: npm test -- --run regression"
                    value={task.verificationCommand ?? ''}
                    onChange={(event) =>
                      update((current) => ({
                        ...current,
                        tasks: current.tasks.map((item) =>
                          item.id === task.id
                            ? { ...item, verificationCommand: event.target.value }
                            : item,
                        ),
                      }))
                    }
                  />
                </label>
                <textarea
                  aria-label={task.title + ' 완료 기준'}
                  className="goal-input"
                  rows={2}
                  maxLength={2000}
                  value={task.criteria ?? ''}
                  onChange={(event) =>
                    update((current) => ({
                      ...current,
                      tasks: current.tasks.map((item) =>
                        item.id === task.id ? { ...item, criteria: event.target.value } : item,
                      ),
                    }))
                  }
                />
                {draft.tasks
                  .filter((item) => item.id !== task.id)
                  .map((item) => (
                    <label className="check-field" key={item.id}>
                      <input
                        type="checkbox"
                        checked={task.dependsOn?.includes(item.id) ?? false}
                        onChange={(event) =>
                          update((current) => ({
                            ...current,
                            tasks: current.tasks.map((t) =>
                              t.id === task.id
                                ? {
                                    ...t,
                                    dependsOn: event.target.checked
                                      ? [...(t.dependsOn ?? []), item.id]
                                      : t.dependsOn?.filter((id) => id !== item.id),
                                  }
                                : t,
                            ),
                          }))
                        }
                      />
                      {item.title}
                    </label>
                  ))}
                <div className="edit-actions">
                  {[-1, 1].map((direction) => (
                    <button
                      type="button"
                      key={direction}
                      disabled={index + direction < 0 || index + direction >= draft.tasks.length}
                      onClick={() => {
                        update((current) => {
                          const currentIndex = current.tasks.findIndex(
                            (item) => item.id === task.id,
                          );
                          const destination = currentIndex + direction;
                          if (
                            currentIndex < 0 ||
                            destination < 0 ||
                            destination >= current.tasks.length
                          )
                            return current;
                          const tasks = [...current.tasks];
                          [tasks[currentIndex], tasks[destination]] = [
                            tasks[destination]!,
                            tasks[currentIndex]!,
                          ];
                          return { ...current, tasks };
                        });
                      }}
                    >
                      {direction === -1 ? '위로' : '아래로'}
                    </button>
                  ))}
                </div>
              </details>
            </div>
          ))
        )}
      </div>
      <form className="add-task" onSubmit={addTask}>
        <Icon name="plus" size={15} />
        <input
          aria-label="새 할 일"
          placeholder="할 일 추가"
          maxLength={500}
          value={taskTitle}
          onChange={(event) => setTaskTitle(event.target.value)}
        />
        <button
          type="submit"
          aria-label="할 일 추가"
          disabled={!taskTitle.trim() || draft.tasks.length >= 100}
        >
          <Icon name="arrow" size={14} />
        </button>
      </form>
      <button
        className="save-plan"
        disabled={!dirty || saving || !connected}
        onClick={() => {
          void save();
        }}
      >
        {saving ? '저장 중…' : dirty ? '계획 저장' : '저장됨'}
      </button>
      <p className="subtle-note">
        체크박스는 직접 관리합니다. Autopilot 검증 기록은 별도로 표시됩니다. 검증 명령은 사용자가
        정한 확인 범위만 검사합니다.
      </p>
      {dirty && (
        <button
          className="save-plan"
          onClick={() => {
            setDraft(JSON.parse(storedPlan) as Plan);
            setDirty(false);
          }}
        >
          저장된 계획 불러오기
        </button>
      )}
    </div>
  );
}

function Settings({
  config,
  hasMessages,
  running,
  onClose,
  onSave,
}: {
  config: ModelConfig;
  hasMessages: boolean;
  running: boolean;
  onClose: () => void;
  onSave: (config: ModelConfig) => Promise<void>;
}) {
  const [draft, setDraft] = useState(config);
  const [key, setKey] = useState('');
  const [catalog, setCatalog] = useState<ModelDescriptor[]>([]);
  const [catalogProvider, setCatalogProvider] = useState<string>('');
  const [status, setStatus] = useState('');
  const [failure, setFailure] = useState('');
  const [busy, setBusy] = useState(false);
  const configured = useWorkspace((s) => s.openrouterConfigured);
  const keySource = useWorkspace((s) => s.openrouterKeySource);
  const envFilePath = useWorkspace((s) => s.envFilePath);
  const envManaged = keySource === 'env_file' || keySource === 'environment';
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  async function operation(work: () => Promise<void>) {
    setBusy(true);
    setFailure('');
    setStatus('');
    try {
      await work();
    } catch (error) {
      setFailure(messageError(error));
    } finally {
      setBusy(false);
    }
  }
  const automaticOutputTokens = (context: number, descriptor?: ModelDescriptor) =>
    Math.max(
      1,
      Math.min(
        Math.floor(context * 0.2),
        descriptor?.maxCompletionTokens ?? Number.POSITIVE_INFINITY,
        1048576,
      ),
    );
  function chooseDescriptor(descriptor: ModelDescriptor) {
    const context = Math.min(descriptor.contextLength ?? draft.contextBudgetTokens, 2097152);
    setDraft((value) => ({
      ...value,
      model: descriptor.id,
      contextBudgetTokens: context,
      temperature: descriptor.defaultTemperature ?? 0.7,
      topP: descriptor.defaultTopP ?? 0.95,
      maxTokens: value.autoMaxTokens
        ? automaticOutputTokens(context, descriptor)
        : Math.min(value.maxTokens, descriptor.maxCompletionTokens ?? 1048576),
    }));
    setStatus(
      `${descriptor.name} 기본 설정 · 컨텍스트 ${context.toLocaleString()} 토큰을 적용했습니다.`,
    );
  }
  useEffect(() => {
    if (
      draft.provider !== 'openrouter' ||
      !configured ||
      !nativeDesktop ||
      catalogProvider === 'openrouter'
    )
      return;
    setCatalogProvider('openrouter');
    void models('openrouter', draft.baseUrl)
      .then((result) => {
        setCatalog(result);
        const selected = result.find((item) => item.id === draft.model);
        if (selected) chooseDescriptor(selected);
      })
      .catch((failure) => {
        setCatalogProvider('');
        setFailure(messageError(failure));
      });
  }, [catalogProvider, configured, draft.provider]);
  return (
    <dialog
      className="settings-dialog"
      ref={dialog}
      onCancel={onClose}
      onClick={(event) => {
        if (event.target === dialog.current) onClose();
      }}
    >
      <div className="dialog-inner">
        <div className="dialog-header">
          <div>
            <div className="eyebrow">WORKSPACE SETTINGS</div>
            <h2>모델 연결과 생성 설정</h2>
          </div>
          <button className="icon-button" aria-label="설정 닫기" onClick={onClose}>
            <Icon name="close" />
          </button>
        </div>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void operation(async () => {
              const parsed = modelConfigSchema.safeParse(draft);
              if (!parsed.success)
                throw new Error(parsed.error.issues.map((issue) => issue.message).join('\n'));
              await onSave(parsed.data);
            });
          }}
        >
          <div className="settings-body">
            <div className="provider-options">
              {(['llama-server', 'openrouter', 'demo'] as const).map((provider) => (
                <button
                  type="button"
                  key={provider}
                  className={!draft.managedModelId && draft.provider === provider ? 'chosen' : ''}
                  onClick={() => {
                    const {
                      managedModelId: _id,
                      managedModelVersion: _version,
                      ...externalConfig
                    } = draft;
                    setDraft({
                      ...externalConfig,
                      provider,
                      model: provider === 'demo' ? 'demo' : '',
                      cloudConsent: false,
                      projectCloudConsent: false,
                    });
                    setCatalog([]);
                    setCatalogProvider('');
                  }}
                >
                  <Icon
                    name={
                      provider === 'openrouter' ? 'cloud' : provider === 'demo' ? 'chat' : 'chip'
                    }
                  />
                  <span>
                    {provider === 'llama-server' && draft.managedModelId
                      ? '외부 llama-server'
                      : providerName(provider)}
                  </span>
                </button>
              ))}
            </div>
            {draft.provider === 'llama-server' && !draft.managedModelId && (
              <label className="field">
                서버 API 주소
                <input
                  value={draft.baseUrl}
                  onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })}
                  placeholder="http://127.0.0.1:8080/v1"
                />
                <small>
                  localhost·사설 IP·Tailscale IP/MagicDNS를 지원합니다. 예:
                  http://100.64.1.2:8080/v1 또는 https://gpu.tailnet.ts.net/v1. 서버를 Tailscale
                  IP에 바인딩했다면 같은 IP를 입력하세요. 0.0.0.0은 접속 주소가 아닙니다. 대화와
                  프로젝트 도구 결과는 선택한 서버로 전달됩니다.
                </small>
              </label>
            )}
            {draft.provider === 'openrouter' && (
              <div className="key-section">
                <label className="field">
                  OpenRouter API 키{' '}
                  <span className={configured ? 'key-ok' : ''}>
                    {configured
                      ? keySource === 'env_file'
                        ? '.env에서 불러옴'
                        : keySource === 'environment'
                          ? '환경 변수에서 불러옴'
                          : 'OS 저장소에 연결됨'
                      : '등록 필요'}
                  </span>
                  <div className="input-action">
                    <input
                      type="password"
                      aria-label="OpenRouter API 키"
                      disabled={envManaged}
                      autoComplete="off"
                      spellCheck={false}
                      value={key}
                      placeholder={configured ? '새 키로 교체' : 'sk-or-…'}
                      onChange={(event) => setKey(event.target.value)}
                    />
                    <button
                      type="button"
                      disabled={!nativeDesktop || !key.trim() || busy || envManaged}
                      onClick={() => {
                        void operation(async () => {
                          await saveKey(key.trim());
                          setKey('');
                          useWorkspace.getState().setKeyConfigured(true);
                          setStatus('키를 OS 키 저장소에 저장했습니다.');
                        });
                      }}
                    >
                      키 저장
                    </button>
                    {configured && (
                      <button
                        type="button"
                        disabled={busy || envManaged}
                        onClick={() => {
                          void operation(async () => {
                            await saveKey(null);
                            useWorkspace.getState().setKeyConfigured(false);
                            setStatus('키를 제거했습니다.');
                          });
                        }}
                      >
                        제거
                      </button>
                    )}
                  </div>
                  <small>키는 화면의 영구 저장소·대화 DB에 기록하지 않습니다.</small>
                  <small>
                    OPENROUTER_API_KEY를 .env에 설정하고 앱을 다시 시작해도 연결할 수 있습니다.
                    우선순위: 환경 변수 → .env → OS 저장소.
                  </small>
                  {envFilePath && <small className="env-file-path">.env 경로: {envFilePath}</small>}
                  {envManaged && (
                    <small>
                      현재 키는 해당 파일 또는 환경 변수에서 변경·제거한 뒤 앱을 다시 시작하세요.
                    </small>
                  )}
                </label>
                <label className="check-field">
                  <input
                    type="checkbox"
                    checked={draft.cloudConsent}
                    onChange={(event) => setDraft({ ...draft, cloudConsent: event.target.checked })}
                  />
                  <span>
                    이 대화와 앱 지시문을 OpenRouter 및 선택된 모델 제공자에게 전송하는 데
                    동의합니다. 사용량에 따라 비용이 발생합니다.
                  </span>
                </label>
                <label className="check-field">
                  <input
                    type="checkbox"
                    checked={draft.projectCloudConsent}
                    onChange={(event) =>
                      setDraft({ ...draft, projectCloudConsent: event.target.checked })
                    }
                  />
                  <span>
                    이 대화에서 프로젝트 파일 목록·읽기·검색을 허용하고, 도구가 읽은 파일 내용과
                    상대 경로를 OpenRouter 및 모델 제공자에게 전송합니다.
                  </span>
                </label>
                <p className="subtle-note">
                  제공자 자동 대체와 데이터 수집 허용은 꺼져 있습니다. Autopilot은 실행 전에 비용을
                  예약하고 OpenRouter가 보고한 실제 비용을 기록합니다.
                </p>
              </div>
            )}
            {draft.managedModelId ? (
              <div className="demo-notice">
                <strong>{draft.model}</strong>
                <p>
                  로컬 모델 관리에서 등록한 설정 v{draft.managedModelVersion}을 사용합니다. 서버
                  주소와 모델 ID는 로딩할 때 자동으로 연결됩니다. 엔진·모델 파일·컨텍스트 길이는
                  로컬 모델 관리에서 변경하세요.
                </p>
              </div>
            ) : draft.provider !== 'demo' ? (
              <label className="field">
                모델 ID
                <div className="input-action">
                  <input
                    aria-label="모델 ID"
                    list="model-catalog"
                    value={draft.model}
                    onChange={(event) => {
                      const model = event.target.value;
                      const descriptor = catalog.find((item) => item.id === model);
                      if (draft.provider === 'openrouter' && descriptor)
                        chooseDescriptor(descriptor);
                      else setDraft({ ...draft, model });
                    }}
                    placeholder={
                      draft.provider === 'openrouter'
                        ? '목록에서 선택하거나 정확한 모델 ID 입력'
                        : '서버에 로드한 모델 ID'
                    }
                  />
                  <button
                    type="button"
                    disabled={busy || !nativeDesktop}
                    onClick={() => {
                      void operation(async () => {
                        const result = await models(draft.provider, draft.baseUrl);
                        setCatalog(result);
                        setCatalogProvider(draft.provider);
                        if (result.length === 1 && result[0]) chooseDescriptor(result[0]);
                        setStatus(result.length + '개 모델을 불러왔습니다.');
                      });
                    }}
                  >
                    목록 조회
                  </button>
                </div>
                <datalist id="model-catalog">
                  {catalog.map((model) => (
                    <option
                      value={model.id}
                      key={model.id}
                      label={`${model.name}${model.tools === false ? ' · 도구 미지원' : model.tools ? ' · 도구 지원' : ''}`}
                    >
                      {model.name}
                    </option>
                  ))}
                </datalist>
                {draft.provider === 'openrouter' && catalog.length > 0 && draft.model && (
                  <small>
                    {catalog.find((model) => model.id === draft.model)?.tools === false
                      ? '이 모델은 도구 호출을 지원하지 않습니다. 프로젝트 도구를 쓰는 Build 작업에는 도구 지원 모델을 선택하세요.'
                      : !catalog.some((model) => model.id === draft.model)
                        ? '현재 목록에 없는 ID입니다. OpenRouter 모델 ID를 다시 확인하세요.'
                        : '목록에 있는 모델 ID입니다. 도구 지원 여부는 모델별로 다릅니다.'}
                  </small>
                )}
              </label>
            ) : (
              <div className="demo-notice">
                <Icon name="info" size={17} />
                UI와 저장·중지 흐름을 확인하는 고정 응답입니다. 실제 LLM을 호출하지 않습니다.
              </div>
            )}
            <div className="settings-grid">
              <div
                className={`field${draft.useDefaultTemperature ? ' generation-value-disabled' : ''}`}
              >
                <label htmlFor="temperature-setting">Temperature</label>
                <input
                  id="temperature-setting"
                  aria-label="Temperature"
                  type="number"
                  min="0"
                  max="2"
                  step="0.05"
                  value={draft.temperature}
                  disabled={draft.useDefaultTemperature}
                  onChange={(event) =>
                    setDraft({ ...draft, temperature: Number(event.target.value) })
                  }
                />
                <label className="check-field generation-default">
                  <input
                    type="checkbox"
                    checked={draft.useDefaultTemperature}
                    onChange={(event) =>
                      setDraft({ ...draft, useDefaultTemperature: event.target.checked })
                    }
                  />
                  기본값 사용
                </label>
              </div>
              <div className={`field${draft.useDefaultTopP ? ' generation-value-disabled' : ''}`}>
                <label htmlFor="top-p-setting">Top P</label>
                <input
                  id="top-p-setting"
                  aria-label="Top P"
                  type="number"
                  min="0.01"
                  max="1"
                  step="0.01"
                  value={draft.topP}
                  disabled={draft.useDefaultTopP}
                  onChange={(event) => setDraft({ ...draft, topP: Number(event.target.value) })}
                />
                <label className="check-field generation-default">
                  <input
                    type="checkbox"
                    checked={draft.useDefaultTopP}
                    onChange={(event) =>
                      setDraft({ ...draft, useDefaultTopP: event.target.checked })
                    }
                  />
                  기본값 사용
                </label>
              </div>
              <div className={`field${draft.autoMaxTokens ? ' generation-value-disabled' : ''}`}>
                <label htmlFor="max-output-token-setting">호출당 최대 출력 토큰</label>
                <input
                  id="max-output-token-setting"
                  aria-label="최대 출력 토큰"
                  type="number"
                  min="1"
                  max="1048576"
                  step="1"
                  value={draft.maxTokens}
                  disabled={draft.autoMaxTokens}
                  onChange={(event) =>
                    setDraft({ ...draft, maxTokens: Number(event.target.value) })
                  }
                />
              </div>
            </div>
            <label className="check-field auto-token-setting">
              <input
                type="checkbox"
                checked={draft.autoMaxTokens}
                onChange={(event) => {
                  const automatic = event.target.checked;
                  const descriptor = catalog.find((item) => item.id === draft.model);
                  setDraft({
                    ...draft,
                    autoMaxTokens: automatic,
                    maxTokens: automatic
                      ? automaticOutputTokens(draft.contextBudgetTokens, descriptor)
                      : draft.maxTokens,
                  });
                }}
              />
              <span>
                출력 토큰 자동 선택 · 앱 컨텍스트 예산의 20%를 출력에 예약하고 80%를 입력에
                사용합니다.
              </span>
            </label>
            <label className="field">
              앱 컨텍스트 예산 (토큰)
              <input
                type="number"
                min="1024"
                max="2097152"
                step="1"
                value={draft.contextBudgetTokens}
                onChange={(event) => {
                  const contextBudgetTokens = Number(event.target.value);
                  const descriptor = catalog.find((item) => item.id === draft.model);
                  setDraft({
                    ...draft,
                    contextBudgetTokens,
                    maxTokens: draft.autoMaxTokens
                      ? automaticOutputTokens(contextBudgetTokens, descriptor)
                      : draft.maxTokens,
                  });
                }}
              />
              <small>
                {draft.autoMaxTokens
                  ? `입력 ${Math.max(0, draft.contextBudgetTokens - draft.maxTokens).toLocaleString()} · 출력 ${draft.maxTokens.toLocaleString()} 토큰으로 자동 배분합니다.`
                  : '입력 추정량 + 최대 출력 + 여유분을 검사합니다. 엔진의 컨텍스트 길이를 바꾸지는 않습니다.'}
              </small>
            </label>
            <label className="eco-setting">
              <div>
                <span>
                  <Icon name="leaf" size={18} />
                  <strong>Eco</strong>
                </span>
                <p>
                  반복과 군더더기를 줄이도록 모델에 요청합니다.
                  <br />
                  오래된 대화는 압축하고 큰 도구 결과는 필요할 때만 다시 불러옵니다.
                </p>
              </div>
              <input
                type="checkbox"
                aria-label="Eco 모드"
                checked={draft.eco}
                onChange={(event) => setDraft({ ...draft, eco: event.target.checked })}
              />
            </label>
            {!nativeDesktop && (
              <p className="subtle-note">
                브라우저에서는 데모 미리보기만 동작합니다. 실제 연결 설정은 데스크톱 앱에서
                적용하세요.
              </p>
            )}
            {failure && (
              <p className="form-error" role="alert">
                {failure}
              </p>
            )}
            {status && (
              <p className="form-success" role="status">
                {status}
              </p>
            )}
          </div>
          <div className="dialog-footer">
            <span>
              {hasMessages
                ? '기존 대화의 설정은 유지하고 새 대화를 만듭니다.'
                : '이 설정은 새 대화에 적용됩니다.'}
            </span>
            <button
              type="submit"
              className="primary-button"
              disabled={busy || running || (!nativeDesktop && draft.provider !== 'demo')}
            >
              {busy ? '처리 중…' : hasMessages ? '새 대화로 적용' : '설정 적용'}
            </button>
          </div>
        </form>
      </div>
    </dialog>
  );
}
