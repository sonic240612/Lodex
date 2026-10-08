import { t as localize, useLocale } from './i18n';
import {
  useEffect,
  useRef,
  useState,
  lazy,
  Suspense,
  type FormEvent,
  type CSSProperties,
} from 'react';
import { AnimatePresence } from 'motion/react';
import type { RegisteredSkill } from '@lodex/skills';
import {
  modelConfigSchema,
  providerLabel,
  defaultProviderBaseUrl,
  isLocalProvider,
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
  type ElicitationValue,
} from '@lodex/contracts';
import {
  approvalAction,
  elicitationAction,
  nativeDesktop,
  saveKey,
  sendCommand,
  snapshot,
  subscribe,
  openMcpLogin,
  registeredSkills,
} from './bridge';
import { Icon, Logo } from './icons';
import { useWorkspace } from './state';
import { AssistantMessage } from './AssistantMessage';
import { loadLastModelConfig } from './model-preference';
import { loadDesignPreference, saveDesignPreference } from './design-preference';
import { useLiquidGlassEffects } from './useLiquidGlassEffects';
import { useGlassRefraction } from './useGlassRefraction';
import { useGlassMotionPreference } from './glass-motion-preference';
import { GlassEffectsSettings } from './GlassEffectsSettings';
import { GlassRoot, GlassPanel, GlassPopover, useGlassPanelLayout } from './GlassMotion';
import {
  submitComposerDraft,
  composerDraftKey,
  updateComposerDraft,
  moveComposerDraft,
  type ComposerDrafts,
  type DraftUpdate,
} from './composer-submit';
import { automaticOutputTokens, selectCatalogModel } from './model-catalog';
import { useModelCatalog } from './useModelCatalog';
import { OpenRouterAccount } from './OpenRouterAccount';
import { ProjectDialog } from './ProjectDialog';
import { Markdown } from './Markdown';
import { ConversationHistory } from './ConversationHistory';
import { SettingsScreen, type SettingsSectionId } from './SettingsScreen';
import { SettingsSurface } from './SettingsSurface';
import { SlashMenu } from './SlashMenu';
import { CompactionSummary } from './CompactionSummary';
import { CommandJobsPanel } from './CommandJobsPanel';
import { TaskListPanel } from './TaskListPanel';
import {
  availableSlashCommands,
  suggestSlashCommands,
  moveSlashSelection,
  parseComposerInput,
  composerRequestMode,
  type SlashCommand,
} from './slash-commands';
import { McpElicitationBanner } from './McpElicitationBanner';
import { ApprovalBanner } from './ApprovalBanner';
import { ExecutionPanel } from './ExecutionPanel';
import { AutopilotPanel } from './AutopilotPanel';
import { ArtifactChecksEditor } from './ArtifactChecksEditor';
import { appendPlanTask, normalizePlanDraft, removePlanTask } from './plan-draft';
import {
  goalExecutionCommand,
  loadGoalExecutionMode,
  saveGoalExecutionMode,
  type GoalExecutionMode,
  type GoalLimits,
} from './goal-execution';
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
const DataManager = lazy(() =>
  import('./DataManager').then((module) => ({ default: module.DataManager })),
);
const BrowserSettings = lazy(() =>
  import('./BrowserSettings').then((module) => ({ default: module.BrowserSettings })),
);
const LspManager = lazy(() =>
  import('./LspManager').then((module) => ({ default: module.LspManager })),
);
const AutomationSettings = lazy(() =>
  import('./AutomationSettings').then((module) => ({ default: module.AutomationSettings })),
);
const WorktreeManager = lazy(() =>
  import('./WorktreeManager').then((module) => ({ default: module.WorktreeManager })),
);

const providerName = providerLabel;
const templateCapabilityLabel = (model: ModelDescriptor) => {
  const caps = model.templateCapabilities;
  if (!caps) return '';
  return [
    localize('llama.cpp 템플릿 확인됨'),
    localize('도구 호출 {0}', model.tools ? localize('지원') : localize('미지원')),
    caps.supportsSystemRole === null
      ? ''
      : localize(
          'system 역할 {0}',
          caps.supportsSystemRole ? localize('지원') : localize('변환 필요'),
        ),
    caps.supportsPreserveReasoning === null
      ? ''
      : localize(
          'reasoning 보존 {0}',
          caps.supportsPreserveReasoning ? localize('지원') : localize('미지원'),
        ),
  ]
    .filter(Boolean)
    .join(' · ');
};
const messageError = (error: unknown) => (error instanceof Error ? error.message : String(error));
const permissionLabel: Record<PermissionMode, string> = {
  ask: '승인 요청',
  auto: '대신 승인',
  full: '전체 접근',
};

