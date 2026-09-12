import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import {
  AppError,
  emptyUsage,
  defaultPlan,
  modelConfigSchema,
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
} from '@lodex/contracts';

// Additive JSON fields are defaulted on all read paths, including old SSE events.
function hydrate(session: Session): Session {
  return {
    ...session,
    mode: session.mode ?? 'build',
    execution: executionConfigSchema.parse(session.execution ?? {}),
    projectId: session.projectId ?? null,
    config: modelConfigSchema.parse(session.config),
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
    if (row.user_version > 8) {
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
  apply(command: Command, context?: ContextManifest): CommandResult {
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
          mode: command.mode,
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
              for (const activity of message.activities ?? [])
                if (activity.status === 'running') activity.status = 'cancelled';
            }
          }
        } else if (command.type === 'save_plan') {
          if (session.run?.status === 'running' && session.autopilot?.runId === session.run.id)
            throw new AppError('BUSY', 'Autopilot을 중지한 뒤 실행 계획을 편집하세요.', 409);
          session.plan = command.plan;
        } else if (
          command.type === 'set_mode' ||
          command.type === 'adopt_plan' ||
          command.type === 'configure_execution'
        ) {
          if (
            session.run?.status === 'running' ||
            session.messages.some((m) =>
              m.activities?.some((a) => activityProposal(a)?.status === 'applying'),
            )
          )
            throw new AppError('BUSY', '실행이 끝난 뒤 모드나 계획을 변경하세요.', 409);
          if (command.type === 'set_mode') session.mode = command.mode;
          else if (command.type === 'configure_execution') {
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
          if (command.type === 'configure_session') {
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
            if (session.messages.length >= 120)
              throw new AppError(
                'CONTEXT_LIMIT',
                '초기 버전은 대화당 60회 요청까지 지원합니다. 새 대화를 시작하세요.',
              );
            const messageId = randomUUID();
            const runId = randomUUID();
            if (command.type === 'start_autopilot')
              session.autopilot = prepareAutopilot(session, command.taskIds, command.limits, runId);
            const content =
              command.type === 'send_message'
                ? command.content
                : '목표 실행: ' +
                  session.plan.goal +
                  '\n' +
                  session.autopilot!.taskIds.length +
                  '개 작업 · 모델 ' +
                  command.limits.modelCalls +
                  '회 · ' +
                  command.limits.minutes +
                  '분 이내';
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
              usage: emptyUsage(session.config.provider),
            });
            session.run = {
              id: runId,
              messageId,
              status: 'running',
              startedAt: now,
              finishedAt: null,
              ...(context ? { context } : {}),
            };
            if (session.messages.length === 2)
              session.title =
                command.type === 'start_autopilot'
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
          if (activity.status === 'running')
            activity.status = update.status === 'completed' ? 'completed' : update.status;
        }
      }
      this.persist(session);
      return session;
    });
  }
  beginEdit(action: EditAction): Session {
    return this.transaction(() => {
      const session = this.session(action.sessionId);
      if (session.mode === 'plan' && action.action !== 'check')
        throw new AppError('PLAN_READ_ONLY', '파일을 변경하려면 Build 모드로 전환하세요.', 403);
      if (session.run?.status === 'running')
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
        (action.action === 'undo' && edit.status !== 'applied' && edit.status !== 'partial')
      )
        throw new AppError(
          'EDIT_STATE',
          '먼저 파일 상태를 확인하거나 새 수정안을 만들어 주세요.',
          409,
        );
      if (action.action !== 'check') edit.operation = action.action;
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
