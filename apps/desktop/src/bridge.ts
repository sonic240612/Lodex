import { Channel, invoke, isTauri } from '@tauri-apps/api/core';
import type { RegisteredSkill, SkillDialect } from '@lodex/skills';
import type { McpConfig, McpRegistration, McpImport } from '@lodex/mcp';
import type { OAuthPreparation, OAuthStatus } from '@lodex/mcp';
import {
  type TelegramStatus,
  type TelegramConfig,
  type WorktreeRecord,
  makeCommand,
  defaultPlan,
  type Command,
  type CommandInput,
  type CommandResult,
  type DomainEvent,
  type ModelDescriptor,
  type Session,
  type Snapshot,
  type Project,
  deleteSessionsSchema,
  type DeleteSessionsResult,
  type DeleteSessions,
  type EditAction,
  type ApprovalAction,
  defaultPermissionMode,
  localUrlSchema,
  type RuntimeSnapshot,
  type LocalProfileInput,
  type LocalProfile,
  type RuntimeSettings,
  type McpContentInput,
  type McpContentPreview,
} from '@lodex/contracts';
export async function telegramStatus(): Promise<TelegramStatus> {
  if (!nativeDesktop)
    return {
      configured: false,
      config: { enabled: false, sessionId: null, allowBuild: false, transmissionConsent: false },
      running: false,
      pending: 0,
      unknownDeliveries: 0,
    };
  return invoke('daemon_request', { method: 'GET', path: '/v1/telegram', body: null });
}
export async function telegramAction(
  action: 'config' | 'pair' | 'approve' | 'unpair',
  body: TelegramConfig | { userId: number; chatId: number } | null,
): Promise<TelegramStatus | { code: string; expiresAt: number }> {
  if (!nativeDesktop) throw new Error('Telegram 연결은 데스크톱 앱에서 설정하세요.');
  return invoke('daemon_request', { method: 'POST', path: '/v1/telegram/' + action, body });
}
export async function saveTelegramToken(key: string | null): Promise<TelegramStatus> {
  if (!nativeDesktop) throw new Error('Telegram 토큰은 데스크톱 앱에서 저장할 수 있습니다.');
  return invoke('set_telegram_token', { key });
}
export async function worktreeList(): Promise<{ records: WorktreeRecord[] }> {
  if (!nativeDesktop) return { records: [] };
  return invoke('daemon_request', { method: 'GET', path: '/v1/worktrees', body: null });
}
export async function createWorktree(
  projectId: string,
): Promise<{ record: WorktreeRecord; project: Project }> {
  if (!nativeDesktop) throw new Error('worktree 생성은 데스크톱 앱에서 사용할 수 있습니다.');
  return invoke('daemon_request', { method: 'POST', path: '/v1/worktrees', body: { projectId } });
}
export const nativeDesktop = isTauri();
export type { McpContentPreview } from '@lodex/contracts';
export async function previewMcpContent(input: McpContentInput): Promise<McpContentPreview> {
  return invoke('daemon_request', { method: 'POST', path: '/v1/mcp/content', body: input });
}
export async function prepareMcpOAuth(input: {
  resourceUrl: string;
  clientId: string;
  scopes?: string[];
  authorizationServer?: string;
}): Promise<OAuthPreparation> {
  return invoke('daemon_request', { method: 'POST', path: '/v1/mcp/oauth/prepare', body: input });
}
export async function beginMcpOAuth(
  preparation: OAuthPreparation,
): Promise<{ id: string; authorizationUrl: string; redirectUri: string; expiresAt: number }> {
  return invoke('daemon_request', {
    method: 'POST',
    path: '/v1/mcp/oauth/begin',
    body: { preparationId: preparation.id, approvedOrigins: preparation.origins },
  });
}
export async function statusMcpOAuth(id: string): Promise<OAuthStatus> {
  return invoke('daemon_request', { method: 'POST', path: '/v1/mcp/oauth/status', body: { id } });
}
export async function cancelMcpOAuth(id: string): Promise<OAuthStatus> {
  return invoke('daemon_request', { method: 'POST', path: '/v1/mcp/oauth/cancel', body: { id } });
}
export async function disconnectMcpOAuth(resourceUrl: string, clientId: string): Promise<void> {
  await invoke('daemon_request', {
    method: 'POST',
    path: '/v1/mcp/oauth/disconnect',
    body: { resourceUrl, clientId },
  });
}
export async function openMcpLogin(url: string): Promise<void> {
  await invoke('open_external', { url });
}
export async function registeredMcp(): Promise<McpRegistration[]> {
  const result = await invoke<{ servers: McpRegistration[] }>('daemon_request', {
    method: 'GET',
    path: '/v1/mcp',
    body: null,
  });
  return result.servers;
}
export async function importMcp(text: string, cwd?: string): Promise<McpImport[]> {
  const result = await invoke<{ candidates: McpImport[] }>('daemon_request', {
    method: 'POST',
    path: '/v1/mcp/import',
    body: { text, ...(cwd ? { cwd } : {}) },
  });
  return result.candidates;
}
export async function registerMcp(
  config: McpConfig,
  previous?: McpRegistration,
): Promise<McpRegistration> {
  const result = await invoke<{ server: McpRegistration }>('daemon_request', {
    method: 'POST',
    path: '/v1/mcp/register',
    body: {
      config,
      approved: true,
      ...(previous ? { id: previous.id, expectedRevision: previous.revision } : {}),
    },
  });
  return result.server;
}
export async function removeMcp(server: McpRegistration): Promise<void> {
  await invoke('daemon_request', {
    method: 'POST',
    path: '/v1/mcp/remove',
    body: { id: server.id, expectedRevision: server.revision },
  });
}
type Listener = (event: DomainEvent) => void;
const previewSessions: Session[] = [];
const previewDeleted: string[] = [];
const previewListeners = new Set<Listener>();
let previewSeq = 0;
function previewChanged(session: Session): void {
  session.version++;
  session.updatedAt = new Date().toISOString();
  const event: DomainEvent = {
    seq: ++previewSeq,
    protocolVersion: 1,
    type: 'session_changed',
    sessionId: session.id,
    session: structuredClone(session),
    createdAt: session.updatedAt,
  };
  for (const listener of previewListeners) listener(event);
}
async function previewCommand(command: Command): Promise<CommandResult> {
  let session = previewSessions.find((s) => s.id === command.sessionId);
  if (command.type === 'create_session') {
    const now = new Date().toISOString();
    session = {
      id: command.sessionId,
      title: command.title,
      version: 0,
      createdAt: now,
      updatedAt: now,
      config: { ...command.config, provider: 'demo', model: 'demo' },
      ...(command.routing ? { routing: command.routing } : {}),
      mode: command.mode,
      permissionMode: defaultPermissionMode(),
      projectId: command.projectId,
      plan: defaultPlan(),
      messages: [],
      run: null,
    };
    previewSessions.unshift(session);
  } else {
    if (!session) throw new Error('대화를 찾을 수 없습니다.');
    if (command.type === 'save_plan') session.plan = command.plan;
    else if (command.type === 'set_permission_mode') session.permissionMode = command.mode;
    else if (
      command.type === 'start_autopilot' ||
      command.type === 'start_goal' ||
      command.type === 'resume_goal'
    )
      throw new Error('자동 실행은 데스크톱 앱에서 사용할 수 있습니다.');
    else if (command.type === 'stop_autopilot') {
      if (session.autopilot) session.autopilot.status = 'cancelled';
    } else if (command.type === 'set_mode') session.mode = command.mode;
    else if (command.type === 'compact_context') {
      const complete = session.messages.filter((message) => message.status === 'complete');
      if (!complete.length) throw new Error('압축할 완료된 대화 기록이 없습니다.');
      session.contextCompaction = {
        throughMessageId: complete.at(-1)!.id,
        summary: complete
          .map((message) => `${message.role}: ${message.content.slice(0, 500)}`)
          .join('\n'),
        createdAt: new Date().toISOString(),
        reason: 'manual',
        compactedMessageCount: complete.length,
        originalEstimateTokens: 0,
        compactedEstimateTokens: 0,
      };
    } else if (command.type === 'configure_execution')
      throw new Error('명령 실행은 데스크톱 앱에서 설정할 수 있습니다.');
    else if (command.type === 'adopt_plan') {
      const proposal = session.messages
        .flatMap((m) => m.activities ?? [])
        .find((a) => a.id === command.activityId)?.planProposal;
      if (!proposal || proposal.status !== 'proposed') throw new Error('검토할 계획이 없습니다.');
      session.plan = proposal.plan;
      proposal.status = 'adopted';
    } else if (command.type === 'configure_routing') {
      if (session.messages.length)
        throw new Error('역할별 모델 설정을 바꾸려면 새 대화를 만드세요.');
      session.routing = command.routing;
    } else if (command.type === 'configure_session')
      session.config = { ...command.config, provider: 'demo', model: 'demo' };
    else if (command.type === 'send_message') {
      const now = new Date().toISOString();
      session.title = command.content.slice(0, 60);
      session.messages.push({
        id: crypto.randomUUID(),
        role: 'user',
        content: command.content,
        createdAt: now,
        status: 'complete',
        error: null,
        usage: null,
      });
      session.messages.push({
        id: crypto.randomUUID(),
        role: 'assistant',
        activities: [
          {
            id: crypto.randomUUID(),
            kind: 'thinking',
            label: 'Thinking · 표시 예제',
            status: 'completed',
            text: '접기·펼치기를 확인하기 위한 UI 예제입니다. 실제 모델의 thinking이 아닙니다.',
          },
          {
            id: crypto.randomUUID(),
            kind: 'tool',
            label: 'read_file · 표시 예제',
            status: 'completed',
            arguments: '{"path":"example.ts"}',
            text: '도구 결과 카드의 UI 예제입니다. 실제 파일을 읽지 않았습니다.',
          },
          {
            id: crypto.randomUUID(),
            kind: 'tool',
            label: 'propose_edit · 표시 예제',
            status: 'completed',
            text: '변경 검토 화면의 UI 예제입니다.',
            edit: {
              path: 'example.ts',
              beforeHash: '0'.repeat(64),
              afterHash: '1'.repeat(64),
              oldText: '1',
              newText: '2',
              diff: '--- a/example.ts\n+++ b/example.ts\n@@ -1 +1 @@\n-const value = 1;\n+const value = 2;\n',
              status: 'proposed',
            },
          },
          {
            id: crypto.randomUUID(),
            kind: 'tool',
            label: 'propose_changes · 표시 예제',
            status: 'completed',
            text: '묶음 검토 UI 예제입니다. 실제 파일 변경이 아닙니다.',
            changes: {
              status: 'partial',
              files: [
                {
                  path: 'example.ts',
                  beforeHash: '0'.repeat(64),
                  afterHash: '1'.repeat(64),
                  oldText: '1',
                  newText: '2',
                  diff: '--- a/example.ts\n+++ b/example.ts\n@@ -1 +1 @@\n-const value = 1;\n+const value = 2;\n',
                  status: 'proposed',
                },
                {
                  kind: 'create',
                  path: 'example.test.ts',
                  content: 'expect(value).toBe(2);\n',
                  afterHash: '2'.repeat(64),
                  stagingId: crypto.randomUUID(),
                  diff: '--- /dev/null\n+++ b/example.test.ts\n@@ -0,0 +1 @@\n+expect(value).toBe(2);\n',
                },
              ],
              observations: [
                { path: 'example.ts', state: 'after' },
                { path: 'example.test.ts', state: 'before' },
              ],
            },
          },
        ],
        content:
          '## UI 미리보기\n\n**마크다운**과 `코드` 서식을 확인할 수 있습니다.\n\n- [x] 대화 표시\n- [ ] 실제 모델 연결\n\n```ts\nconst greeting = "안녕하세요";\n```\n\n| 기능 | 상태 |\n| --- | --- |\n| 마크다운 | 사용 가능 |\n| 모델 응답 | 데스크톱에서 연결 |\n\n실제 모델 연결·영구 저장·스트리밍은 데스크톱 앱에서 사용할 수 있습니다.',
        createdAt: now,
        status: 'complete',
        error: null,
        usage: null,
      });
    }
  }
  if (!session) throw new Error('대화를 생성하지 못했습니다.');
  previewChanged(session);
  return { commandId: command.commandId, session: structuredClone(session), replayed: false };
}
export async function snapshot(): Promise<Snapshot> {
  return nativeDesktop
    ? invoke('daemon_request', { method: 'GET', path: '/v1/state', body: null })
    : {
        protocolVersion: 1,
        sessions: structuredClone(previewSessions),
        deletedSessionIds: [...previewDeleted],
        projects: [],
        lastSeq: previewSeq,
        openrouterConfigured: false,
      };
}
export async function sendCommand(input: CommandInput): Promise<CommandResult> {
  const command = makeCommand(input);
  return nativeDesktop
    ? invoke('daemon_request', { method: 'POST', path: '/v1/commands', body: command })
    : previewCommand(command);
}
export async function deleteSessions(
  targets: DeleteSessions['targets'],
): Promise<DeleteSessionsResult> {
  const command = deleteSessionsSchema.parse({
    protocolVersion: 1,
    commandId: crypto.randomUUID(),
    actor: 'desktop',
    policyVersion: 1,
    type: 'delete_sessions',
    targets,
  });
  if (nativeDesktop)
    return invoke('daemon_request', { method: 'POST', path: '/v1/sessions/delete', body: command });
  for (const target of targets) {
    const session = previewSessions.find((s) => s.id === target.sessionId);
    if (!session || session.version !== target.expectedVersion)
      throw new Error('대화가 변경되었습니다. 다시 선택해 주세요.');
  }
  const ids = targets.map((t) => t.sessionId);
  for (let i = previewSessions.length - 1; i >= 0; i--)
    if (ids.includes(previewSessions[i]!.id)) previewSessions.splice(i, 1);
  previewDeleted.push(...ids);
  const result: DeleteSessionsResult = {
    commandId: command.commandId,
    replayed: false,
    event: {
      seq: ++previewSeq,
      protocolVersion: 1,
      type: 'sessions_deleted',
      sessionIds: ids,
      createdAt: new Date().toISOString(),
    },
  };
  for (const listener of previewListeners) listener(result.event);
  return result;
}
export async function pickProjectFolder(): Promise<string | null> {
  if (!nativeDesktop) throw new Error('폴더 선택은 데스크톱 앱에서 사용할 수 있습니다.');
  return invoke('pick_project_folder');
}
export async function registeredSkills(): Promise<RegisteredSkill[]> {
  if (!nativeDesktop) throw new Error('스킬 등록은 데스크톱 앱에서 사용할 수 있습니다.');
  const result = await invoke<{ skills: RegisteredSkill[] }>('daemon_request', {
    method: 'GET',
    path: '/v1/skills',
    body: null,
  });
  return result.skills;
}
export async function registerSkill(input: {
  path: string;
  dialect: SkillDialect;
  id?: string;
  expectedRevision?: string;
}): Promise<RegisteredSkill> {
  if (!nativeDesktop) throw new Error('데스크톱 앱에서 스킬 폴더를 선택하세요.');
  const result = await invoke<{ skill: RegisteredSkill }>('daemon_request', {
    method: 'POST',
    path: '/v1/skills/register',
    body: input,
  });
  return result.skill;
}
export async function removeSkill(
  id: string,
  expectedRevision: string,
): Promise<RegisteredSkill[]> {
  if (!nativeDesktop) throw new Error('데스크톱 앱에서 스킬을 관리하세요.');
  const result = await invoke<{ skills: RegisteredSkill[] }>('daemon_request', {
    method: 'POST',
    path: '/v1/skills/remove',
    body: { id, expectedRevision },
  });
  return result.skills;
}
export async function editAction(action: EditAction): Promise<Session> {
  if (!nativeDesktop) throw new Error('실제 파일 변경은 데스크톱 앱에서 사용할 수 있습니다.');
  const result = await invoke<{ session: Session }>('daemon_request', {
    method: 'POST',
    path: '/v1/edits',
    body: action,
  });
  return result.session;
}
export async function approvalAction(action: ApprovalAction): Promise<Session> {
  if (!nativeDesktop) throw new Error('실제 권한 결정은 데스크톱 앱에서 사용할 수 있습니다.');
  const result = await invoke<{ session: Session }>('daemon_request', {
    method: 'POST',
    path: '/v1/approvals',
    body: action,
  });
  return result.session;
}
export async function checkExecution(image: string): Promise<{ host: string; imageId: string }> {
  if (!nativeDesktop) throw new Error('데스크톱 앱에서 Docker를 연결하세요.');
  return invoke('daemon_request', {
    method: 'GET',
    path: '/v1/execution/check?' + new URLSearchParams({ image }),
    body: null,
  });
}
export async function runtimeSnapshot(): Promise<RuntimeSnapshot> {
  if (!nativeDesktop) throw new Error('로컬 모델 관리는 데스크톱 앱에서 사용할 수 있습니다.');
  return invoke('daemon_request', { method: 'GET', path: '/v1/runtime', body: null });
}
export async function saveLocalProfile(profile: LocalProfileInput): Promise<LocalProfile> {
  if (!nativeDesktop) throw new Error('데스크톱 앱에서 모델을 등록하세요.');
  const result = await invoke<{ profile: LocalProfile }>('daemon_request', {
    method: 'POST',
    path: '/v1/runtime/profiles',
    body: profile,
  });
  return result.profile;
}
export async function runtimeAction(
  profileId: string,
  action: 'load' | 'unload' | 'remove',
): Promise<RuntimeSnapshot> {
  if (!nativeDesktop) throw new Error('데스크톱 앱에서 모델을 관리하세요.');
  return invoke('daemon_request', {
    method: 'POST',
    path: '/v1/runtime/action',
    body: { profileId, action },
  });
}
export async function configureRuntime(settings: RuntimeSettings): Promise<RuntimeSnapshot> {
  if (!nativeDesktop) throw new Error('데스크톱 앱에서 설정하세요.');
  return invoke('daemon_request', { method: 'POST', path: '/v1/runtime/settings', body: settings });
}
export async function pickRuntimeFile(kind: 'engine' | 'model'): Promise<string | null> {
  if (!nativeDesktop) throw new Error('데스크톱 앱에서 파일을 선택하세요.');
  return invoke('pick_runtime_file', { kind });
}
export async function cleanupCommands(sessionId: string): Promise<Session> {
  if (!nativeDesktop) throw new Error('데스크톱 앱에서 정리하세요.');
  const result = await invoke<{ session: Session }>('daemon_request', {
    method: 'POST',
    path: '/v1/execution/cleanup',
    body: { sessionId },
  });
  return result.session;
}
export async function registerProject(path: string): Promise<Project> {
  if (!nativeDesktop) throw new Error('프로젝트 등록은 데스크톱 앱에서 사용할 수 있습니다.');
  const result = await invoke<{ project: Project }>('daemon_request', {
    method: 'POST',
    path: '/v1/projects',
    body: { path },
  });
  return result.project;
}
export async function models(provider: string, baseUrl: string): Promise<ModelDescriptor[]> {
  if (provider === 'llama-server') {
    const parsed = localUrlSchema.safeParse(baseUrl);
    if (!parsed.success) throw new Error(parsed.error.issues[0]!.message);
    baseUrl = parsed.data;
  }
  if (!nativeDesktop)
    return [
      {
        id: 'demo',
        name: 'UI 미리보기',
        contextLength: null,
        maxCompletionTokens: null,
        defaultTemperature: null,
        defaultTopP: null,
        tools: false,
        pricing: null,
      },
    ];
  const result = await invoke<{ models: ModelDescriptor[] }>('daemon_request', {
    method: 'GET',
    path: '/v1/models?' + new URLSearchParams({ provider, baseUrl }).toString(),
    body: null,
  });
  return result.models;
}
export async function saveKey(key: string | null): Promise<void> {
  if (!nativeDesktop) throw new Error('API 키는 데스크톱 앱에서 저장할 수 있습니다.');
  await invoke('set_openrouter_key', { key });
}
export async function subscribe(
  after: number,
  onEvent: Listener,
  onDisconnected: () => void,
): Promise<() => void> {
  if (!nativeDesktop) {
    previewListeners.add(onEvent);
    return () => {
      previewListeners.delete(onEvent);
    };
  }
  const channel = new Channel<DomainEvent | { type: 'bridge_disconnected' }>();
  channel.onmessage = (event) => {
    if (event.type === 'bridge_disconnected') onDisconnected();
    else onEvent(event);
  };
  await invoke('connect_events', { after, channel });
  return () => {
    channel.onmessage = () => undefined;
    void invoke('disconnect_events');
  };
}