export function App() {
  useLocale();
  const workspace = useWorkspace();
  const session = workspace.sessions.find((s) => s.id === workspace.selectedId);
  const [settings, setSettings] = useState(false);
  const [settingsSection, setSettingsSection] = useState<SettingsSectionId | null>(null);
  const [settingsRevision, setSettingsRevision] = useState(0);
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
  const [drafts, setDrafts] = useState<ComposerDrafts>({});
  const draftKey = composerDraftKey(session?.id, workspace.selectedProjectId);
  const text = drafts[draftKey] ?? '';
  const setText = (update: DraftUpdate) =>
    setDrafts((current) => updateComposerDraft(current, draftKey, update));
  const [slashIndex, setSlashIndex] = useState(0);
  const [slashDismissed, setSlashDismissed] = useState(false);
  const [busy, setBusy] = useState(false);
  const mode = composerRequestMode(
    text,
    session?.run?.status === 'running' ? (session.mode ?? 'build') : undefined,
  );
  const [light, setLight] = useState(false);
  const [design, setDesign] = useState(loadDesignPreference);
  const appSurface = useRef<HTMLDivElement>(null);
  const glassEffects = useGlassMotionPreference();
  const glassMotion = design === 'glass' && glassEffects.allowMotion;
  useLiquidGlassEffects(appSurface, design === 'glass', glassEffects.allowMotion);
  useGlassRefraction(appSurface, design === 'glass' && glassEffects.preference !== 'reduced');
  const glassLayout = useGlassPanelLayout(
    appSurface,
    design === 'glass',
    glassMotion,
    sidebarOpen,
    planOpen,
  );
  useEffect(() => {
    saveDesignPreference(design);
  }, [design]);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const conversation = useRef<HTMLDivElement>(null);
  const followLatest = useRef(true);
  const end = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const config = session ? resolveModelConfig({ ...session, mode }) : workspace.config;
  const contextProvider =
    config.provider === 'openrouter' ||
    (session?.routing?.subagentsEnabled &&
      (session.routing.subagent ?? session.config).provider === 'openrouter')
      ? 'openrouter'
      : config.provider;
  const running = session?.run?.status === 'running';
  const [skillRegistry, setSkillRegistry] = useState<RegisteredSkill[]>([]);
  const skillSelectionKey = session?.skills
    ?.map((entry) => entry.id + ':' + entry.revision)
    .join(',');
  useEffect(() => {
    let active = true;
    if (workspace.connected)
      void registeredSkills()
        .then((skills) => {
          if (active) setSkillRegistry(skills);
        })
        .catch(() => {
          if (active) setSkillRegistry([]);
        });
    return () => {
      active = false;
    };
  }, [workspace.connected, session?.id, skillSelectionKey, settingsSection]);
  const selectedCommandSkills = skillRegistry.filter((skill) =>
    session?.skills?.some(
      (selection) => selection.id === skill.id && selection.revision === skill.revision,
    ),
  );
  const slashSuggestions = suggestSlashCommands(
    text,
    availableSlashCommands(session, workspace.connected, skillRegistry),
  );
  const localComposerCommand = ['new', 'settings', 'help'].includes(
    parseComposerInput(text).command,
  );
  const activeSlash = Math.min(slashIndex, Math.max(0, slashSuggestions.length - 1));
  const slashOpen = !slashDismissed && slashSuggestions.length > 0;
  useEffect(() => {
    setSlashIndex(0);
    setSlashDismissed(false);
  }, [text, session?.id]);
  function chooseSlash(command: SlashCommand) {
    setText(command.insertText ?? `/${command.id} `);
    requestAnimationFrame(() => composer.current?.focus());
  }
  const permissionMode = session?.permissionMode ?? defaultPermissionMode();
  const pendingApproval = session?.messages
    .flatMap((message) => message.activities ?? [])
    .find((activity) => activity.approval?.status === 'pending');
  const pendingElicitation = session?.messages
    .flatMap((message) => message.activities ?? [])
    .find((activity) => activity.elicitation?.status === 'pending');
  const project = workspace.projects.find((p) => p.id === workspace.selectedProjectId);
  const visibleSessions = workspace.sessions.filter(
    (s) => (s.projectId ?? null) === workspace.selectedProjectId,
  );

  useEffect(() => {
    let widePlan = window.innerWidth >= 1180,
      wideSidebar = window.innerWidth > 760;
    const resize = () => {
      const nextPlan = window.innerWidth >= 1180,
        nextSidebar = window.innerWidth > 760;
      if (widePlan && !nextPlan) setPlanOpen(false);
      if (wideSidebar && !nextSidebar) setSidebarOpen(false);
      widePlan = nextPlan;
      wideSidebar = nextSidebar;
    };
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);

  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if (document.querySelector('dialog[open]')) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'n') {
        event.preventDefault();
        useWorkspace.getState().select(null);
        composer.current?.focus();
      }
    };
    window.addEventListener('keydown', shortcut);
    return () => window.removeEventListener('keydown', shortcut);
  }, []);

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

  function scrollToBottom(behavior: ScrollBehavior = 'smooth') {
    followLatest.current = true;
    setShowScrollToBottom(false);
    end.current?.scrollIntoView({ behavior, block: 'end' });
  }
  function trackConversationScroll() {
    const node = conversation.current;
    if (!node) return;
    const atBottom = node.scrollHeight - node.scrollTop - node.clientHeight <= 72;
    followLatest.current = atBottom;
    setShowScrollToBottom(!atBottom && !!session?.messages.length);
  }
  useEffect(() => {
    followLatest.current = true;
    setShowScrollToBottom(false);
    requestAnimationFrame(() => scrollToBottom('instant'));
  }, [session?.id]);
  useEffect(() => {
    if (followLatest.current) scrollToBottom('instant');
  }, [
    session?.messages.filter((message) => message.role === 'assistant').at(-1)?.content,
    session?.messages.length,
    running,
  ]);
  async function createSession(
    modelConfig = workspace.config,
    routing = session?.routing,
    agentMode: AgentMode = 'build',
  ): Promise<Session> {
    const selection = useWorkspace.getState();
    const result = await sendCommand({
      type: 'create_session',
      sessionId: crypto.randomUUID(),
      title: localize('새 대화'),
      config: modelConfig,
      ...(routing ? { routing } : {}),
      projectId: workspace.selectedProjectId,
      mode: agentMode,
    });
    workspace.upsert(result.session);
    const current = useWorkspace.getState();
    if (
      current.selectedId === selection.selectedId &&
      current.selectedProjectId === selection.selectedProjectId
    ) {
      workspace.setConfig(modelConfig);
      workspace.select(result.session.id);
    }
    return result.session;
  }
  async function submit(event?: FormEvent) {
    event?.preventDefault();
    if (!text.trim() || busy) return;
    const { command, argument } = parseComposerInput(text, selectedCommandSkills);
    setError('');
    if (command === 'unknown') {
      setError(localize('알 수 없는 명령입니다. /help로 사용 가능한 명령을 확인하세요.'));
      return;
    }
    if (!['message', 'plan', 'goal', 'skill'].includes(command) && argument) {
      setError(localize('/{0} 명령에는 추가 내용을 입력하지 마세요.', command));
      return;
    }
    if (command === 'settings' || command === 'new' || command === 'help') {
      if (command === 'settings') setSettingsSection('connection');
      if (command === 'new') workspace.select(null);
      setText(command === 'help' ? '/' : '');
      setSlashDismissed(false);
      requestAnimationFrame(() => composer.current?.focus());
      return;
    }
    if (!workspace.connected) {
      setError(localize('워크스페이스 연결을 기다려 주세요.'));
      return;
    }
    if (running && command !== 'stop' && command !== 'message') {
      setError(localize('현재 실행이 끝난 뒤 명령을 실행하세요.'));
      return;
    }
    if (command === 'plan' && !argument) {
      setText('/plan ');
      setError(localize('/plan 뒤에 조사하거나 계획할 내용을 입력하세요.'));
      composer.current?.focus();
      return;
    }
    if (command === 'goal' && (!argument || argument.length > 4000)) {
      setError(localize('사용법: /goal 달성할 목표 (최대 4,000자)'));
      return;
    }
    if (command === 'stop' && !running) {
      setError(localize('진행 중인 실행이 없습니다.'));
      return;
    }
    if (
      ['compact', 'quick', 'resume'].includes(command) &&
      !availableSlashCommands(session, true).some((item) => item.id === command)
    ) {
      setError(
        localize(command === 'resume' ? '계속할 목표가 없습니다.' : '압축할 대화가 없습니다.'),
      );
      return;
    }
    const nextMode = composerRequestMode(text, running ? mode : undefined);
    const requestConfig = session ? resolveModelConfig({ ...session, mode: nextMode }) : config;
    const needsModel =
      command === 'message' ||
      command === 'skill' ||
      command === 'goal' ||
      command === 'compact' ||
      command === 'resume' ||
      command === 'plan';
    if (needsModel && requestConfig.provider !== 'demo' && !requestConfig.model) {
      setSettings(true);
      return;
    }
    setBusy(true);
    let submissionDraftKey = draftKey;
    try {
      await submitComposerDraft(
        text,
        (update) => {
          const targetKey = submissionDraftKey;
          setDrafts((current) => updateComposerDraft(current, targetKey, update));
        },
        async () => {
          composer.current?.focus();
          let target = session;
          if (running && command === 'message') {
            workspace.upsert(
              (
                await sendCommand({
                  type: 'steer_run',
                  sessionId: target!.id,
                  runId: target!.run!.id,
                  content: argument,
                })
              ).session,
            );
            return;
          }
          if (command === 'stop') {
            workspace.upsert(
              (
                await sendCommand({
                  type: 'cancel_run',
                  sessionId: target!.id,
                  runId: target!.run!.id,
                })
              ).session,
            );
          } else if (command === 'compact' || command === 'quick') {
            workspace.upsert(
              (
                await sendCommand({
                  type: command === 'quick' ? 'quick_compact_context' : 'compact_context',
                  sessionId: target!.id,
                  expectedVersion: target!.version,
                })
              ).session,
            );
          } else if (command === 'resume') {
            workspace.upsert(
              (
                await sendCommand({
                  type: 'resume_goal',
                  sessionId: target!.id,
                  expectedVersion: target!.version,
                })
              ).session,
            );
          } else {
            followLatest.current = true;
            setShowScrollToBottom(false);
            if (!target) {
              target = await createSession(workspace.config, undefined, nextMode);
              const sourceKey = submissionDraftKey;
              submissionDraftKey = composerDraftKey(target.id, target.projectId);
              const targetKey = submissionDraftKey;
              setDrafts((current) => moveComposerDraft(current, sourceKey, targetKey));
            }
            workspace.upsert(
              (
                await sendCommand(
                  command === 'goal'
                    ? {
                        type: 'start_goal',
                        sessionId: target.id,
                        expectedVersion: target.version,
                        goal: argument,
                        limits: autopilotLimitsSchema.parse({}),
                      }
                    : {
                        type: 'send_message',
                        sessionId: target.id,
                        expectedVersion: target.version,
                        content: argument,
                        mode: nextMode,
                      },
                )
              ).session,
            );
          }
        },
      );
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
  async function compactContext(quick = false) {
    if (!session || busy || running || !workspace.connected) return;
    setBusy(true);
    setError('');
    try {
      const result = await sendCommand({
        type: quick ? 'quick_compact_context' : 'compact_context',
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
      setError(localize('먼저 대화를 만드세요.'));
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
  async function decideElicitation(
    action: 'accept' | 'decline' | 'cancel',
    content?: Record<string, ElicitationValue>,
  ) {
    if (!session || !pendingElicitation || busy) return;
    setBusy(true);
    setError('');
    try {
      const updated = await elicitationAction({
        sessionId: session.id,
        expectedVersion: session.version,
        activityId: pendingElicitation.id,
        action,
        ...(action === 'accept' ? { content: content ?? {} } : {}),
      });
      workspace.upsert(updated);
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
    if (session) {
      const result = await sendCommand({
        type: 'configure_session',
        sessionId: session.id,
        expectedVersion: session.version,
        config: value,
        role: mode,
      });
      workspace.upsert(result.session);
    }
    workspace.setConfig(value);
    setSettings(false);
    setSettingsRevision((value) => value + 1);
  }
  async function applyRouting(routing: AgentRoutingConfig) {
    if (!session) await createSession(workspace.config, routing);
    else {
      const result = await sendCommand({
        type: 'configure_routing',
        sessionId: session.id,
        expectedVersion: session.version,
        routing,
      });
      workspace.upsert(result.session);
    }
    setSettingsRevision((value) => value + 1);
  }
  async function chooseLocalModel(profile: LocalProfile) {
    const modelConfig: ModelConfig = {
      ...config,
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
    await applyConfig(modelConfig);
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
    setSettingsRevision((value) => value + 1);
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
    setSettingsRevision((value) => value + 1);
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
    setSettingsRevision((value) => value + 1);
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
    setSettingsRevision((value) => value + 1);
  }
  const latestAssistant = session?.messages.filter((m) => m.role === 'assistant').at(-1);
  const latestUsage = latestAssistant?.usage;
  const compactionIsNewer =
    !!session?.contextCompaction &&
    (!session.run ||
      Date.parse(session.contextCompaction.createdAt) > Date.parse(session.run.startedAt));
  const contextBase = compactionIsNewer
    ? session!.contextCompaction!.compactedEstimateTokens
    : (session?.run?.context?.inputTokens ?? session?.run?.context?.inputEstimateTokens ?? 0);
  const contextUsed = Math.max(0, contextBase);
  const contextPercent = Math.min(
    100,
    Math.max(0, Math.round((contextUsed / Math.max(1, config.contextBudgetTokens)) * 100)),
  );
  return (
    <GlassRoot
      allowMotion={glassMotion}
      ref={appSurface}
      className={`app ${light ? 'light' : ''} ${sidebarOpen ? '' : 'sidebar-closed'} ${planOpen ? '' : 'plan-closed'}`}
      data-design={design}
      data-glass-effects={glassEffects.preference}
      data-glass-motion={glassMotion ? 'full' : 'reduced'}
      style={{ '--glass-transparency': glassEffects.transparency / 100 } as CSSProperties}
    >
      <AnimatePresence initial={false}>
        {sidebarOpen && (
          <GlassPanel
            key="sidebar"
            side="left"
            className="sidebar"
            label={localize('대화 탐색')}
            style={
              design === 'glass'
                ? { gridColumn: 1, gridRow: 1, width: glassLayout.sidebarWidth }
                : undefined
            }
          >
            <div className="brand">
              <span className="brand-mark">
                <Logo />
              </span>
              <strong>Lodex</strong>
              <span className="version">0.1</span>
              <button
                className="icon-button collapse-sidebar"
                aria-label={localize('사이드바 접기')}
                onClick={() => setSidebarOpen(false)}
              >
                <Icon name="panel" size={18} />
              </button>
            </div>
            <button
              className="new-chat"
              onClick={() => {
                workspace.select(null);
                composer.current?.focus();
              }}
            >
              <Icon name="plus" size={18} />
              {localize('새 대화')}
              <span>⌘ / Ctrl N</span>
            </button>
            <div className="sidebar-scroll">
              <div className="nav-caption">{localize('워크스페이스')}</div>
              <button
                className={`nav-item ${!project ? 'active' : ''}`}
                onClick={() => {
                  workspace.selectProject(null);
                  composer.current?.focus();
                }}
              >
                <Icon name="chat" size={18} />
                {localize('일반 대화')}
              </button>
              <button
                className="nav-item"
                onClick={() => {
                  setPlanOpen((value) => !value);
                  if (window.innerWidth <= 760) setSidebarOpen(false);
                }}
              >
                <Icon name="goal" size={18} />
                {localize('작업 계획')}
              </button>
              <div className="history-caption">
                <span>{localize('프로젝트')}</span>
                <button
                  className="icon-button"
                  aria-label={localize('프로젝트 추가')}
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
                    }}
                  >
                    <Icon name="folder" size={17} />
                    <span>{item.name}</span>
                  </button>
                ))}
                {!workspace.projects.length && (
                  <button className="project-empty" onClick={() => setProjectDialog(true)}>
                    {localize('로컬 폴더 연결')}
                  </button>
                )}
              </div>
              <ConversationHistory
                key={workspace.selectedProjectId ?? 'general'}
                sessions={visibleSessions}
                title={project ? project.name + localize(' 대화') : localize('최근 대화')}
                onSelect={(id) => {
                  workspace.select(id);
                }}
                onDeleted={() => {
                  const deleted = useWorkspace.getState().deletedSessionIds;
                  setDrafts((current) =>
                    Object.fromEntries(
                      Object.entries(current).filter(
                        ([key]) => !deleted.some((id) => key === composerDraftKey(id)),
                      ),
                    ),
                  );
                }}
                onError={setError}
              />
            </div>
            <div className="sidebar-bottom">
              <button
                className="nav-item sidebar-settings"
                onClick={() => setSettingsSection('connection')}
              >
                <Icon name="settings" size={18} />
                {localize('설정')}
              </button>
            </div>
          </GlassPanel>
        )}
      </AnimatePresence>
      {sidebarOpen && (
        <button
          type="button"
          className="panel-scrim sidebar-scrim"
          aria-label={localize('사이드바 닫기')}
          onClick={() => setSidebarOpen(false)}
        />
      )}

      <main className="main" style={design === 'glass' ? { gridColumn: 2, gridRow: 1 } : undefined}>
        <header className="topbar">
          <div className="topbar-left">
            {
              <button
                className={`icon-button ${sidebarOpen ? 'mobile-sidebar-toggle' : ''}`}
                aria-label={sidebarOpen ? localize('사이드바 닫기') : localize('사이드바 열기')}
                onClick={() => {
                  setSidebarOpen(!sidebarOpen);
                  if (!sidebarOpen && window.innerWidth <= 760) setPlanOpen(false);
                }}
              >
                <Icon name="panel" />
              </button>
            }
            <button className="model-picker" onClick={() => setSettings(true)}>
              <span className="model-name">{config.model || localize('모델 연결')}</span>
              <Icon name="down" size={15} />
            </button>
          </div>
          <div className="topbar-right">
            <span className="mode-badge" title={project?.path}>
              {project
                ? project.name + ' · ' + (mode === 'plan' ? 'Plan' : 'Build')
                : localize('대화 · ') + (mode === 'plan' ? 'Plan' : 'Build')}
            </span>
            <button
              className="activity-toggle"
              aria-pressed={showActivities}
              onClick={() => setShowActivities(!showActivities)}
            >
              {showActivities ? localize('활동 숨기기') : localize('활동 표시')}
            </button>
            <button
              className="icon-button"
              aria-label={light ? localize('어두운 테마') : localize('밝은 테마')}
              onClick={() => setLight(!light)}
            >
              <Icon name="moon" size={18} />
            </button>
            <button
              className="design-switch"
              aria-label={
                design === 'glass'
                  ? localize('기존 디자인으로 전환')
                  : localize('Liquid Glass 디자인으로 전환')
              }
              title={
                design === 'glass'
                  ? localize('기존 디자인으로 전환')
                  : localize('Liquid Glass 디자인으로 전환')
              }
              onClick={() => setDesign(design === 'glass' ? 'classic' : 'glass')}
            >
              {design === 'glass' ? localize('기존 디자인') : 'Liquid Glass'}
            </button>
            {design === 'glass' && (
              <GlassEffectsSettings
                preference={glassEffects.preference}
                onChange={glassEffects.setPreference}
                systemReducedMotion={glassEffects.systemReducedMotion}
                allowMotion={glassEffects.allowMotion}
                transparency={glassEffects.transparency}
                onTransparencyChange={glassEffects.setTransparency}
              />
            )}
            <button
              className={`icon-button ${planOpen ? 'is-active' : ''}`}
              aria-label={localize('작업 계획 패널 열기/닫기')}
              aria-expanded={planOpen}
              onClick={() => {
                setPlanOpen(!planOpen);
                if (!planOpen && window.innerWidth <= 760) setSidebarOpen(false);
              }}
            >
              <Icon name="panel" size={19} />
            </button>
          </div>
        </header>
        {!nativeDesktop && (
          <div className="preview-banner">
            {localize(
              'UI 미리보기입니다. 실제 모델 연결과 영구 저장은 데스크톱 앱에서 사용할 수 있습니다.',
            )}
          </div>
        )}
        <div className="conversation-shell">
          <div
            ref={conversation}
            className={`conversation ${session?.messages.length ? 'has-messages' : ''}`}
            onScroll={trackConversationScroll}
          >
            {!session?.messages.length ? (
              <div className="welcome">
                <div className="welcome-logo">
                  <Logo size={64} />
                </div>
                <div className="eyebrow">YOUR MODELS. YOUR WORKSPACE.</div>
                <h1>{localize('무엇을 만들어 볼까요?')}</h1>
                <p>
                  {localize('생각을 정리하고, 목표를 세우고.')}
                  <br />
                  {localize('내 모델과 함께 시작하는 나만의 작업 공간.')}
                </p>
                <div className="suggestions">
                  <button
                    onClick={() => {
                      setText(localize('만들고 싶은 프로그램의 개발 단계를 함께 정리해 줘.'));
                      composer.current?.focus();
                    }}
                  >
                    <Icon name="chat" />
                    <strong>{localize('아이디어 구체화')}</strong>
                    <span>{localize('생각을 실행 가능한 단계로')}</span>
                  </button>
                  <button
                    onClick={() => {
                      setText('/goal ');
                      composer.current?.focus();
                    }}
                  >
                    <Icon name="goal" />
                    <strong>{localize('지속 목표 실행')}</strong>
                    <span>{localize('/goal로 완료까지 진행')}</span>
                  </button>
                  <button onClick={() => setSettings(true)}>
                    <Icon name="chip" />
                    <strong>{localize('내 모델 연결')}</strong>
                    <span>{localize('로컬 서버 또는 OpenRouter')}</span>
                  </button>
                </div>
                <span className="welcome-note">
                  <Icon name="info" size={14} />
                  {nativeDesktop
                    ? localize('로컬 모델은 설정한 서버로, OpenRouter는 전송 동의 후 연결합니다.')
                    : localize('데모 화면에는 실제 모델 응답이나 성능 수치를 표시하지 않습니다.')}
                </span>
              </div>
            ) : (
              <div className="messages" aria-live="polite" aria-relevant="additions text">
                {session.messages.map((message) => (
                  <article key={message.id} className={`message ${message.role}`}>
                    {!showActivities &&
                      message.activities?.some(
                        (a) =>
                          (a.changes || a.edit) &&
                          !['applied', 'reverted', 'rejected'].includes(
                            (a.changes || a.edit)!.status,
                          ),
                      ) && (
                        <button className="review-reveal" onClick={() => setShowActivities(true)}>
                          {localize('파일 수정안 확인')}
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
                          {localize('계획 제안·명령 결과 확인')}
                        </button>
                      )}
                    {message.role === 'assistant' ? (
                      <AssistantMessage
                        message={message}
                        sessionId={session.id}
                        showActivities={showActivities}
                      />
                    ) : (
                      <div className="message-body">
                        {(message.content ? <Markdown text={message.content} /> : null) ||
                          (message.status === 'streaming' ? (
                            <span className="thinking">
                              <i />
                              <i />
                              <i />
                            </span>
                          ) : (
                            localize('응답 내용이 없습니다.')
                          ))}
                      </div>
                    )}
                    {message.runInput && (
                      <span className="message-status" role="status">
                        {message.runInput.status === 'queued'
                          ? localize('추가 지시 · 전달 중 (실행 중인 도구는 완료 후 반영)')
                          : message.runInput.status === 'included'
                            ? localize('추가 지시 · 모델 입력에 반영')
                            : localize('추가 지시 · 실행 중단으로 미반영')}
                      </span>
                    )}
                    {message.error && (
                      <p className="message-error">
                        <Icon name="info" size={15} />
                        {message.error}
                      </p>
                    )}
                    {['cancelled', 'interrupted', 'failed'].includes(message.status) && (
                      <span className="message-status">
                        {message.status === 'cancelled'
                          ? localize('중지됨')
                          : message.status === 'interrupted'
                            ? localize('이전 실행이 중단됨')
                            : localize('응답 미완료')}
                      </span>
                    )}
                    {message.usage?.costUsd !== null && message.usage?.costUsd !== undefined && (
                      <span className="message-status">
                        {localize('제공자 보고 비용 $')}
                        {message.usage.costUsd.toFixed(6)}
                      </span>
                    )}
                  </article>
                ))}
                <div ref={end} />
              </div>
            )}
          </div>
          {showScrollToBottom && (
            <button
              type="button"
              className="scroll-to-bottom"
              aria-label={localize('최신 메시지로 이동')}
              title={localize('맨 아래로')}
              onClick={() => scrollToBottom()}
            >
              <Icon name="down" size={19} />
            </button>
          )}
        </div>
        <div className="composer-area">
          {pendingElicitation?.elicitation && (
            <McpElicitationBanner
              key={pendingElicitation.id}
              activity={pendingElicitation}
              busy={busy}
              onDecide={decideElicitation}
              onOpen={openMcpLogin}
            />
          )}
          {pendingApproval?.approval && (
            <ApprovalBanner
              activity={pendingApproval}
              mode={mode}
              busy={busy}
              onDecide={(action) => void decideApproval(action)}
            />
          )}
          {error && (
            <div className="error-banner" role="alert">
              <Icon name="info" size={17} />
              <span>{error}</span>
              <button
                className="icon-button"
                aria-label={localize('오류 알림 닫기')}
                onClick={() => setError('')}
              >
                <Icon name="close" size={15} />
              </button>
            </div>
          )}
          {session && (
            <CommandJobsPanel
              sessionId={session.id}
              connected={workspace.connected}
              readOnly={mode === 'plan'}
            />
          )}
          <form
            className="composer"
            onSubmit={(event) => {
              void submit(event);
            }}
          >
            <SlashMenu
              open={slashOpen}
              commands={slashSuggestions}
              active={activeSlash}
              onSelect={chooseSlash}
            />
            <textarea
              ref={composer}
              role="combobox"
              aria-label={localize('메시지')}
              aria-haspopup="listbox"
              aria-autocomplete="list"
              aria-expanded={slashOpen}
              aria-controls={slashOpen ? 'composer-slash-menu' : undefined}
              aria-activedescendant={
                slashOpen ? `slash-command-${slashSuggestions[activeSlash]!.id}` : undefined
              }
              placeholder={
                running
                  ? localize('추가 지시 입력 · 이전 요청을 유지하며 반영합니다.')
                  : project
                    ? project.name + localize('에서 작업 요청하기 · / 명령')
                    : localize('메시지 보내기 · / 명령')
              }
              value={text}
              rows={2}
              maxLength={64000}
              onChange={(event) => setText(event.target.value)}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing || event.keyCode === 229) return;
                if (slashOpen) {
                  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                    event.preventDefault();
                    setSlashIndex(
                      moveSlashSelection(
                        activeSlash,
                        event.key === 'ArrowDown' ? 1 : -1,
                        slashSuggestions.length,
                      ),
                    );
                    return;
                  }
                  if (
                    !event.shiftKey &&
                    (event.key === 'Tab' ||
                      (event.key === 'Enter' &&
                        parseComposerInput(text, selectedCommandSkills).command === 'unknown'))
                  ) {
                    event.preventDefault();
                    chooseSlash(slashSuggestions[activeSlash]!);
                    return;
                  }
                  if (event.key === 'Escape') {
                    event.preventDefault();
                    setSlashDismissed(true);
                    return;
                  }
                }
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  void submit();
                }
              }}
            />
            <div className="composer-toolbar">
              <button type="button" className="provider-tag" onClick={() => setSettings(true)}>
                <Icon name={config.provider === 'openrouter' ? 'cloud' : 'chip'} size={15} />
                {providerName(config.provider)}
                <Icon name="down" size={12} />
              </button>
              <div className="permission-control">
                <button
                  type="button"
                  className={`autopilot-toggle permission-${permissionMode}`}
                  aria-label={localize(
                    'Autopilot 권한: {0}',
                    localize(permissionLabel[permissionMode]),
                  )}
                  aria-haspopup="menu"
                  aria-expanded={permissionMenu}
                  disabled={!session || busy || running || !workspace.connected}
                  title={localize('작업 승인 정책 선택')}
                  onClick={() => setPermissionMenu((open) => !open)}
                >
                  <span className="status-dot" />
                  Autopilot · {localize(permissionLabel[permissionMode])}
                  <Icon name="down" size={12} />
                </button>
                <GlassPopover
                  open={permissionMenu}
                  className="permission-menu"
                  role="menu"
                  aria-label={localize('Autopilot 권한 단계')}
                >
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
                      <strong>{localize(permissionLabel[value])}</strong>
                      <span>
                        {value === 'ask'
                          ? localize('변경과 외부 작업 전에 확인')
                          : value === 'auto'
                            ? localize('일반 작업은 자동, 위험 작업은 확인')
                            : localize('호스트와 네트워크를 추가 확인 없이 사용')}
                      </span>
                    </button>
                  ))}
                </GlassPopover>
              </div>
              {config.eco && (
                <span className="eco-tag">
                  <Icon name="leaf" size={14} />
                  Eco
                </span>
              )}
              <div className="composer-spacer" />
              <span className="composer-hint">{localize('Shift + Enter 줄바꿈')}</span>
              {running ? (
                <>
                  <button
                    type="submit"
                    className="send-button"
                    aria-label={localize('실행 중 추가 지시 전달')}
                    disabled={!text.trim() || busy || !workspace.connected}
                  >
                    <Icon name="arrow" size={20} />
                  </button>
                  <button
                    type="button"
                    className="send-button stop-button"
                    aria-label={localize('응답 중지')}
                    disabled={busy}
                    onClick={() => {
                      void cancel();
                    }}
                  >
                    <Icon name="stop" size={16} />
                  </button>
                </>
              ) : (
                <button
                  type="submit"
                  className="send-button"
                  aria-label={localize('메시지 보내기')}
                  disabled={!text.trim() || busy || (!workspace.connected && !localComposerCommand)}
                >
                  <Icon name="arrow" size={20} />
                </button>
              )}
            </div>
          </form>
          <div className="composer-footer">
            <span>
              {running
                ? localize(
                    '이전 요청과 추가 지시를 함께 반영합니다. 도구 실행·승인 대기 중에는 해당 단계가 끝난 뒤 반영합니다.',
                  )
                : project
                  ? config.provider === 'openrouter' && !config.projectCloudConsent
                    ? localize('프로젝트 파일 전송이 꺼져 있습니다. 설정에서 허용할 수 있습니다.')
                    : mode === 'plan'
                      ? localize('파일을 읽고 계획을 제안합니다. 파일 변경은 Build에서 가능합니다.')
                      : permissionMode === 'ask'
                        ? localize('변경과 실행은 승인 후 진행합니다.')
                        : permissionMode === 'auto'
                          ? localize('일반 작업은 자동 승인하고 위험 작업은 확인합니다.')
                          : localize(
                              '전체 접근으로 호스트 파일·명령·네트워크를 사용할 수 있습니다.',
                            )
                  : localize('프로젝트를 연결하면 파일을 살펴보며 작업할 수 있습니다.')}
            </span>
            <div className="context-meter">
              <button
                type="button"
                className="context-meter-trigger"
                aria-label={localize('컨텍스트 사용량 {0}%', contextPercent)}
                aria-haspopup="dialog"
              >
                <span className="context-meter-track" aria-hidden="true">
                  <span style={{ width: contextPercent + '%' }} />
                </span>
                {localize('컨텍스트 ')}
                {contextPercent}%
              </button>
              <div
                className="context-popover"
                role="dialog"
                aria-label={localize('컨텍스트 상세 정보')}
              >
                <strong>{localize('컨텍스트 사용량')}</strong>
                <dl>
                  <div>
                    <dt>{localize('활성 입력 추정 / 예산')}</dt>
                    <dd>
                      {contextUsed.toLocaleString()} / {config.contextBudgetTokens.toLocaleString()}
                    </dd>
                  </div>
                  <div>
                    <dt>{localize('토큰 생성 속도')}</dt>
                    <dd>
                      {latestUsage?.decodeTps
                        ? latestUsage.decodeTps.value.toFixed(1) + ' tok/s'
                        : localize('미측정')}
                    </dd>
                  </div>
                  <div>
                    <dt>{localize('프리필 속도')}</dt>
                    <dd>
                      {latestUsage?.prefillTps
                        ? latestUsage.prefillTps.value.toFixed(1) + ' tok/s'
                        : localize('미측정')}
                    </dd>
                  </div>
                  <div>
                    <dt>{localize('첫 토큰 지연')}</dt>
                    <dd>
                      {latestUsage?.ttftMs
                        ? (latestUsage.ttftMs.value / 1000).toFixed(2) + ' s'
                        : localize('미측정')}
                    </dd>
                  </div>
                </dl>
                <div className="context-compaction-actions">
                  <button
                    type="button"
                    className="compact-context-button"
                    disabled={
                      !session?.messages.some((message) => message.status === 'complete') ||
                      busy ||
                      running
                    }
                    onClick={() => void compactContext(false)}
                    title={localize('현재 모델이 목표, 결정, 진행 상태를 요약합니다.')}
                  >
                    <Icon name="leaf" size={14} />
                    {localize('컨텍스트 압축')}
                  </button>
                  <button
                    type="button"
                    className="compact-context-button secondary"
                    disabled={
                      !session?.messages.some((message) => message.status === 'complete') ||
                      busy ||
                      running
                    }
                    onClick={() => void compactContext(true)}
                    title={localize('모델 호출 없이 기존 규칙으로 즉시 압축합니다.')}
                  >
                    <Icon name="bolt" size={14} />
                    {localize('빠른 압축')}
                  </button>
                </div>
                <small>
                  {config.eco
                    ? localize('Eco: 작업 중 오래된 기록을 자동으로 요약합니다.')
                    : localize('자동 LLM 압축: 80% 초과 시 시작 · 25% 목표')}
                </small>
                {session?.contextCompaction && (
                  <small>
                    {localize('최근 압축: ')}
                    {session.contextCompaction.compactedMessageCount}
                    {localize('개 메시지 ·')}{' '}
                    {session.contextCompaction.reason === 'eco'
                      ? localize('ECO 자동')
                      : session.contextCompaction.reason === 'automatic'
                        ? localize('용량 초과 자동')
                        : session.contextCompaction.method === 'semantic'
                          ? localize(
                              'LLM 수동{0}',
                              session.contextCompaction.model
                                ? ` · ${session.contextCompaction.model}`
                                : '',
                            )
                          : localize('빠른 수동')}
                  </small>
                )}
              </div>
            </div>
          </div>
          <CompactionSummary session={session} />
        </div>
      </main>

      {planOpen && (
        <button
          type="button"
          className="panel-scrim plan-scrim"
          aria-label={localize('작업 계획 패널 닫기')}
          onClick={() => setPlanOpen(false)}
        />
      )}
      <AnimatePresence initial={false}>
        {planOpen && (
          <GlassPanel
            key="plan"
            side="right"
            className="plan-panel"
            label={localize('작업 계획과 할 일')}
            style={
              design === 'glass'
                ? { gridColumn: 3, gridRow: 1, width: glassLayout.planWidth }
                : undefined
            }
          >
            <div className="plan-header">
              <Icon name="goal" size={19} />
              <strong>{localize('작업 계획')}</strong>
              <span className="small-badge">{localize('편집')}</span>
            </div>
            <TaskListPanel
              key={'tasks-' + (session?.id ?? 'new')}
              session={session}
              ensureSession={createSession}
              onError={setError}
            />
            <details
              className="goal-section"
              open={session?.autopilot?.status === 'running' || undefined}
            >
              <summary>{localize('목표 추진 · Goal')}</summary>
              <PlanEditor
                key={session?.id ?? 'new'}
                session={session}
                ensureSession={createSession}
                onError={setError}
              />
            </details>
            <div className="run-panel">
              {session?.projectId && <ExecutionPanel key={session.id} session={session} />}
              <div className="section-label">{localize('현재 실행')}</div>
              <div className="run-state">
                <span className={`status-dot ${running ? 'pulsing' : ''}`} />
                {running ? localize('모델 응답 생성 중') : localize('대기 중')}
              </div>
              <dl className="metrics-list">
                <div>
                  <dt>{localize('생성 속도')}</dt>
                  <dd>
                    {latestUsage?.decodeTps
                      ? latestUsage.decodeTps.value.toFixed(1) + ' tok/s'
                      : '—'}
                  </dd>
                </div>
                <div>
                  <dt>{localize('프리필 속도')}</dt>
                  <dd>
                    {latestUsage?.prefillTps
                      ? latestUsage.prefillTps.value.toFixed(1) + ' tok/s'
                      : '—'}
                  </dd>
                </div>
                <div>
                  <dt>{localize('첫 토큰 지연')}</dt>
                  <dd>
                    {latestUsage?.ttftMs
                      ? (latestUsage.ttftMs.value / 1000).toFixed(2) + ' s'
                      : '—'}
                  </dd>
                </div>
                <div>
                  <dt>{localize('출력 토큰')}</dt>
                  <dd>{latestUsage?.outputTokens ?? '—'}</dd>
                </div>
                <div>
                  <dt>{localize('비용')}</dt>
                  <dd>
                    {latestUsage?.costUsd != null
                      ? '$' + latestUsage.costUsd.toFixed(6)
                      : config.provider === 'openrouter' && latestUsage
                        ? localize('확인 대기')
                        : '—'}
                  </dd>
                </div>
              </dl>
              <p className="subtle-note">
                {localize(
                  '속도는 엔진 보고값, 첫 토큰 지연은 앱 측정값입니다. 제공되지 않은 수치는 추정하지 않습니다.',
                )}
              </p>
            </div>
            {session?.run?.context && (
              <details className="context-report">
                <summary>
                  {localize('입력 구성 · ')}
                  {session.run.context.inputTokens === undefined
                    ? localize('추정')
                    : localize('실측')}{' '}
                  {(
                    session.run.context.inputTokens ?? session.run.context.inputEstimateTokens
                  ).toLocaleString()}{' '}
                  {localize('토큰')}
                </summary>
                <dl className="metrics-list">
                  {session.run.context.inputTokens !== undefined && (
                    <div>
                      <dt>{localize('보수적 추정')}</dt>
                      <dd>{session.run.context.inputEstimateTokens.toLocaleString()}</dd>
                    </div>
                  )}
                  <div>
                    <dt>{localize('앱 예산')}</dt>
                    <dd>{session.run.context.contextBudgetTokens.toLocaleString()}</dd>
                  </div>
                  <div>
                    <dt>{localize('출력 예약 / 여유')}</dt>
                    <dd>
                      {session.run.context.outputReserveTokens.toLocaleString()} /{' '}
                      {session.run.context.safetyReserveTokens.toLocaleString()}
                    </dd>
                  </div>
                  <div>
                    <dt>{localize('대화 이력')}</dt>
                    <dd>
                      {session.run.context.historyMessageIds.length}
                      {localize('개 메시지')}
                    </dd>
                  </div>
                  <div>
                    <dt>{localize('미완료 응답 제외')}</dt>
                    <dd>
                      {session.run.context.excludedMessageIds.length}
                      {localize('개')}
                    </dd>
                  </div>
                  <div>
                    <dt>{localize('저장한 계획·지침')}</dt>
                    <dd>
                      {session.run.context.planIncluded ? localize('포함') : localize('제외')}
                    </dd>
                  </div>
                </dl>
                <p className="subtle-note">
                  {localize(
                    '마지막 요청 기준입니다. UTF-8 바이트를 이용한 보수적 추정으로, 실제 토큰 수·엔진 한도와 다를 수 있습니다. 완료된 대화는 생략하지 않습니다.',
                  )}
                </p>
              </details>
            )}
          </GlassPanel>
        )}
      </AnimatePresence>
      {confirmFullAccess && (
        <FullAccessDialog
          onClose={() => setConfirmFullAccess(false)}
          onConfirm={() => {
            setConfirmFullAccess(false);
            void changePermissionMode('full');
          }}
        />
      )}
      {projectDialog && (
        <ProjectDialog
          onClose={() => setProjectDialog(false)}
          onAdded={(project) => {
            workspace.upsertProject(project);
            workspace.selectProject(project.id);
            setProjectDialog(false);
          }}
        />
      )}
      <AnimatePresence>
        {settings && (
          <Settings
            key="quick-settings"
            config={config}
            hasMessages={!!session?.messages.length}
            running={!!running}
            onClose={() => setSettings(false)}
            onSave={applyConfig}
          />
        )}
      </AnimatePresence>
      <AnimatePresence>
        {settingsSection && (
          <SettingsScreen
            key="settings-screen"
            selected={settingsSection}
            onSelect={setSettingsSection}
            onClose={() => setSettingsSection(null)}
          >
            <Suspense
              fallback={
                <div className="settings-loading" role="status">
                  {localize('설정을 불러오는 중…')}
                </div>
              }
            >
              <div key={`${settingsSection}-${settingsRevision}`}>
                {settingsSection === 'connection' && (
                  <Settings
                    embedded
                    config={config}
                    hasMessages={!!session?.messages.length}
                    running={!!running}
                    onClose={() => setSettingsSection(null)}
                    onSave={applyConfig}
                  />
                )}
                {settingsSection === 'local' && (
                  <ModelManager
                    embedded
                    hasSession={!!session}
                    running={!!running}
                    onClose={() => setSettingsSection(null)}
                    onChoose={chooseLocalModel}
                  />
                )}
                {settingsSection === 'routing' && (
                  <RoutingSettings
                    embedded
                    base={session?.config ?? workspace.config}
                    routing={session?.routing}
                    hasMessages={!!session?.messages.length}
                    running={!!running}
                    onClose={() => setSettingsSection(null)}
                    onSave={applyRouting}
                  />
                )}
                {settingsSection === 'skills' && (
                  <SkillManager
                    embedded
                    session={session}
                    projectId={session?.projectId ?? workspace.selectedProjectId ?? undefined}
                    provider={contextProvider}
                    connected={workspace.connected}
                    onClose={() => setSettingsSection(null)}
                    onSave={applySkills}
                  />
                )}
                {settingsSection === 'mcp' && (
                  <McpManager
                    embedded
                    session={session}
                    projectPath={
                      workspace.projects.find(
                        (project) =>
                          project.id === (session?.projectId ?? workspace.selectedProjectId),
                      )?.path
                    }
                    provider={contextProvider}
                    connected={workspace.connected}
                    onClose={() => setSettingsSection(null)}
                    onSave={applyMcp}
                    onAttach={attachMcp}
                    onRemoveAttachment={removeMcpAttachment}
                  />
                )}
                {settingsSection === 'telegram' && (
                  <TelegramSettings
                    embedded
                    sessions={workspace.sessions}
                    selectedId={session?.id ?? null}
                    onClose={() => setSettingsSection(null)}
                  />
                )}
                {settingsSection === 'data' && (
                  <DataManager embedded onClose={() => setSettingsSection(null)} />
                )}
                {settingsSection === 'browser' && <BrowserSettings />}
                {settingsSection === 'lsp' && (
                  <LspManager
                    projects={workspace.projects}
                    selectedId={session?.projectId ?? workspace.selectedProjectId}
                  />
                )}
                {settingsSection === 'automations' && session && (
                  <AutomationSettings session={session} />
                )}
                {settingsSection === 'worktree' && (
                  <WorktreeManager
                    session={session}
                    embedded
                    projects={workspace.projects}
                    selectedId={workspace.selectedProjectId}
                    onClose={() => setSettingsSection(null)}
                    onOpen={(project) => {
                      workspace.upsertProject(project);
                      workspace.selectProject(project.id);
                      setSettingsSection(null);
                    }}
                  />
                )}
              </div>
            </Suspense>
          </SettingsScreen>
        )}
      </AnimatePresence>
    </GlassRoot>
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
      <h2 id="full-access-title">{localize('전체 접근을 사용하시겠어요?')}</h2>
      <p>{localize('이 대화의 모델과 도구에 다음 권한을 추가 승인 없이 허용합니다.')}</p>
      <ul>
        <li>{localize('프로젝트 밖의 파일을 읽고 수정할 수 있습니다.')}</li>
        <li>{localize('호스트 명령과 네트워크를 제한 없이 사용할 수 있습니다.')}</li>
        <li>{localize('.env, SSH 키, 인증 파일을 읽을 수 있습니다.')}</li>
        <li>{localize('OpenRouter 사용 시 파일 내용이나 명령 출력이 전송될 수 있습니다.')}</li>
        <li>{localize('Telegram에서도 원격 전체 접근 작업을 실행할 수 있습니다.')}</li>
      </ul>
      <div className="dialog-actions">
        <button type="button" onClick={onClose}>
          {localize('취소')}
        </button>
        <button type="button" className="danger-button" onClick={onConfirm}>
          {localize('전체 접근 사용')}
        </button>
      </div>
    </dialog>
  );
}

