import { createHash, randomUUID } from 'node:crypto';
import {
  AppError,
  automationInputSchema,
  makeCommand,
  type AutomationInput,
  type AutomationRecord,
  type AutomationSnapshot,
  type AutomationTrigger,
  type Command,
  type CommandResult,
  type Session,
} from '@lodex/contracts';
import { readText } from '@lodex/tools';
import type { Store } from '@lodex/storage';

export function nextAutomationTime(trigger: AutomationTrigger, now: number): string | undefined {
  if (trigger.kind === 'files') return undefined;
  if (trigger.kind === 'interval') return new Date(now + trigger.minutes * 60000).toISOString();
  const date = new Date(now);
  date.setHours(trigger.hour, trigger.minute, 0, 0);
  if (date.getTime() <= now) date.setDate(date.getDate() + 1);
  return date.toISOString();
}
interface Options {
  store: Store;
  dispatch: (command: Command) => Promise<CommandResult>;
  available: (session: Session) => boolean;
  now?: () => number;
}
/** Serial durable claims; an uncertain start is paused after restart, never repeated. */
export class Automations {
  private records: AutomationRecord[] = [];
  private version = 0;
  private timer?: ReturnType<typeof setInterval>;
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;
  private now: () => number;
  private constructor(private options: Options) {
    this.now = options.now ?? Date.now;
  }
  static async open(options: Options) {
    const manager = new Automations(options);
    const stored = await options.store.integration('automations');
    manager.version = stored?.version ?? 0;
    if (stored) {
      if (!Array.isArray(stored.document) || stored.document.length > 100)
        throw new AppError('AUTOMATION_STATE', '예약 실행 저장 데이터를 확인하세요.');
      manager.records = stored.document as AutomationRecord[];
      for (const record of manager.records) {
        automationInputSchema.parse({
          id: record.id,
          name: record.name,
          sessionId: record.sessionId,
          prompt: record.prompt,
          enabled: record.enabled,
          trigger: record.trigger,
        });
        if (record.lastRun && ['starting', 'running'].includes(record.lastRun.status)) {
          record.enabled = false;
          record.lastRun.status = 'interrupted';
          record.lastRun.message =
            '앱이 재시작되어 실행 결과를 확인해야 합니다. 중복 실행을 막기 위해 일시 중지했습니다.';
        }
        // No replay of missed schedules or file changes while the app was closed.
        const next = nextAutomationTime(record.trigger, manager.now());
        if (next) record.nextAt = next;
        delete record.changedAt;
        if (record.trigger.kind === 'files') delete record.fileHashes;
      }
      await manager.save();
    }
    return manager;
  }
  snapshot(): AutomationSnapshot {
    return structuredClone({ version: this.version, records: this.records });
  }
  reloadImported() {
    return this.serial(async () => {
      if (this.closed || this.records.length) return;
      const saved = await this.options.store.integration('automations');
      if (!saved || saved.version === this.version) return;
      if (!Array.isArray(saved.document) || saved.document.length > 100)
        throw new AppError('AUTOMATION_STATE', '복원한 예약 실행 목록을 확인하세요.');
      const records = saved.document as AutomationRecord[];
      for (const record of records) {
        automationInputSchema.parse({
          id: record.id,
          name: record.name,
          sessionId: record.sessionId,
          prompt: record.prompt,
          enabled: record.enabled,
          trigger: record.trigger,
        });
        if (
          record.enabled ||
          record.lastRun ||
          record.nextAt ||
          record.fileHashes ||
          record.changedAt
        )
          throw new AppError('AUTOMATION_STATE', '복원한 예약 실행은 비활성 상태여야 합니다.');
      }
      this.records = structuredClone(records);
      this.version = saved.version;
    });
  }
  private serial<T>(action: () => Promise<T>): Promise<T> {
    const run = this.queue.then(action, action);
    this.queue = run.catch(() => undefined);
    return run;
  }
  private async save(records = this.records) {
    const version = await this.options.store.saveIntegration('automations', this.version, records);
    this.records = records;
    this.version = version;
  }
  private async hashes(record: AutomationRecord, session: Session) {
    if (record.trigger.kind !== 'files') return {};
    if (!session.projectId)
      throw new AppError('AUTOMATION_PROJECT', '파일 변경 실행에는 대화의 프로젝트가 필요합니다.');
    const project = await this.options.store.project(session.projectId);
    const hashes: Record<string, string> = {};
    for (const path of record.trigger.paths) {
      try {
        hashes[path] = createHash('sha256')
          .update(await readText(project, path, AbortSignal.timeout(10000)))
          .digest('hex');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') hashes[path] = 'missing';
        else throw error;
      }
    }
    return hashes;
  }
  configure(raw: AutomationInput, expectedVersion: number) {
    return this.serial(async () => {
      if (this.closed) throw new AppError('SHUTTING_DOWN', '앱을 종료하는 중입니다.');
      if (expectedVersion !== this.version)
        throw new AppError('VERSION_CONFLICT', '예약 실행 목록을 다시 불러오세요.', 409);
      const input = automationInputSchema.parse(raw);
      const session = await this.options.store.session(input.sessionId);
      const previous = input.id ? this.records.find((record) => record.id === input.id) : undefined;
      if (input.id && !previous)
        throw new AppError('AUTOMATION_MISSING', '예약 실행을 찾지 못했습니다.', 404);
      if (previous?.lastRun && ['starting', 'running'].includes(previous.lastRun.status))
        throw new AppError('AUTOMATION_BUSY', '실행이 끝난 뒤 예약을 편집하세요.', 409);
      if (!previous && this.records.length >= 100)
        throw new AppError('AUTOMATION_LIMIT', '예약 실행은 최대 100개까지 저장할 수 있습니다.');
      const now = new Date(this.now()).toISOString();
      const record: AutomationRecord = {
        ...input,
        id: input.id ?? randomUUID(),
        createdAt: previous?.createdAt ?? now,
        updatedAt: now,
        ...(previous?.lastRun ? { lastRun: previous.lastRun } : {}),
      };
      const next = nextAutomationTime(record.trigger, this.now());
      if (next) record.nextAt = next;
      if (record.trigger.kind === 'files') record.fileHashes = await this.hashes(record, session);
      await this.save([...this.records.filter((entry) => entry.id !== record.id), record]);
      return this.snapshot();
    });
  }
  remove(id: string, expectedVersion: number) {
    return this.serial(async () => {
      if (expectedVersion !== this.version)
        throw new AppError('VERSION_CONFLICT', '예약 실행 목록을 다시 불러오세요.', 409);
      const current = this.records.find((record) => record.id === id);
      if (current?.lastRun && ['starting', 'running'].includes(current.lastRun.status))
        throw new AppError('AUTOMATION_BUSY', '실행이 끝난 뒤 예약을 삭제하세요.', 409);
      await this.save(this.records.filter((record) => record.id !== id));
      return this.snapshot();
    });
  }
  start() {
    if (!this.timer) {
      this.timer = setInterval(() => {
        void this.tick().catch(() => undefined);
      }, 5000);
      this.timer.unref();
    }
  }
  tick() {
    return this.serial(async () => {
      if (this.closed) return;
      let dirty = false;
      for (const record of this.records) {
        if (!record.enabled && record.lastRun?.status !== 'running') continue;
        try {
          const session = await this.options.store.session(record.sessionId);
          if (record.lastRun?.status === 'running') {
            if (!session.run || session.run.id !== record.lastRun.runId) {
              record.lastRun.status = 'interrupted';
              record.enabled = false;
              record.lastRun.message = '이전 실행 상태가 바뀌어 예약을 일시 중지했습니다.';
              dirty = true;
              continue;
            }
            if (session.run.status === 'running') continue;
            record.lastRun.status = session.run.status;
            if (record.trigger.kind === 'files')
              record.fileHashes = await this.hashes(record, session);
            dirty = true;
            if (session.run.status !== 'completed') {
              record.enabled = false;
              record.lastRun.message = '대화에서 실행 결과를 확인한 뒤 다시 켜세요.';
            }
            continue;
          }
          if (
            !record.enabled ||
            session.run?.status === 'running' ||
            !this.options.available(session)
          )
            continue;
          let due = false;
          if (record.trigger.kind === 'files') {
            const hashes = await this.hashes(record, session);
            if (!record.fileHashes) {
              record.fileHashes = hashes;
              dirty = true;
              continue;
            }
            if (JSON.stringify(hashes) !== JSON.stringify(record.fileHashes)) {
              record.fileHashes = hashes;
              record.changedAt = new Date(this.now()).toISOString();
              dirty = true;
            }
            due =
              !!record.changedAt &&
              this.now() - Date.parse(record.changedAt) >= record.trigger.debounceSeconds * 1000;
          } else due = !!record.nextAt && Date.parse(record.nextAt) <= this.now();
          if (!due) continue;
          record.lastRun = { startedAt: new Date(this.now()).toISOString(), status: 'starting' };
          const next = nextAutomationTime(record.trigger, this.now());
          if (next) record.nextAt = next;
          delete record.changedAt;
          await this.save();
          dirty = false; // Claim before dispatch: a crash never repeats the side effect.
          const result = await this.options.dispatch(
            makeCommand({
              type: 'send_message',
              sessionId: session.id,
              expectedVersion: session.version,
              mode: 'build',
              content: `[예약 실행: ${record.name}]\n${record.prompt}`,
            }),
          );
          record.lastRun = {
            startedAt: record.lastRun.startedAt,
            runId: result.session.run!.id,
            status: 'running',
          };
          await this.save();
        } catch (error) {
          record.enabled = false;
          record.lastRun = {
            startedAt: record.lastRun?.startedAt ?? new Date(this.now()).toISOString(),
            ...(record.lastRun?.runId ? { runId: record.lastRun.runId } : {}),
            status: 'failed',
            message:
              error instanceof AppError
                ? error.message
                : '예약 실행을 시작하지 못했습니다. 설정과 대화 상태를 확인하세요.',
          };
          dirty = true;
        }
      }
      if (dirty) await this.save();
    });
  }
  async close() {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    await this.queue;
  }
}
