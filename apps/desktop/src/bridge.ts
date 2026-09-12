import { Channel, invoke, isTauri } from '@tauri-apps/api/core';
import {
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
  localUrlSchema,
  type RuntimeSnapshot,
  type LocalProfileInput,
  type LocalProfile,
  type RuntimeSettings,
} from '@lodex/contracts';
export const nativeDesktop = isTauri();
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
      mode: command.mode,
      projectId: command.projectId,
      plan: defaultPlan(),
      messages: [],
      run: null,
    };
    previewSessions.unshift(session);
  } else {
    if (!session) throw new Error('대화를 찾을 수 없습니다.');
    if (command.type === 'save_plan') session.plan = command.plan;
    else if (command.type === 'start_autopilot')
      throw new Error('Autopilot은 데스크톱 앱의 로컬 모델에서 사용할 수 있습니다.');
    else if (command.type === 'set_mode') session.mode = command.mode;
    else if (command.type === 'configure_execution')
      throw new Error('명령 실행은 데스크톱 앱에서 설정할 수 있습니다.');
    else if (command.type === 'adopt_plan') {
      const proposal = session.messages
        .flatMap((m) => m.activities ?? [])
        .find((a) => a.id === command.activityId)?.planProposal;
      if (!proposal || proposal.status !== 'proposed') throw new Error('검토할 계획이 없습니다.');
      session.plan = proposal.plan;
      proposal.status = 'adopted';
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
export async function editAction(action: EditAction): Promise<Session> {
  if (!nativeDesktop) throw new Error('실제 파일 변경은 데스크톱 앱에서 사용할 수 있습니다.');
  const result = await invoke<{ session: Session }>('daemon_request', {
    method: 'POST',
    path: '/v1/edits',
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
    return [{ id: 'demo', name: 'UI 미리보기', contextLength: null, tools: false }];
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
