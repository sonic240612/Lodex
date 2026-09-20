import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import type { RegisteredSkill } from '@lodex/skills';
import type { McpRegistration } from '@lodex/mcp';
import {
  AppError,
  emptyUsage,
  defaultPlan,
  modelConfigSchema,
  agentRoutingConfigSchema,
  resolveModelConfig,
  planSchema,
  type Command,
  type CommandResult,
  type ContextManifest,
  type DomainEvent,
  type Session,
  type Snapshot,
  type Usage,
  type Project,
  type Activity,
  type InferenceMessage,
  type DeleteSessions,
  type DeleteSessionsResult,
  type SessionsDeletedEvent,
  type EditAction,
  type ChangeSet,
  type ChangeStatus,
  activityProposal,
  defaultExecutionConfig,
  executionConfigSchema,
  type CommandExecution,
  type AutopilotState,
  prepareAutopilot,
  prepareGoal,
  resumeGoal,
  runtimeSettingsSchema,
  type RuntimeSettings,
  type LocalProfile,
  skillSelectionsSchema,
  mcpSelectionsSchema,
  mcpAttachmentSchema,
  type McpContextAttachment,
  permissionModeSchema,
  defaultPermissionMode,
  type ApprovalAction,
} from '@lodex/contracts';

// Additive JSON fields are defaulted on all read paths, including old SSE events.
function hydrate(session: Session): Session {
  const permissionMode = permissionModeSchema.parse(
    session.permissionMode ?? (session.autoApprove ? 'auto' : defaultPermissionMode()),
  );
  const { autoApprove: _legacyAutoApprove, ...stored } = session;
  return {
    ...stored,
    permissionMode,
    mode: session.mode ?? 'build',
    routing: agentRoutingConfigSchema.parse(session.routing ?? {}),
    mcp: mcpSelectionsSchema.parse(session.mcp ?? []),
    mcpCloudConsent: session.mcpCloudConsent ?? false,
    mcpAttachments: (session.mcpAttachments ?? []).map((value) => mcpAttachmentSchema.parse(value)),
    hasMcpHistory:
      session.hasMcpHistory ??
      !!(
        session.run?.context?.mcpTools?.length ||
        session.messages.some((m) => m.activities?.some((a) => a.mcpCall))
      ),
    skills: skillSelectionsSchema.parse(session.skills ?? []),
    skillCloudConsent: session.skillCloudConsent ?? false,
    hasSkillHistory:
      session.hasSkillHistory ??
      !!(
        session.run?.context?.skillCatalog?.includedIds.length ||
        session.messages.some((message) =>
          message.activities?.some((activity) => activity.skillRead),
        )
      ),
    execution: executionConfigSchema.parse(session.execution ?? {}),
    projectId: session.projectId ?? null,
    config: modelConfigSchema.parse(session.config),
    messages: session.messages.map((message) => ({
      ...message,
      ...(message.inferenceConfig
        ? { inferenceConfig: modelConfigSchema.parse(message.inferenceConfig) }
        : {}),
    })),
    plan: planSchema.parse(session.plan),
  };
}