export function PlanEditor({
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
  const [executionMode, setExecutionMode] = useState(() => loadGoalExecutionMode(session));
  const [simpleGoal, setSimpleGoal] = useState(
    session?.autopilot?.goalDriven ? session.autopilot.plan.goal : (session?.plan.goal ?? ''),
  );
  const running = session?.run?.status === 'running';
  useEffect(() => {
    if (session?.autopilot?.goalDriven) {
      setSimpleGoal(session.autopilot.plan.goal);
      if (session.autopilot.status === 'running') setExecutionMode('simple');
    }
  }, [session?.autopilot?.runId]);
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
  async function savePlan(): Promise<Session> {
    if (storedPlan !== editBase.current)
      throw new Error(
        localize('편집 중 저장된 계획이 변경되었습니다. 저장된 계획을 불러온 뒤 다시 편집하세요.'),
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
    return result.session;
  }
  async function save() {
    setSaving(true);
    try {
      await savePlan();
    } catch (failure) {
      onError(messageError(failure));
    } finally {
      setSaving(false);
    }
  }
  async function start(limits: GoalLimits, taskIds: string[]) {
    setSaving(true);
    try {
      const target =
        executionMode === 'advanced' && dirty
          ? await savePlan()
          : (session ?? (await ensureSession()));
      const result = await sendCommand(
        goalExecutionCommand(executionMode, target, simpleGoal, limits, taskIds),
      );
      useWorkspace.getState().upsert(result.session);
    } finally {
      setSaving(false);
    }
  }
  function changeExecutionMode(next: GoalExecutionMode) {
    const goal = executionMode === 'simple' ? simpleGoal : draft.goal;
    setSimpleGoal(goal);
    if (next === 'advanced' && draft.goal !== goal) update({ ...draft, goal });
    setExecutionMode(next);
    saveGoalExecutionMode(next);
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
      <div className="goal-mode-switch" role="group" aria-label={localize('목표 추진 모드')}>
        {(['simple', 'advanced'] as const).map((value) => (
          <button
            type="button"
            key={value}
            aria-pressed={executionMode === value}
            disabled={saving || running}
            onClick={() => changeExecutionMode(value)}
          >
            {value === 'simple' ? 'Simple' : 'Advanced'}
          </button>
        ))}
      </div>
      <label className="section-label" htmlFor="goal">
        {localize('목표')}
      </label>
      <textarea
        id="goal"
        className="goal-input"
        rows={3}
        maxLength={4000}
        placeholder={localize('이번 작업에서 이루고 싶은 목표를 적어 보세요.')}
        value={executionMode === 'simple' ? simpleGoal : draft.goal}
        disabled={saving || running}
        onChange={(event) => {
          setSimpleGoal(event.target.value);
          update({ ...draft, goal: event.target.value });
        }}
      />
      {executionMode === 'simple' && (
        <p className="subtle-note">
          {localize('목표만 입력하면 모델이 필요한 작업을 정하고 실행·검증합니다.')}
        </p>
      )}
      {executionMode === 'advanced' && (
        <>
          <label className="section-label" htmlFor="plan-instructions">
            {localize('고정 지침')}
          </label>
          <textarea
            id="plan-instructions"
            className="goal-input"
            rows={2}
            maxLength={4000}
            placeholder={localize('계속 지킬 제약과 완료 기준을 적어 주세요.')}
            value={draft.instructions}
            onChange={(event) => update({ ...draft, instructions: event.target.value })}
          />
          <label className="section-label" htmlFor="goal-criteria">
            {localize('목표 완료 기준')}
          </label>
          <textarea
            id="goal-criteria"
            className="goal-input"
            rows={2}
            maxLength={4000}
            value={draft.criteria ?? ''}
            placeholder={localize('어떤 결과로 완료를 확인할까요?')}
            onChange={(event) => update({ ...draft, criteria: event.target.value })}
          />
          <label className="section-label" htmlFor="goal-verification">
            {localize('최종 검증 명령')}
          </label>
          <textarea
            id="goal-verification"
            className="goal-input"
            rows={2}
            maxLength={8000}
            value={draft.verificationCommand ?? ''}
            placeholder={localize('예: npm test')}
            onChange={(event) => update({ ...draft, verificationCommand: event.target.value })}
          />
          <ArtifactChecksEditor
            label={localize('최종 검증 파일')}
            checks={draft.verificationArtifacts ?? []}
            onChange={(verificationArtifacts) => update({ ...draft, verificationArtifacts })}
          />
          <label className="check-field plan-context-choice">
            <input
              type="checkbox"
              checked={draft.includeInContext}
              onChange={(event) => update({ ...draft, includeInContext: event.target.checked })}
            />
            <span>{localize('저장한 목표·할 일·고정 지침을 다음 모델 요청에 포함')}</span>
          </label>
          <p className="subtle-note">
            {localize(
              'OpenRouter 대화에서는 포함한 내용이 외부 제공자에게 전송됩니다. 저장한 변경은 다음 요청부터 적용됩니다.',
            )}
          </p>
          <div className="task-heading">
            <span className="section-label">{localize('할 일')}</span>
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
                  {localize('큰 목표를 작은 단계로')}
                  <br />
                  {localize('나누어 보세요.')}
                </p>
              </div>
            ) : (
              draft.tasks.map((task, index) => (
                <div key={task.id}>
                  <div className={`task-row ${task.done ? 'done' : ''}`}>
                    <input
                      type="checkbox"
                      aria-label={task.title + localize(' 완료')}
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
                      aria-label={localize('할 일 제목')}
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
                      placeholder={localize('할 일 제목')}
                    />
                    <button
                      type="button"
                      className="icon-button"
                      aria-label={task.title + localize(' 삭제')}
                      onClick={() => update((current) => removePlanTask(current, task.id))}
                    >
                      <Icon name="close" size={13} />
                    </button>
                  </div>
                  <details className="task-details">
                    <summary>{localize('완료 기준·선행 작업·순서')}</summary>
                    <label>
                      {localize('작업 검증 명령')}
                      <textarea
                        className="goal-input"
                        rows={2}
                        maxLength={8000}
                        aria-label={task.title + localize(' 검증 명령')}
                        placeholder={localize('예: npm test -- --run regression')}
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
                      aria-label={task.title + localize(' 완료 기준')}
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
                    <ArtifactChecksEditor
                      label={task.title + localize(' 검증 파일')}
                      checks={task.verificationArtifacts ?? []}
                      onChange={(verificationArtifacts) =>
                        update((current) => ({
                          ...current,
                          tasks: current.tasks.map((item) =>
                            item.id === task.id ? { ...item, verificationArtifacts } : item,
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
                          disabled={
                            index + direction < 0 || index + direction >= draft.tasks.length
                          }
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
                          {direction === -1 ? localize('위로') : localize('아래로')}
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
              aria-label={localize('새 할 일')}
              placeholder={localize('할 일 추가')}
              maxLength={500}
              value={taskTitle}
              onChange={(event) => setTaskTitle(event.target.value)}
            />
            <button
              type="submit"
              aria-label={localize('할 일 추가')}
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
            {saving ? localize('저장 중…') : dirty ? localize('계획 저장') : localize('저장됨')}
          </button>
          <p className="subtle-note">
            {localize(
              '체크박스는 직접 관리합니다. Autopilot 검증 기록은 별도로 표시됩니다. 검증 명령은 사용자가 정한 확인 범위만 검사합니다.',
            )}
          </p>
          {dirty && (
            <button
              className="save-plan"
              onClick={() => {
                setDraft(JSON.parse(storedPlan) as Plan);
                setDirty(false);
              }}
            >
              {localize('저장된 계획 불러오기')}
            </button>
          )}
        </>
      )}
      <AutopilotPanel
        session={session}
        tasks={draft.tasks}
        mode={executionMode}
        goal={executionMode === 'simple' ? simpleGoal : draft.goal}
        saving={saving}
        onStart={start}
      />
    </div>
  );
}

function Settings({
  embedded = false,
  config,
  hasMessages,
  running,
  onClose,
  onSave,
}: {
  embedded?: boolean;
  config: ModelConfig;
  hasMessages: boolean;
  running: boolean;
  onClose: () => void;
  onSave: (config: ModelConfig) => Promise<void>;
}) {
  const [draft, setDraft] = useState(config);
  const [key, setKey] = useState('');
  const [status, setStatus] = useState('');
  const [failure, setFailure] = useState('');
  const [busy, setBusy] = useState(false);
  const configured = useWorkspace((s) => s.openrouterConfigured);
  const keySource = useWorkspace((s) => s.openrouterKeySource);
  const envFilePath = useWorkspace((s) => s.envFilePath);
  const envManaged = keySource === 'env_file' || keySource === 'environment';
  const { catalog, catalogError, catalogNotice, catalogLoading, refreshCatalog } = useModelCatalog(
    draft,
    draft.provider === 'openrouter' && configured && nativeDesktop,
  );
  const selectedDescriptor = catalog.find((descriptor) => descriptor.id === draft.model);
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
  function chooseDescriptor(descriptor: ModelDescriptor) {
    if (draft.model === descriptor.id) return;
    const next = selectCatalogModel(draft, descriptor);
    setDraft((value) => selectCatalogModel(value, descriptor));
    setStatus(
      localize(
        '{0} 기본 설정 · 컨텍스트 {1} 토큰을 적용했습니다.',
        descriptor.name,
        next.contextBudgetTokens.toLocaleString(),
      ),
    );
  }
  return (
    <SettingsSurface
      embedded={embedded}
      aria-busy={busy}
      className="settings-dialog"
      ref={dialog}
      onCancel={(event) => {
        if (busy) event.preventDefault();
        else onClose();
      }}
      onClick={(event) => {
        if (!busy && event.target === dialog.current) onClose();
      }}
    >
      <div className="dialog-inner">
        <div className="dialog-header">
          <div>
            <div className="eyebrow">WORKSPACE SETTINGS</div>
            <h2>{localize('모델 연결과 생성 설정')}</h2>
          </div>
          <button className="icon-button" aria-label={localize('설정 닫기')} onClick={onClose}>
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
              {(['llama-server', 'ollama', 'vllm', 'mlx', 'openrouter', 'demo'] as const).map(
                (provider) => (
                  <button
                    type="button"
                    key={provider}
                    className={!draft.managedModelId && draft.provider === provider ? 'chosen' : ''}
                    onClick={() => {
                      if (provider === draft.provider && !draft.managedModelId) return;
                      const {
                        managedModelId: _id,
                        managedModelVersion: _version,
                        ...externalConfig
                      } = draft;
                      setDraft({
                        ...externalConfig,
                        provider,
                        baseUrl:
                          provider === draft.provider
                            ? draft.baseUrl
                            : defaultProviderBaseUrl(provider),
                        model: provider === 'demo' ? 'demo' : '',
                        cloudConsent: false,
                        projectCloudConsent: false,
                      });
                    }}
                  >
                    <Icon
                      name={
                        provider === 'openrouter' ? 'cloud' : provider === 'demo' ? 'chat' : 'chip'
                      }
                    />
                    <span>
                      {provider === 'llama-server' && draft.managedModelId
                        ? localize('외부 llama-server')
                        : providerName(provider)}
                    </span>
                  </button>
                ),
              )}
            </div>
            {isLocalProvider(draft.provider) && !draft.managedModelId && (
              <label className="field">
                {localize('서버 API 주소')}
                <input
                  value={draft.baseUrl}
                  onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })}
                  placeholder={defaultProviderBaseUrl(draft.provider)}
                />
                <small>
                  {localize(
                    'localhost·사설 IP·Tailscale IP/MagicDNS를 지원합니다. 예: http://100.64.1.2:8080/v1 또는 https://gpu.tailnet.ts.net/v1. 서버를 Tailscale IP에 바인딩했다면 같은 IP를 입력하세요. 0.0.0.0은 접속 주소가 아닙니다. 대화와 프로젝트 도구 결과는 선택한 서버로 전달됩니다.',
                  )}
                </small>
              </label>
            )}
            {draft.provider === 'ollama' && (
              <label className="field">
                {localize('응답 후 모델 유지 시간 (초)')}
                <input
                  type="number"
                  min={0}
                  max={86400}
                  value={draft.keepAliveSeconds ?? ''}
                  placeholder={localize('서버 기본값')}
                  onChange={(event) =>
                    setDraft((old) => {
                      const next = { ...old };
                      if (event.target.value === '') delete next.keepAliveSeconds;
                      else next.keepAliveSeconds = Number(event.target.value);
                      return next;
                    })
                  }
                />
                <small>
                  {localize(
                    '0은 응답 후 즉시 해제합니다. 비워 두면 Ollama 기본값을 사용합니다. 설치된 로컬 모델만 지원합니다.',
                  )}
                </small>
              </label>
            )}
            {['ollama', 'vllm', 'mlx'].includes(draft.provider) && (
              <p className="field-hint">
                {localize(
                  '이미 실행 중인 서버에 연결합니다. 설치·프로세스·VRAM 예약은 해당 서버에서 관리합니다.',
                )}
                {draft.provider === 'vllm' &&
                  localize(' 도구 호출은 서버의 tool parser와 자동 도구 선택 설정이 필요합니다.')}
                {draft.provider === 'mlx' &&
                  localize(
                    ' MLX 실행 서버는 Apple Silicon 환경을 사용하며 도구 지원은 모델 템플릿에 따라 다릅니다.',
                  )}
              </p>
            )}
            {draft.provider === 'openrouter' && (
              <div className="key-section">
                <OpenRouterAccount
                  configured={configured}
                  key={`${keySource}:${configured}:${status}`}
                />
                <label className="field">
                  {localize('OpenRouter API 키')}{' '}
                  <span className={configured ? 'key-ok' : ''}>
                    {configured
                      ? keySource === 'env_file'
                        ? localize('.env에서 불러옴')
                        : keySource === 'environment'
                          ? localize('환경 변수에서 불러옴')
                          : localize('OS 저장소에 연결됨')
                      : localize('등록 필요')}
                  </span>
                  <div className="input-action">
                    <input
                      type="password"
                      aria-label={localize('OpenRouter API 키')}
                      disabled={envManaged}
                      autoComplete="off"
                      spellCheck={false}
                      value={key}
                      placeholder={configured ? localize('새 키로 교체') : 'sk-or-…'}
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
                          setStatus(localize('키를 OS 키 저장소에 저장했습니다.'));
                        });
                      }}
                    >
                      {localize('키 저장')}
                    </button>
                    {configured && (
                      <button
                        className="danger-button"
                        type="button"
                        disabled={busy || envManaged}
                        onClick={() => {
                          void operation(async () => {
                            await saveKey(null);
                            useWorkspace.getState().setKeyConfigured(false);
                            setStatus(localize('키를 제거했습니다.'));
                          });
                        }}
                      >
                        {localize('제거')}
                      </button>
                    )}
                  </div>
                  <small>{localize('키는 화면의 영구 저장소·대화 DB에 기록하지 않습니다.')}</small>
                  <small>
                    {localize(
                      'OPENROUTER_API_KEY를 .env에 설정하고 앱을 다시 시작해도 연결할 수 있습니다. 우선순위: 환경 변수 → .env → OS 저장소.',
                    )}
                  </small>
                  {envFilePath && (
                    <small className="env-file-path">
                      {localize('.env 경로: ')}
                      {envFilePath}
                    </small>
                  )}
                  {envManaged && (
                    <small>
                      {localize(
                        '현재 키는 해당 파일 또는 환경 변수에서 변경·제거한 뒤 앱을 다시 시작하세요.',
                      )}
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
                    {localize(
                      '이 대화와 앱 지시문을 OpenRouter 및 선택된 모델 제공자에게 전송하는 데 동의합니다. 사용량에 따라 비용이 발생합니다.',
                    )}
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
                    {localize(
                      '이 대화에서 프로젝트 파일 목록·읽기·검색을 허용하고, 도구가 읽은 파일 내용과 상대 경로를 OpenRouter 및 모델 제공자에게 전송합니다.',
                    )}
                  </span>
                </label>
                <p className="subtle-note">
                  {localize(
                    '제공자 자동 대체와 데이터 수집 허용은 꺼져 있습니다. Autopilot은 실행 전에 비용을 예약하고 OpenRouter가 보고한 실제 비용을 기록합니다.',
                  )}
                </p>
              </div>
            )}
            {draft.managedModelId ? (
              <div className="demo-notice">
                <strong>{draft.model}</strong>
                <p>
                  {localize('로컬 모델 관리에서 등록한 설정 v')}
                  {draft.managedModelVersion}
                  {localize(
                    '을 사용합니다. 서버 주소와 모델 ID는 로딩할 때 자동으로 연결됩니다. 엔진·모델 파일·컨텍스트 길이는 로컬 모델 관리에서 변경하세요.',
                  )}
                </p>
              </div>
            ) : draft.provider !== 'demo' ? (
              <label className="field">
                {localize('모델 ID')}
                <div className="input-action">
                  <input
                    aria-label={localize('모델 ID')}
                    list="model-catalog"
                    value={draft.model}
                    onChange={(event) => {
                      const model = event.target.value;
                      const descriptor = catalog.find((item) => item.id === model);
                      if (descriptor) chooseDescriptor(descriptor);
                      else setDraft({ ...draft, model });
                    }}
                    placeholder={
                      draft.provider === 'openrouter'
                        ? localize('목록에서 선택하거나 정확한 모델 ID 입력')
                        : localize('서버에 로드한 모델 ID')
                    }
                  />
                  <button
                    type="button"
                    disabled={busy || catalogLoading || !nativeDesktop}
                    onClick={() => {
                      void operation(async () => {
                        const result = await refreshCatalog();
                        if (!result) return;
                        if (result.length === 1 && result[0] && !draft.model) {
                          const descriptor = result[0];
                          setDraft((value) =>
                            !value.model &&
                            value.provider === draft.provider &&
                            value.baseUrl === draft.baseUrl
                              ? selectCatalogModel(value, descriptor)
                              : value,
                          );
                        }
                        setStatus(result.length + localize('개 모델을 불러왔습니다.'));
                      });
                    }}
                  >
                    {catalogLoading ? localize('목록 조회 중…') : localize('목록 조회')}
                  </button>
                </div>
                <datalist id="model-catalog">
                  {catalog.map((model) => (
                    <option
                      value={model.id}
                      key={model.id}
                      label={`${model.name}${model.tools === false ? localize(' · 도구 미지원') : model.tools ? localize(' · 도구 지원') : ''}`}
                    >
                      {model.name}
                    </option>
                  ))}
                </datalist>
                {catalogError && (
                  <small role="alert">
                    {catalogError}
                    {localize(' 목록 조회를 눌러 다시 시도하세요.')}
                  </small>
                )}
                {catalogNotice && <small role="status">{catalogNotice}</small>}
                {catalog.length > 0 && draft.model && (
                  <small>
                    {selectedDescriptor?.tools === false
                      ? draft.provider === 'llama-server'
                        ? localize(
                            '현재 llama.cpp Chat template은 도구 호출을 지원하지 않습니다. 도구 사용 템플릿이 내장된 모델을 사용하거나 로컬 모델 설정에서 올바른 Chat template을 지정하세요.',
                          )
                        : localize(
                            '이 모델은 도구 호출을 지원하지 않습니다. 프로젝트 도구를 쓰는 Build 작업에는 도구 지원 모델을 선택하세요.',
                          )
                      : !selectedDescriptor
                        ? localize(
                            '현재 목록에 없는 ID입니다. {0} 모델 ID를 다시 확인하세요.',
                            providerName(draft.provider),
                          )
                        : selectedDescriptor.templateCapabilities
                          ? templateCapabilityLabel(selectedDescriptor)
                          : localize(
                              '목록에 있는 모델 ID입니다. 도구 지원 여부는 모델별로 다릅니다.',
                            )}
                  </small>
                )}
              </label>
            ) : (
              <div className="demo-notice">
                <Icon name="info" size={17} />
                {localize(
                  'UI와 저장·중지 흐름을 확인하는 고정 응답입니다. 실제 LLM을 호출하지 않습니다.',
                )}
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
                  {localize('기본값 사용')}
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
                  {localize('기본값 사용')}
                </label>
              </div>
              <div className={`field${draft.autoMaxTokens ? ' generation-value-disabled' : ''}`}>
                <label htmlFor="max-output-token-setting">
                  {localize('호출당 최대 출력 토큰')}
                </label>
                <input
                  id="max-output-token-setting"
                  aria-label={localize('최대 출력 토큰')}
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
                {localize(
                  '출력 토큰 자동 선택 · 앱 컨텍스트 예산의 20%를 출력에 예약하고 80%를 입력에 사용합니다.',
                )}
              </span>
            </label>
            <label className="field">
              {localize('앱 컨텍스트 예산 (토큰)')}
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
                  ? localize(
                      '입력 {0} · 출력 {1} 토큰으로 자동 배분합니다.',
                      Math.max(0, draft.contextBudgetTokens - draft.maxTokens).toLocaleString(),
                      draft.maxTokens.toLocaleString(),
                    )
                  : localize(
                      '입력 추정량 + 최대 출력 + 여유분을 검사합니다. 엔진의 컨텍스트 길이를 바꾸지는 않습니다.',
                    )}
              </small>
            </label>
            <label className="eco-setting">
              <div>
                <span>
                  <Icon name="leaf" size={18} />
                  <strong>Eco</strong>
                </span>
                <p>
                  {localize('반복과 군더더기를 줄이도록 모델에 요청합니다.')}
                  <br />
                  {localize(
                    '작업 중 완료된 기록을 작은 단위로 LLM 요약합니다. 최근 결과와 원문은 유지하며 큰 결과는 필요할 때 다시 불러옵니다.',
                  )}
                </p>
              </div>
              <input
                type="checkbox"
                aria-label={localize('Eco 모드')}
                checked={draft.eco}
                onChange={(event) => setDraft({ ...draft, eco: event.target.checked })}
              />
            </label>
            {!nativeDesktop && (
              <p className="subtle-note">
                {localize(
                  '브라우저에서는 데모 미리보기만 동작합니다. 실제 연결 설정은 데스크톱 앱에서 적용하세요.',
                )}
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
                ? localize('대화 기록을 유지하고 다음 요청부터 선택한 모델과 설정을 사용합니다.')
                : localize('이 설정은 새 대화에 적용됩니다.')}
            </span>
            <button
              type="submit"
              className="primary-button"
              disabled={busy || running || (!nativeDesktop && draft.provider !== 'demo')}
            >
              {busy ? localize('처리 중…') : localize('설정 적용')}
            </button>
          </div>
        </form>
      </div>
    </SettingsSurface>
  );
}
