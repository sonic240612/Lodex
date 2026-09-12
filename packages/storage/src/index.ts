import { Worker } from 'node:worker_threads';
import {
  AppError,
  type Command,
  type CommandResult,
  type ContextManifest,
  type DomainEvent,
  type Session,
  type Snapshot,
  type Project,
  type DeleteSessions,
  type DeleteSessionsResult,
  type EditAction,
  type ChangeSet,
  type ChangeStatus,
  type CommandExecution,
} from '@lodex/contracts';
import type { RunUpdate } from './engine';
export type { RunUpdate } from './engine';
export class Store {
  private sequence = 0;
  private ended = false;
  private pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (reason: unknown) => void }
  >();
  private constructor(private worker: Worker) {
    worker.on(
      'message',
      (message: {
        id?: number;
        result?: unknown;
        error?: { code: string; message: string; status: number };
      }) => {
        if (message.id === undefined) return;
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error)
          pending.reject(
            new AppError(message.error.code, message.error.message, message.error.status),
          );
        else pending.resolve(message.result);
      },
    );
    const rejectAll = () => {
      this.ended = true;
      for (const p of this.pending.values())
        p.reject(new AppError('STORAGE_EXIT', '데이터 저장 프로세스가 종료되었습니다.', 503));
      this.pending.clear();
    };
    worker.on('error', rejectAll);
    worker.on('exit', rejectAll);
  }
  static async open(path: string, workerPath: string): Promise<Store> {
    const worker = new Worker(workerPath, { workerData: { path } });
    const store = new Store(worker);
    await new Promise<void>((resolve, reject) => {
      worker.once('message', () => resolve());
      worker.once('error', reject);
      worker.once('exit', (code) => reject(new Error('Storage worker exited: ' + code)));
    });
    return store;
  }
  private call<T>(method: string, ...args: unknown[]): Promise<T> {
    if (this.ended)
      return Promise.reject(
        new AppError('STORAGE_EXIT', '데이터 저장 프로세스가 종료되었습니다.', 503),
      );
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject });
      this.worker.postMessage({ id, method, args });
    });
  }
  snapshot(): Promise<Omit<Snapshot, 'openrouterConfigured'>> {
    return this.call('snapshot');
  }
  session(id: string): Promise<Session> {
    return this.call('session', id);
  }
  project(id: string): Promise<Project> {
    return this.call('project', id);
  }
  registerProject(project: Project): Promise<Project> {
    return this.call('registerProject', project);
  }
  events(after: number): Promise<DomainEvent[]> {
    return this.call('events', after);
  }
  deleteSessions(command: DeleteSessions): Promise<DeleteSessionsResult> {
    return this.call('deleteSessions', command);
  }
  beginEdit(action: EditAction): Promise<Session> {
    return this.call('beginEdit', action);
  }
  recordExecution(
    sessionId: string,
    activityId: string,
    execution: CommandExecution,
  ): Promise<Session> {
    return this.call('recordExecution', sessionId, activityId, execution);
  }
  recordCreatedFile(
    sessionId: string,
    activityId: string,
    path: string,
    stagingId: string,
    identity: string,
  ): Promise<Session> {
    return this.call('recordCreatedFile', sessionId, activityId, path, stagingId, identity);
  }
  finishEdit(
    sessionId: string,
    activityId: string,
    status: ChangeStatus,
    error?: string,
    observations?: ChangeSet['observations'],
  ): Promise<Session> {
    return this.call('finishEdit', sessionId, activityId, status, error, observations);
  }
  receipt(command: Command): Promise<CommandResult | null> {
    return this.call('receipt', command);
  }
  apply(command: Command, context?: ContextManifest): Promise<CommandResult> {
    return this.call('apply', command, context);
  }
  updateRun(update: RunUpdate): Promise<Session> {
    return this.call('updateRun', update);
  }
  async close(): Promise<void> {
    await this.call('close');
    await this.worker.terminate();
  }
}