export interface RunUpdate {
  autopilot?: AutopilotState;
  sessionId: string;
  runId: string;
  text?: string;
  usage?: Partial<Usage>;
  status?: 'completed' | 'cancelled' | 'failed' | 'interrupted';
  error?: string;
  activities?: Activity[];
  continuation?: InferenceMessage[];
  context?: ContextManifest;
}
export class StorageEngine {
  private db: DatabaseSync;
  private closed = false;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(
      'PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;',
    );
    const row = this.db.prepare('PRAGMA user_version').get() as { user_version: number };
    if (row.user_version > 14) {
      this.db.close();
      throw new AppError(
        'DATABASE_VERSION',
        '이 데이터는 더 새로운 Lodex 버전에서 생성되었습니다.',
      );
    }
    if (row.user_version === 0)
      this.db.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE sessions (id TEXT PRIMARY KEY, document TEXT NOT NULL);
      CREATE TABLE events (seq INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, document TEXT NOT NULL);
      CREATE TABLE commands (id TEXT PRIMARY KEY, hash TEXT NOT NULL, result TEXT NOT NULL);
      PRAGMA user_version=1;
      COMMIT;
    `);
    if (row.user_version < 2)
      this.db.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE projects (id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, document TEXT NOT NULL);
      PRAGMA user_version=2;
      COMMIT;
    `);
    if (row.user_version < 3)
      this.db.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS deleted_sessions (id TEXT PRIMARY KEY);
      PRAGMA user_version=3;
      COMMIT;
    `);
    // v4 persisted configs can address private servers; edits can be reverted.
    // Older builds cannot interpret these values and must reject this database.
    if (row.user_version < 4) this.db.exec('PRAGMA user_version=4;');
    // v5 adds grouped file changes and recoverable partial outcomes.
    if (row.user_version < 5) this.db.exec('PRAGMA user_version=5;');
    // v6 enforces Plan mode and persists reviewed plan proposals.
    if (row.user_version < 6) this.db.exec('PRAGMA user_version=6;');
    // v7 records owned command containers, including cleanup after cancellation/restart.
    if (row.user_version < 7) this.db.exec('PRAGMA user_version=7;');
    if (row.user_version < 8) this.db.exec('PRAGMA user_version=8;');
    if (row.user_version < 9)
      this.db.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE runtime_profiles (id TEXT PRIMARY KEY, document TEXT NOT NULL);
      CREATE TABLE runtime_settings (id INTEGER PRIMARY KEY CHECK (id=1), document TEXT NOT NULL);
      PRAGMA user_version=9;
      COMMIT;
    `);
    if (row.user_version < 10)
      this.db.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE skill_registrations (id TEXT PRIMARY KEY, document TEXT NOT NULL);
      PRAGMA user_version=10;
      COMMIT;
    `);
    if (row.user_version < 11)
      this.db.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE mcp_registrations (id TEXT PRIMARY KEY, document TEXT NOT NULL);
      PRAGMA user_version=11;
      COMMIT;
    `);
    if (row.user_version < 12) this.db.exec('PRAGMA user_version=12;');
    if (row.user_version < 13) this.db.exec('PRAGMA user_version=13;');
    if (row.user_version < 14)
      this.db.exec(`BEGIN IMMEDIATE;
      CREATE TABLE integration_state (name TEXT PRIMARY KEY, version INTEGER NOT NULL, document TEXT NOT NULL);
      PRAGMA user_version=14; COMMIT;`);
  }
  integration(name: string): { version: number; document: unknown } | null {
    const row = this.db
      .prepare('SELECT version,document FROM integration_state WHERE name=?')
      .get(name) as { version: number; document: string } | undefined;
    return row ? { version: row.version, document: JSON.parse(row.document) } : null;
  }
  saveIntegration(name: string, expectedVersion: number, document: unknown): number {
    if (
      !['telegram', 'worktrees'].includes(name) ||
      Buffer.byteLength(JSON.stringify(document)) > 2097152
    )
      throw new AppError('INTEGRATION_STATE', '연동 기록 형식 또는 크기를 확인하세요.');
    return this.transaction(() => {
      const current = this.integration(name);
      if ((current?.version ?? 0) !== expectedVersion)
        throw new AppError('VERSION_CONFLICT', '연동 상태가 변경되었습니다.', 409);
      const version = expectedVersion + 1;
      this.db
        .prepare(
          'INSERT INTO integration_state(name,version,document) VALUES(?,?,?) ON CONFLICT(name) DO UPDATE SET version=excluded.version,document=excluded.document',
        )
        .run(name, version, JSON.stringify(document));
      return version;
    });
  }
  close(): void {
    if (!this.closed) {
      this.db.close();
      this.closed = true;
    }
  }
  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  snapshot(): Omit<Snapshot, 'openrouterConfigured'> {
    const rows = this.db.prepare('SELECT document FROM sessions').all() as { document: string }[];
    const seq = this.db.prepare('SELECT COALESCE(MAX(seq),0) AS seq FROM events').get() as {
      seq: number;
    };
    return {
      protocolVersion: 1,
      projects: this.projects(),
      deletedSessionIds: (
        this.db.prepare('SELECT id FROM deleted_sessions').all() as { id: string }[]
      ).map((r) => r.id),
      sessions: rows
        .map((r) => hydrate(JSON.parse(r.document) as Session))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
      lastSeq: seq.seq,
    };
  }
  session(id: string): Session {
    const row = this.db.prepare('SELECT document FROM sessions WHERE id=?').get(id) as
      { document: string } | undefined;
    if (!row) throw new AppError('NOT_FOUND', '대화를 찾을 수 없습니다.', 404);
    return hydrate(JSON.parse(row.document) as Session);
  }
  events(after: number, limit = 200): DomainEvent[] {
    return (
      this.db
        .prepare('SELECT seq, document FROM events WHERE seq>? ORDER BY seq LIMIT ?')
        .all(after, limit) as { seq: number; document: string }[]
    ).map((row) => {
      const event = JSON.parse(row.document) as DomainEvent;
      return event.type === 'session_changed'
        ? { ...event, session: hydrate(event.session), seq: row.seq }
        : { ...event, seq: row.seq };
    });
  }
  projects(): Project[] {
    return (
      this.db.prepare('SELECT document FROM projects ORDER BY rowid').all() as {
        document: string;
      }[]
    ).map((row) => JSON.parse(row.document) as Project);
  }
  localProfiles(): LocalProfile[] {
    return (
      this.db.prepare('SELECT document FROM runtime_profiles ORDER BY rowid').all() as {
        document: string;
      }[]
    ).map((r) => JSON.parse(r.document) as LocalProfile);
  }
  registeredSkills(): RegisteredSkill[] {
    return (
      this.db.prepare('SELECT document FROM skill_registrations ORDER BY rowid').all() as {
        document: string;
      }[]
    ).map((row) => JSON.parse(row.document) as RegisteredSkill);
  }
  registeredMcp(): McpRegistration[] {
    return (
      this.db.prepare('SELECT document FROM mcp_registrations ORDER BY rowid').all() as {
        document: string;
      }[]
    ).map((row) => JSON.parse(row.document) as McpRegistration);
  }
  private assertMcpIdle(id: string): void {
    if (
      this.snapshot().sessions.some(
        (s) => s.run?.status === 'running' && s.mcp?.some((m) => m.serverId === id),
      )
    )
      throw new AppError('BUSY', '사용 중인 MCP 서버는 실행이 끝난 뒤 변경하세요.', 409);
  }
  saveRegisteredMcp(value: McpRegistration, expectedRevision?: string): McpRegistration {
    return this.transaction(() => {
      const previous = this.registeredMcp().find((entry) => entry.id === value.id);
      if (previous?.revision !== expectedRevision)
        throw new AppError(
          'VERSION_CONFLICT',
          'MCP 등록 정보가 변경되었습니다. 목록을 다시 불러오세요.',
          409,
        );
      this.assertMcpIdle(value.id);
      this.db
        .prepare(
          'INSERT INTO mcp_registrations(id,document) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET document=excluded.document',
        )
        .run(value.id, JSON.stringify(value));
      return value;
    });
  }
  removeRegisteredMcp(id: string, expectedRevision: string): void {
    this.transaction(() => {
      const value = this.registeredMcp().find((entry) => entry.id === id);
      if (!value || value.revision !== expectedRevision)
        throw new AppError('VERSION_CONFLICT', 'MCP 등록 정보가 변경되었습니다.', 409);
      this.assertMcpIdle(id);
      this.db.prepare('DELETE FROM mcp_registrations WHERE id=?').run(id);
    });
  }
  private assertSkillIdle(id: string): void {
    const selectedByRunningSession = this.snapshot().sessions.some(
      (session) =>
        session.run?.status === 'running' && session.skills?.some((skill) => skill.id === id),
    );
    if (selectedByRunningSession)
      throw new AppError('BUSY', '사용 중인 스킬은 응답이 끝나거나 중지된 뒤 변경하세요.', 409);
  }
  saveRegisteredSkill(skill: RegisteredSkill, expectedRevision?: string): RegisteredSkill {
    return this.transaction(() => {
      const registrations = this.registeredSkills();
      const pathKey = (path: string) => (process.platform === 'win32' ? path.toLowerCase() : path);
      const sameId = registrations.find((entry) => entry.id === skill.id);
      const samePath = registrations.find(
        (entry) => pathKey(entry.source.rootPath) === pathKey(skill.source.rootPath),
      );
      const previous = sameId ?? samePath;
      if (
        (sameId && samePath && sameId.id !== samePath.id) ||
        (previous &&
          (pathKey(previous.source.rootPath) !== pathKey(skill.source.rootPath) ||
            previous.source.rootIdentity !== skill.source.rootIdentity))
      )
        throw new AppError(
          'SKILL_SOURCE',
          '등록한 스킬의 폴더가 교체되었거나 경로가 다릅니다. 기존 등록을 제거한 뒤 다시 가져오세요.',
          409,
        );
      if (
        (previous && previous.revision !== expectedRevision) ||
        (!previous && expectedRevision !== undefined)
      )
        throw new AppError(
          'VERSION_CONFLICT',
          '스킬 등록 정보가 변경되었습니다. 목록을 다시 불러오세요.',
          409,
        );
      if (previous) this.assertSkillIdle(previous.id);
      const value = { ...skill, id: previous?.id ?? skill.id };
      this.db
        .prepare(
          'INSERT INTO skill_registrations(id,document) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET document=excluded.document',
        )
        .run(value.id, JSON.stringify(value));
      return value;
    });
  }
  removeRegisteredSkill(id: string, expectedRevision: string): void {
    this.transaction(() => {
      const skill = this.registeredSkills().find((entry) => entry.id === id);
      if (!skill) throw new AppError('SKILL_NOT_FOUND', '등록된 스킬을 찾을 수 없습니다.', 404);
      if (skill.revision !== expectedRevision)
        throw new AppError(
          'VERSION_CONFLICT',
          '스킬 등록 정보가 변경되었습니다. 목록을 다시 불러오세요.',
          409,
        );
      this.assertSkillIdle(id);
      this.db.prepare('DELETE FROM skill_registrations WHERE id=?').run(id);
    });
  }
  saveLocalProfile(profile: LocalProfile, expectedVersion?: number): LocalProfile {
    return this.transaction(() => {
      const previous = this.localProfiles().find((p) => p.id === profile.id);
      if (
        (previous && previous.version !== expectedVersion) ||
        (!previous && expectedVersion !== undefined)
      )
        throw new AppError(
          'VERSION_CONFLICT',
          '모델 설정이 변경되었습니다. 목록을 새로 불러오세요.',
          409,
        );
      const value = { ...profile, version: (previous?.version ?? 0) + 1 };
      this.db
        .prepare(
          'INSERT INTO runtime_profiles(id,document) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET document=excluded.document',
        )
        .run(value.id, JSON.stringify(value));
      return value;
    });
  }
  removeLocalProfile(id: string): void {
    this.db.prepare('DELETE FROM runtime_profiles WHERE id=?').run(id);
  }
  runtimeSettings(): RuntimeSettings {
    const row = this.db.prepare('SELECT document FROM runtime_settings WHERE id=1').get() as
      { document: string } | undefined;
    return runtimeSettingsSchema.parse(row ? JSON.parse(row.document) : {});
  }
  saveRuntimeSettings(settings: RuntimeSettings): void {
    this.transaction(() => {
      const parsed = runtimeSettingsSchema.parse(settings),
        previous = this.runtimeSettings();
      if (parsed.version !== previous.version)
        throw new AppError(
          'VERSION_CONFLICT',
          'VRAM 설정이 변경되었습니다. 최신 값을 불러오세요.',
          409,
        );
      this.db
        .prepare(
          'INSERT INTO runtime_settings(id,document) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET document=excluded.document',
        )
        .run(JSON.stringify({ ...parsed, version: previous.version + 1 }));
    });
  }
  project(id: string): Project {
    const project = this.projects().find((p) => p.id === id);
    if (!project) throw new AppError('PROJECT_NOT_FOUND', '프로젝트를 찾을 수 없습니다.', 404);
    return project;
  }
  registerProject(project: Project): Project {
    return this.transaction(() => {
      const previous = this.projects().find((p) =>
        process.platform === 'win32'
          ? p.path.toLowerCase() === project.path.toLowerCase()
          : p.path === project.path,
      );
      if (previous) {
        if (previous.identity !== project.identity)
          throw new AppError(
            'PROJECT_REPLACED',
            '같은 경로의 폴더가 교체되었습니다. 다른 경로로 등록하세요.',
            409,
          );
        return previous;
      }
      this.db
        .prepare('INSERT INTO projects(id,path,document) VALUES(?,?,?)')
        .run(project.id, project.path, JSON.stringify(project));
      this.db.prepare('INSERT INTO events(session_id,document) VALUES(?,?)').run(
        '',
        JSON.stringify({
          protocolVersion: 1,
          type: 'projects_changed',
          projects: this.projects(),
          createdAt: new Date().toISOString(),
        }),
      );
      return project;
    });
  }
  receipt(command: Command): CommandResult | null {
    const row = this.db
      .prepare('SELECT hash, result FROM commands WHERE id=?')
      .get(command.commandId) as { hash: string; result: string } | undefined;
    if (!row) return null;
    if (row.hash !== this.hash(command))
      throw new AppError(
        'COMMAND_REUSE',
        '같은 명령 ID를 다른 내용으로 재사용할 수 없습니다.',
        409,
      );
    const result = JSON.parse(row.result) as CommandResult & { deleted?: boolean };
    if (result.deleted)
      throw new AppError('SESSION_DELETED', '삭제된 대화의 명령은 다시 실행할 수 없습니다.', 410);
    return { ...result, session: hydrate(result.session), replayed: true };
  }
  deleteSessions(command: DeleteSessions): DeleteSessionsResult {
    return this.transaction(() => {
      const hash = this.hash(command);
      const prior = this.db
        .prepare('SELECT hash, result FROM commands WHERE id=?')
        .get(command.commandId) as { hash: string; result: string } | undefined;
      if (prior) {
        if (prior.hash !== hash)
          throw new AppError(
            'COMMAND_REUSE',
            '같은 명령 ID를 다른 내용으로 재사용할 수 없습니다.',
            409,
          );
        return { ...(JSON.parse(prior.result) as DeleteSessionsResult), replayed: true };
      }
      // Validate the whole selection before deleting anything.
      for (const target of command.targets) {
        const session = this.session(target.sessionId);
        if (session.version !== target.expectedVersion)
          throw new AppError(
            'VERSION_CONFLICT',
            '대화가 변경되었습니다. 최신 목록에서 다시 선택해 주세요.',
            409,
          );
        if (session.run?.status === 'running')
          throw new AppError('BUSY', '응답을 중지한 뒤 대화를 삭제해 주세요.', 409);
        if (session.messages.some((m) => m.activities?.some((a) => a.execution?.cleanupPending)))
          throw new AppError(
            'CLEANUP_REQUIRED',
            '컨테이너 정리를 확인한 뒤 대화를 삭제하세요.',
            409,
          );
        if (
          session.messages.some((m) =>
            m.activities?.some((a) => activityProposal(a)?.status === 'applying'),
          )
        )
          throw new AppError('BUSY', '파일 변경을 처리한 뒤 대화를 삭제해 주세요.', 409);
      }
      const sessionIds = command.targets.map((t) => t.sessionId);
      for (const id of sessionIds) {
        this.db.prepare('DELETE FROM sessions WHERE id=?').run(id);
        this.db.prepare('DELETE FROM events WHERE session_id=?').run(id);
        // Keep only command hashes to reject retries; erase the old conversation payload.
        this.db
          .prepare("UPDATE commands SET result=? WHERE json_extract(result,'$.session.id')=?")
          .run(JSON.stringify({ deleted: true }), id);
        this.db.prepare('INSERT INTO deleted_sessions(id) VALUES(?)').run(id);
      }
      const telegram = this.integration('telegram');
      if (telegram) {
        const state = telegram.document as {
          config: { enabled: boolean; sessionId: string | null };
          epoch: number;
          pairing?: unknown;
          candidate?: unknown;
          inbox: { sessionId?: string; command?: Command; run?: { sessionId: string } }[];
          outbox: { sessionId?: string }[];
        };
        const selected =
          state.config.sessionId !== null && sessionIds.includes(state.config.sessionId);
        state.inbox = state.inbox.filter(
          (item) =>
            !sessionIds.includes(
              item.sessionId ?? item.command?.sessionId ?? item.run?.sessionId ?? '',
            ),
        );
        state.outbox = state.outbox.filter((item) => !sessionIds.includes(item.sessionId ?? ''));
        if (selected) {
          state.config.enabled = false;
          state.config.sessionId = null;
          state.epoch++;
          delete state.pairing;
          delete state.candidate;
          state.inbox = [];
          state.outbox = [];
        }
        this.db
          .prepare('UPDATE integration_state SET version=?,document=? WHERE name=?')
          .run(telegram.version + 1, JSON.stringify(state), 'telegram');
      }
      const event: SessionsDeletedEvent = {
        seq: 0,
        protocolVersion: 1,
        type: 'sessions_deleted',
        sessionIds,
        createdAt: new Date().toISOString(),
      };
      const insert = this.db
        .prepare('INSERT INTO events(session_id,document) VALUES(?,?)')
        .run('', JSON.stringify(event));
      event.seq = Number(insert.lastInsertRowid);
      const result: DeleteSessionsResult = { commandId: command.commandId, event, replayed: false };
      this.db
        .prepare('INSERT INTO commands(id,hash,result) VALUES(?,?,?)')
        .run(command.commandId, hash, JSON.stringify(result));
      return result;
    });
  }
  private hash(command: Command | DeleteSessions): string {
    return createHash('sha256').update(JSON.stringify(command)).digest('hex');
  }
  private persist(session: Session): void {
    session.updatedAt = new Date().toISOString();
    session.version++;
    this.db
      .prepare(
        'INSERT INTO sessions(id,document) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET document=excluded.document',
      )
      .run(session.id, JSON.stringify(session));
    this.db.prepare('INSERT INTO events(session_id,document) VALUES (?,?)').run(
      session.id,
      JSON.stringify({
        protocolVersion: 1,
        type: 'session_changed',
        sessionId: session.id,
        session,
        createdAt: session.updatedAt,
      }),
    );
  }
  apply(
    command: Command,
    context?: ContextManifest,
    attachment?: McpContextAttachment,
  ): CommandResult {
    return this.transaction(() => {
      const previous = this.receipt(command);
      if (previous) return previous;
      let session: Session;
      const now = new Date().toISOString();
      if (command.type === 'create_session') {
        if (this.db.prepare('SELECT id FROM deleted_sessions WHERE id=?').get(command.sessionId))
          throw new AppError('SESSION_DELETED', '삭제된 대화 ID는 다시 사용할 수 없습니다.', 410);
        if (command.projectId) this.project(command.projectId);
        const exists = this.db.prepare('SELECT id FROM sessions WHERE id=?').get(command.sessionId);
        if (exists) throw new AppError('CONFLICT', '이미 존재하는 대화 ID입니다.', 409);
        session = {
          id: command.sessionId,
          title: command.title,
          version: 0,
          createdAt: now,
          updatedAt: now,
          config: command.config,
          routing: agentRoutingConfigSchema.parse(command.routing ?? {}),
          permissionMode: defaultPermissionMode(),
          mode: command.mode,
          skills: [],
          skillCloudConsent: false,
          hasSkillHistory: false,
          execution: defaultExecutionConfig(),
          projectId: command.projectId,
          plan: defaultPlan(),
          messages: [],
          run: null,
        };
      } else {
        session = this.session(command.sessionId);
        if ('expectedVersion' in command && command.expectedVersion !== session.version)
          throw new AppError(
            'VERSION_CONFLICT',
            '대화가 변경되었습니다. 최신 상태를 불러온 뒤 다시 시도하세요.',
            409,
          );
        if (command.type === 'cancel_run') {
          if (session.run?.id !== command.runId)
            throw new AppError('RUN_CONFLICT', '중지하려는 실행이 현재 실행과 다릅니다.', 409);
          if (session.run.status === 'running') {
            session.run.status = 'cancelled';
            session.run.finishedAt = now;
            if (session.autopilot?.runId === session.run.id) {
              session.autopilot.status = 'cancelled';
              session.autopilot.reason = '사용자가 중지했습니다.';
            }
            const message = session.messages.find((m) => m.id === session.run?.messageId);
            if (message) {
              message.status = 'cancelled';
              for (const activity of message.activities ?? []) {
                if (activity.status === 'running') activity.status = 'cancelled';
                if (activity.approval?.status === 'pending') {
                  activity.approval.status = 'rejected';
                  activity.approval.decidedBy = 'policy';
                  activity.approval.decidedAt = now;
                }
                for (const child of activity.subagents ?? []) {
                  if (child.status === 'queued' || child.status === 'running') {
                    child.status = 'cancelled';
                    child.finishedAt = now;
                    child.error = '상위 실행이 중지되었습니다.';
                  }
                }
                if (activity.mcpCall?.status === 'running') {
                  activity.mcpCall.status = 'unknown';
                  activity.mcpCall.error =
                    '중지 시점의 MCP 실행 결과가 확인되지 않았습니다. 서버 기록을 확인하세요.';
                }
              }
            }
          }
        } else if (command.type === 'set_permission_mode') {
          if (session.run?.status === 'running')
            throw new AppError('BUSY', '응답이 끝난 뒤 Autopilot 권한을 변경하세요.', 409);
          session.permissionMode = command.mode;
        } else if (command.type === 'stop_autopilot') {
          if (session.run?.status === 'running')
            throw new AppError('BUSY', '실행 중인 응답은 먼저 중지하세요.', 409);
          if (session.autopilot && !['completed', 'cancelled'].includes(session.autopilot.status)) {
            session.autopilot.status = 'cancelled';
            session.autopilot.reason = '사용자가 Autopilot을 껐습니다.';
          }
        } else if (command.type === 'save_plan') {
          if (session.run?.status === 'running' && session.autopilot?.runId === session.run.id)
            throw new AppError('BUSY', 'Autopilot을 중지한 뒤 실행 계획을 편집하세요.', 409);
          session.plan = command.plan;
        } else if (
          command.type === 'set_mode' ||
          command.type === 'adopt_plan' ||
          command.type === 'configure_execution' ||
          command.type === 'configure_skills' ||
          command.type === 'configure_mcp' ||
          command.type === 'attach_mcp_content' ||
          command.type === 'remove_mcp_content'
        ) {
          if (
            session.run?.status === 'running' ||
            session.messages.some((m) =>
              m.activities?.some((a) => activityProposal(a)?.status === 'applying'),
            )
          )
            throw new AppError('BUSY', '실행이 끝난 뒤 모드나 계획을 변경하세요.', 409);
          if (command.type === 'set_mode') session.mode = command.mode;
          else if (command.type === 'attach_mcp_content') {
            const parsed = mcpAttachmentSchema.safeParse(attachment);
            if (!parsed.success || parsed.data.id !== command.previewId)
              throw new AppError(
                'MCP_PREVIEW',
                '검토한 MCP 미리보기가 필요합니다. 다시 불러오세요.',
                409,
              );
            const value = parsed.data;
            if (
              Buffer.byteLength(value.text) !== value.bytes ||
              createHash('sha256').update(value.text).digest('hex') !== value.sha256
            )
              throw new AppError('MCP_CONTENT', 'MCP 내용과 출처가 일치하지 않습니다.');
            const previous = session.mcpAttachments ?? [];
            if (previous.some((entry) => entry.id === value.id))
              throw new AppError('MCP_DUPLICATE', '이미 첨부한 내용입니다.', 409);
            if (
              previous.length >= 8 ||
              previous.reduce((total, entry) => total + entry.bytes, value.bytes) > 65536
            )
              throw new AppError(
                'MCP_CONTENT_LIMIT',
                'MCP 첨부는 최대 8개, 합계 64 KiB까지 사용할 수 있습니다.',
              );
            if (
              (resolveModelConfig(session).provider === 'openrouter' ||
                (session.routing?.subagentsEnabled &&
                  (session.routing.subagent ?? session.config).provider === 'openrouter')) &&
              !command.mcpCloudConsent
            )
              throw new AppError(
                'MCP_CLOUD_CONSENT',
                'MCP 첨부 내용의 OpenRouter 전송 동의가 필요합니다.',
                403,
              );
            session.mcpAttachments = [...previous, value];
            session.mcpCloudConsent = command.mcpCloudConsent;
          } else if (command.type === 'remove_mcp_content') {
            session.mcpAttachments = (session.mcpAttachments ?? []).filter(
              (value) => value.id !== command.attachmentId,
            );
          } else if (command.type === 'configure_mcp') {
            const selections = mcpSelectionsSchema.parse(command.mcp);
            for (const selection of selections) {
              const server = this.registeredMcp().find((entry) => entry.id === selection.serverId);
              const tool = server?.tools.find((entry) => entry.name === selection.toolName);
              if (
                !server ||
                server.revision !== selection.serverRevision ||
                !tool?.supported ||
                tool.revision !== selection.toolRevision
              )
                throw new AppError(
                  'MCP_CHANGED',
                  'MCP 도구 등록 정보가 바뀌었습니다. 다시 선택하세요.',
                  409,
                );
            }
            session.mcp = selections;
            session.mcpCloudConsent = command.mcpCloudConsent;
          } else if (command.type === 'configure_skills') {
            const skills = skillSelectionsSchema.parse(command.skills);
            const registrations = this.registeredSkills();
            for (const selection of skills) {
              const registered = registrations.find((skill) => skill.id === selection.id);
              if (!registered)
                throw new AppError('SKILL_NOT_FOUND', '등록된 스킬을 찾을 수 없습니다.', 404);
              if (registered.revision !== selection.revision)
                throw new AppError(
                  'SKILL_CHANGED',
                  '선택한 스킬이 변경되었습니다. 다시 선택하세요.',
                  409,
                );
              if (!registered.invocation.model)
                throw new AppError('SKILL_INVOCATION', '모델 호출이 허용되지 않은 스킬입니다.');
            }
            session.skills = skills;
            session.skillCloudConsent = command.skillCloudConsent;
          } else if (command.type === 'configure_execution') {
            if (!session.projectId && command.execution.backend !== 'disabled')
              throw new AppError('PROJECT_REQUIRED', '명령 실행에는 프로젝트가 필요합니다.');
            session.execution = command.execution;
          } else {
            const proposal = session.messages
              .flatMap((m) => m.activities ?? [])
              .find((a) => a.id === command.activityId)?.planProposal;
            if (!proposal || proposal.status !== 'proposed')
              throw new AppError('PLAN_NOT_FOUND', '검토 대기 중인 계획이 없습니다.', 409);
            if (
              JSON.stringify(planSchema.parse(proposal.basePlan)) !== JSON.stringify(session.plan)
            )
              throw new AppError(
                'PLAN_CONFLICT',
                '제안 이후 계획을 편집했습니다. 현재 계획을 기준으로 다시 제안해 주세요.',
                409,
              );
            session.plan = planSchema.parse(proposal.plan);
            proposal.status = 'adopted';
          }
        } else {
          if (session.run?.status === 'running')
            throw new AppError('BUSY', '현재 응답이 끝나거나 중지된 뒤 변경하세요.', 409);
          if (command.type === 'configure_routing') {
            if (
              session.messages.length &&
              JSON.stringify(session.routing) !== JSON.stringify(command.routing)
            )
              throw new AppError(
                'NEW_SESSION_REQUIRED',
                '역할별 모델 설정을 바꾸려면 새 대화를 만드세요.',
                409,
              );
            session.routing = command.routing;
          } else if (command.type === 'configure_session') {
            // Switching providers cannot silently send a local conversation to the cloud.
            if (
              session.messages.length &&
              JSON.stringify(session.config) !== JSON.stringify(command.config)
            )
              throw new AppError(
                'NEW_SESSION_REQUIRED',
                '모델과 생성 설정을 바꾸려면 새 대화를 만드세요.',
                409,
              );
            session.config = command.config;
          } else {
            if (context && context.sourceSessionVersion !== session.version)
              throw new AppError(
                'CONTEXT_VERSION',
                '입력을 구성한 대화 버전이 현재 상태와 다릅니다.',
                409,
              );
            if (context?.skillCatalog?.includedIds.length) session.hasSkillHistory = true;
            if (context?.mcpTools?.length) session.hasMcpHistory = true;
            if (context?.mcpAttachmentIds?.length) session.hasMcpHistory = true;
            const messageId = randomUUID();
            const runId = randomUUID();
            if (command.type === 'start_autopilot') {
              session.mode = 'build';
              session.autopilot = prepareAutopilot(session, command.taskIds, command.limits, runId);
            } else if (command.type === 'start_goal') {
              session.mode = 'build';
              session.autopilot = prepareGoal(session, command.goal, command.limits, runId);
            } else if (command.type === 'resume_goal')
              session.autopilot = resumeGoal(session, runId);
            const content =
              command.type === 'send_message'
                ? command.content
                : command.type === 'start_goal'
                  ? '/goal ' + command.goal
                  : command.type === 'resume_goal'
                    ? '/goal 계속: ' + session.autopilot!.plan.goal
                    : '목표 실행: ' +
                      session.plan.goal +
                      '\n' +
                      session.autopilot!.taskIds.length +
                      '개 작업 · 실행 횟수 제한 없음';
            session.messages.push({
              id: randomUUID(),
              role: 'user',
              content,
              createdAt: now,
              status: 'complete',
              error: null,
              usage: null,
            });
            session.messages.push({
              id: messageId,
              role: 'assistant',
              content: '',
              createdAt: now,
              status: 'streaming',
              error: null,
              usage: emptyUsage(resolveModelConfig(session).provider),
              inferenceConfig: resolveModelConfig(session),
            });
            session.run = {
              id: runId,
              messageId,
              status: 'running',
              startedAt: now,
              finishedAt: null,
              actor: command.actor,
              ...(context ? { context } : {}),
            };
            if (session.messages.length === 2)
              session.title =
                command.type === 'start_goal'
                  ? command.goal.slice(0, 60)
                  : command.type === 'start_autopilot'
                    ? session.plan.goal.slice(0, 60)
                    : content.slice(0, 60);
          }
        }
      }
      this.persist(session);
      const result: CommandResult = { commandId: command.commandId, session, replayed: false };
      this.db
        .prepare('INSERT INTO commands(id,hash,result) VALUES (?,?,?)')
        .run(command.commandId, this.hash(command), JSON.stringify(result));
      return result;
    });
  }
  updateRun(update: RunUpdate): Session {
    return this.transaction(() => {
      const session = this.session(update.sessionId);
      if (session.run?.id !== update.runId || session.run.status !== 'running') return session;
      const message = session.messages.find((m) => m.id === session.run?.messageId);
      if (!message) throw new AppError('CORRUPT_RUN', '실행 메시지를 찾을 수 없습니다.', 500);
      if (update.text !== undefined) message.content = update.text;
      if (update.activities) message.activities = update.activities;
      if (update.continuation) message.continuation = update.continuation;
      if (update.context) session.run.context = update.context;
      if (update.autopilot && update.autopilot.runId === update.runId)
        session.autopilot = update.autopilot;
      if (update.usage && message.usage) message.usage = { ...message.usage, ...update.usage };
      if (update.status) {
        session.run.status = update.status;
        session.run.finishedAt = new Date().toISOString();
        message.status = update.status === 'completed' ? 'complete' : update.status;
        message.error = update.error ?? null;
        if (session.autopilot?.runId === update.runId && session.autopilot.status === 'running') {
          session.autopilot.status =
            update.status === 'cancelled'
              ? 'cancelled'
              : update.status === 'interrupted'
                ? 'interrupted'
                : 'paused';
          session.autopilot.reason =
            update.error ?? '실행이 멈췄습니다. 기록을 확인한 뒤 다시 실행할 수 있습니다.';
        }
        for (const activity of message.activities ?? []) {
          if (activity.approval?.status === 'pending') {
            activity.approval.status = 'rejected';
            activity.approval.decidedBy = 'policy';
            activity.approval.decidedAt = session.run.finishedAt!;
          }
          for (const child of activity.subagents ?? []) {
            if (child.status === 'queued' || child.status === 'running') {
              child.status = update.status === 'cancelled' ? 'cancelled' : 'interrupted';
              child.finishedAt = session.run.finishedAt!;
              child.error = '상위 실행이 종료되어 중단되었습니다. 자동 재실행하지 않았습니다.';
            }
          }
          if (activity.mcpCall?.status === 'running') {
            activity.mcpCall.status = 'unknown';
            activity.mcpCall.error =
              'MCP 실행 결과가 확인되지 않았습니다. 서버 기록을 확인하고 다시 요청하세요.';
          }
          if (activity.status === 'running')
            activity.status = update.status === 'completed' ? 'completed' : update.status;
        }
      }
      this.persist(session);
      return session;
    });
  }
  beginEdit(action: EditAction, allowRunning = false): Session {
    return this.transaction(() => {
      const session = this.session(action.sessionId);
      if (session.mode === 'plan' && !['check', 'reject'].includes(action.action))
        throw new AppError('PLAN_READ_ONLY', '파일을 변경하려면 Build 모드로 전환하세요.', 403);
      if (session.run?.status === 'running' && !allowRunning)
        throw new AppError('BUSY', '응답이 끝난 뒤 변경을 적용해 주세요.', 409);
      if (session.version !== action.expectedVersion)
        throw new AppError(
          'VERSION_CONFLICT',
          '대화가 변경되었습니다. 최신 수정안을 확인해 주세요.',
          409,
        );
      const edit = activityProposal(
        session.messages.flatMap((m) => m.activities ?? []).find((a) => a.id === action.activityId),
      );
      if (!edit || !session.projectId)
        throw new AppError('EDIT_NOT_FOUND', '수정안을 찾을 수 없습니다.', 404);
      if (
        edit.status === 'applying' ||
        (action.action === 'apply' && edit.status !== 'proposed' && edit.status !== 'partial') ||
        (action.action === 'undo' && edit.status !== 'applied' && edit.status !== 'partial') ||
        (action.action === 'reject' && edit.status !== 'proposed')
      )
        throw new AppError(
          'EDIT_STATE',
          '먼저 파일 상태를 확인하거나 새 수정안을 만들어 주세요.',
          409,
        );
      if (action.action === 'apply' || action.action === 'undo') edit.operation = action.action;
      edit.status = 'applying';
      if ('files' in edit)
        edit.observations = edit.files.map((f) => ({ path: f.path, state: 'unknown' }));
      delete edit.error;
      this.persist(session); // Durable intent before any filesystem effect.
      return session;
    });
  }
  recordExecution(sessionId: string, activityId: string, execution: CommandExecution): Session {
    return this.transaction(() => {
      const session = this.session(sessionId);
      const activity = session.messages
        .flatMap((m) => m.activities ?? [])
        .find((a) => a.id === activityId);
      if (!activity || (activity.execution && activity.execution.id !== execution.id))
        throw new AppError('EXECUTION_NOT_FOUND', '명령 실행 기록을 찾을 수 없습니다.', 409);
      activity.execution = execution;
      this.persist(session); // Also accepts late cancellation results; never loses a container owner.
      return session;
    });
  }
  decideApproval(action: ApprovalAction): Session {
    return this.transaction(() => {
      const session = this.session(action.sessionId);
      if (session.version !== action.expectedVersion)
        throw new AppError(
          'VERSION_CONFLICT',
          '대화가 변경되었습니다. 최신 권한 요청을 확인해 주세요.',
          409,
        );
      const activity = session.messages
        .flatMap((message) => message.activities ?? [])
        .find((entry) => entry.id === action.activityId);
      if (!activity?.approval || activity.approval.status !== 'pending')
        throw new AppError('APPROVAL_NOT_FOUND', '대기 중인 권한 요청을 찾을 수 없습니다.', 404);
      activity.approval.status = action.action === 'approve' ? 'approved' : 'rejected';
      activity.approval.decidedBy = 'user';
      activity.approval.decidedAt = new Date().toISOString();
      this.persist(session);
      return session;
    });
  }
  recordSkillRead(
    sessionId: string,
    activityId: string,
    provenance: NonNullable<Activity['skillRead']>,
  ): Session {
    return this.transaction(() => {
      const session = this.session(sessionId);
      const activity = session.messages
        .flatMap((message) => message.activities ?? [])
        .find((entry) => entry.id === activityId);
      if (
        !activity ||
        activity.kind !== 'tool' ||
        !['read_skill', 'read_skill_resource'].includes(activity.label)
      )
        throw new AppError('SKILL_READ_NOT_FOUND', '스킬 읽기 활동을 찾을 수 없습니다.', 409);
      if (activity.skillRead) {
        if (
          Object.keys(provenance).some(
            (key) =>
              activity.skillRead![key as keyof typeof provenance] !==
              provenance[key as keyof typeof provenance],
          )
        )
          throw new AppError(
            'SKILL_READ_CONFLICT',
            '이미 기록된 스킬 출처를 변경할 수 없습니다.',
            409,
          );
        return session;
      }
      activity.skillRead = provenance;
      session.hasSkillHistory = true;
      // A read may finish just before cancel is committed. Keep its audit without
      // changing the cancelled message, continuation, content or run status.
      this.persist(session);
      return session;
    });
  }
  recordMcpCall(
    sessionId: string,
    activityId: string,
    call: NonNullable<Activity['mcpCall']>,
  ): Session {
    return this.transaction(() => {
      const session = this.session(sessionId);
      const activity = session.messages
        .flatMap((m) => m.activities ?? [])
        .find((a) => a.id === activityId);
      if (!activity || activity.kind !== 'tool' || !activity.label.startsWith('mcp_'))
        throw new AppError('MCP_ACTIVITY', 'MCP 실행 기록을 찾을 수 없습니다.', 409);
      const previous = activity.mcpCall;
      if (
        previous &&
        ['serverId', 'serverRevision', 'toolName', 'toolRevision', 'startedAt'].some(
          (key) => previous[key as keyof typeof previous] !== call[key as keyof typeof call],
        )
      )
        throw new AppError('MCP_ACTIVITY', '이미 기록된 MCP 실행 정보를 변경할 수 없습니다.', 409);
      if (
        previous &&
        ['completed', 'failed'].includes(previous.status) &&
        JSON.stringify(previous) !== JSON.stringify(call)
      )
        throw new AppError('MCP_ACTIVITY', '완료된 MCP 실행 결과를 변경할 수 없습니다.', 409);
      activity.mcpCall = call;
      session.hasMcpHistory = true;
      this.persist(session);
      return session;
    });
  }
  recordCreatedFile(
    sessionId: string,
    activityId: string,
    path: string,
    stagingId: string,
    identity: string,
  ): Session {
    return this.transaction(() => {
      const session = this.session(sessionId);
      const changes = session.messages
        .flatMap((m) => m.activities ?? [])
        .find((a) => a.id === activityId)?.changes;
      const file = changes?.files.find((f) => f.path === path);
      if (
        !changes ||
        changes.status !== 'applying' ||
        changes.operation !== 'apply' ||
        !file ||
        !('kind' in file) ||
        file.stagingId !== stagingId ||
        !/^\d+:\d+$/.test(identity)
      )
        throw new AppError('EDIT_STATE', '생성 파일의 실행 의도를 확인할 수 없습니다.', 409);
      file.identity = identity;
      this.persist(session);
      return session;
    });
  }
  finishEdit(
    sessionId: string,
    activityId: string,
    status: ChangeStatus,
    error?: string,
    observations?: ChangeSet['observations'],
  ): Session {
    return this.transaction(() => {
      const session = this.session(sessionId);
      const edit = activityProposal(
        session.messages.flatMap((m) => m.activities ?? []).find((a) => a.id === activityId),
      );
      if (!edit || edit.status !== 'applying')
        throw new AppError('EDIT_STATE', '처리 중인 수정안이 없습니다.', 409);
      if ('files' in edit) {
        edit.status = status;
        if (observations) edit.observations = observations;
      } else {
        if (status === 'partial')
          throw new AppError('EDIT_STATE', '단일 파일은 부분 적용 상태를 사용할 수 없습니다.');
        edit.status = status;
      }
      if (error) edit.error = error;
      else delete edit.error;
      this.persist(session);
      return session;
    });
  }
  recover(): number {
    let count = 0;
    for (const session of this.snapshot().sessions) {
      for (const activity of session.messages.flatMap((m) => m.activities ?? [])) {
        if (activity.mcpCall?.status === 'running') {
          this.recordMcpCall(session.id, activity.id, {
            ...activity.mcpCall,
            status: 'unknown',
            error: '앱이 종료되어 MCP 실행 결과를 확인하지 못했습니다. 자동 반복하지 않았습니다.',
          });
          count++;
        }
        if (activity.execution && ['starting', 'running'].includes(activity.execution.status)) {
          this.recordExecution(session.id, activity.id, {
            ...activity.execution,
            status: 'interrupted',
            error: '이전 명령이 중단되었습니다. 자동으로 반복하지 않았습니다.',
          });
          count++;
        }
      }
      const uncertain = session.messages
        .flatMap((m) => m.activities ?? [])
        .filter((a) => activityProposal(a)?.status === 'applying');
      for (const activity of uncertain) {
        this.finishEdit(
          session.id,
          activity.id,
          'uncertain',
          '파일 변경 중 앱이 종료되었습니다. 파일 상태 확인이 필요합니다. 적용·되돌리기를 자동으로 반복하지 않았습니다.',
        );
        count++;
      }
      if (session.run?.status !== 'running') continue;
      this.updateRun({
        sessionId: session.id,
        runId: session.run.id,
        status: 'interrupted',
        error: '이전 실행이 종료 전에 중단되었습니다. 자동 재전송하지 않았습니다.',
      });
      count++;
    }
    return count;
  }
}
