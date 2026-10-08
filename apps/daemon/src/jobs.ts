import { randomUUID } from 'node:crypto';
import {
  AppError,
  jobCommandSchema,
  type CommandExecution,
  type CommandJob,
  type Session,
  type ToolDefinition,
} from '@lodex/contracts';
import { executeHostCommand, executeCommand } from '@lodex/tools';
import type { Store } from '@lodex/storage';
import { z } from 'zod';

export const commandJobInputSchema = z.strictObject({
  jobId: z.uuid(),
  input: z.string().max(8000).default(''),
  eof: z.boolean().default(false),
});
export const commandJobIdSchema = z.strictObject({ jobId: z.uuid() });
export const commandJobResizeSchema = commandJobIdSchema.extend({
  cols: z.number().int().min(20).max(500),
  rows: z.number().int().min(5).max(200),
});
export const commandJobResizeActionSchema = commandJobResizeSchema.extend({ sessionId: z.uuid() });
export const commandJobActionSchema = commandJobInputSchema.extend({ sessionId: z.uuid() });
export const commandJobTools: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'read_command_job',
      description:
        'Read current output, stdin availability and actual exit status of a job belonging to this conversation. This never reruns the command.',
      parameters: z.toJSONSchema(commandJobIdSchema),
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_command_input',
      description:
        "Send exact text to this conversation's interactive command. For a pipe include a newline when needed; eof=true closes stdin. For a PTY, input is raw terminal data (Enter is \\r); eof sends Ctrl-D on Unix or Ctrl-Z/Enter on Windows. External effects use the same permission policy as the command.",
      parameters: z.toJSONSchema(commandJobInputSchema),
    },
  },
  {
    type: 'function',
    function: {
      name: 'resize_command_terminal',
      description:
        "Resize this conversation's active PTY in columns and rows. Only PTY jobs support resizing. This does not restart the command.",
      parameters: z.toJSONSchema(commandJobResizeSchema),
    },
  },
  {
    type: 'function',
    function: {
      name: 'stop_command_job',
      description:
        "Stop an owned command job and its child processes. Never use another conversation's ID.",
      parameters: z.toJSONSchema(commandJobIdSchema),
    },
  },
];
type HostOptions = Parameters<typeof executeHostCommand>[0];
type DockerOptions = Parameters<typeof executeCommand>[0];
export class CommandJobs {
  private records: CommandJob[] = [];
  private version = 0;
  private closing = false;
  private queue: Promise<void> = Promise.resolve();
  private live = new Map<
    string,
    {
      controller: AbortController;
      task: Promise<CommandExecution>;
      write?: (text: string, eof: boolean) => void;
      resize?: (cols: number, rows: number) => void;
    }
  >();
  private constructor(private store: Store) {}
  static async open(store: Store) {
    const manager = new CommandJobs(store);
    const saved = await store.integration('command_jobs');
    if (saved) {
      manager.version = saved.version;
      manager.records = saved.document as CommandJob[];
    }
    if (!Array.isArray(manager.records))
      throw new AppError('COMMAND_JOB_STATE', '저장된 작업 목록이 올바르지 않습니다.');
    for (const job of manager.records) {
      job.inputOpen = false;
      if (!job.execution || ['running', 'starting'].includes(job.execution.status)) {
        job.error =
          '앱이 재시작되어 작업 결과가 확인되지 않습니다. 자동으로 재실행하지 않았습니다.';
        if (job.execution) {
          job.execution.status = 'interrupted';
          job.execution.error = job.error;
          job.execution.cleanupPending = true;
        }
      }
    }
    if (saved) await manager.save();
    return manager;
  }
  private save() {
    const snapshot = structuredClone(this.records);
    for (const job of snapshot)
      if (job.execution && Buffer.byteLength(job.execution.output) > 8192) {
        const bytes = Buffer.from(job.execution.output);
        let start = bytes.length - 8000;
        while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start++;
        job.execution.output =
          '[Earlier output omitted; inspect the conversation activity log]\n' +
          bytes.subarray(start).toString('utf8');
        job.execution.truncated = true;
      }
    if (Buffer.byteLength(JSON.stringify(snapshot)) > 1800000)
      for (const job of snapshot)
        if (!this.live.has(job.id) && job.execution) {
          job.execution.output = '[Inspect the conversation activity log]';
          job.execution.command = job.execution.command.slice(0, 256);
          job.execution.truncated = true;
        }

    const pending = this.queue.then(async () => {
      this.version = await this.store.saveIntegration('command_jobs', this.version, snapshot);
    });
    this.queue = pending.catch(() => undefined);
    return pending;
  }
  list(sessionId: string) {
    return structuredClone(this.records.filter((job) => job.sessionId === sessionId));
  }
  hasActiveProject(projectId: string) {
    return this.records.some((job) => job.projectId === projectId && this.live.has(job.id));
  }
  get(sessionId: string, id: string) {
    const job = this.records.find((job) => job.id === id && job.sessionId === sessionId);
    if (!job)
      throw new AppError('COMMAND_JOB_NOT_FOUND', '이 대화의 작업을 찾을 수 없습니다.', 404);
    return job;
  }
  async input(sessionId: string, id: string, text: string, eof: boolean) {
    const job = this.get(sessionId, id),
      live = this.live.get(id);
    if (!job.inputOpen || !live?.write)
      throw new AppError(
        'COMMAND_INPUT_CLOSED',
        '명령의 입력이 닫혔거나 작업이 종료되었습니다.',
        409,
      );
    if (Buffer.byteLength(text) > 16384)
      throw new AppError('COMMAND_INPUT_LIMIT', '입력은 16 KiB 이하로 보내세요.');
    // Audit count, not input text: a user may be supplying a credential.
    job.inputBytes += Buffer.byteLength(text);
    await this.save();
    live.write(text, eof);
    if (eof) {
      job.inputOpen = false;
      await this.save();
    }
    return structuredClone(job);
  }
  async resize(sessionId: string, id: string, cols: number, rows: number) {
    commandJobResizeSchema.parse({ jobId: id, cols, rows });
    const job = this.get(sessionId, id),
      live = this.live.get(id);
    if (!job.terminal || !live?.resize)
      throw new AppError('TERMINAL_CLOSED', '크기를 변경할 실행 중인 터미널이 없습니다.', 409);
    live.resize(cols, rows);
    job.terminal = { cols, rows };
    if (job.execution) job.execution.terminal = { cols, rows };
    await this.save();
    return structuredClone(job);
  }
  async stop(sessionId: string, id: string) {
    const job = this.get(sessionId, id),
      live = this.live.get(id);
    if (live) {
      live.controller.abort();
      await live.task;
    } else if (job.execution?.status === 'interrupted')
      throw new AppError(
        'COMMAND_JOB_UNKNOWN',
        '이전 실행 결과를 확인할 수 없어 PID를 추측해 종료하지 않았습니다.',
        409,
      );
    return structuredClone(job);
  }
  async run(
    session: Session,
    options: HostOptions | DockerOptions,
    environment: 'host' | 'docker',
    executor: typeof executeHostCommand | typeof executeCommand,
  ): Promise<CommandExecution> {
    if (this.closing) throw new AppError('COMMAND_JOBS_CLOSED', '앱이 종료되는 중입니다.');
    const input = jobCommandSchema.parse(JSON.parse(options.argumentsJson));
    if (!input.interactive && !input.background && !input.pty)
      return environment === 'host'
        ? (executor as typeof executeHostCommand)(options as HostOptions)
        : (executor as typeof executeCommand)(options as DockerOptions);
    const starting = this.records.filter(
      (record) => !this.live.has(record.id) && !record.execution && !record.error,
    ).length;
    if (this.live.size + starting >= 16)
      throw new AppError(
        'COMMAND_JOB_LIMIT',
        '동시에 실행 중인 작업이 16개입니다. 기존 작업을 중지하세요.',
      );
    const job: CommandJob = {
      id: randomUUID(),
      sessionId: session.id,
      projectId: options.project.id,
      runId: session.run!.id,
      actor: session.run?.actor ?? 'desktop',
      interactive: input.interactive || input.pty,
      ...(input.pty ? { terminal: { cols: input.cols, rows: input.rows } } : {}),
      background: input.background,
      inputOpen: false,
      inputBytes: 0,
      createdAt: new Date().toISOString(),
    };
    options.signal.throwIfAborted();
    this.records = this.records
      .filter((record) => this.live.has(record.id) || record.execution?.status === 'interrupted')
      .concat(
        this.records
          .filter(
            (record) => !this.live.has(record.id) && record.execution?.status !== 'interrupted',
          )
          .slice(-24),
      );
    if (this.records.length >= 64)
      throw new AppError(
        'COMMAND_JOB_LIMIT',
        '미확정 작업 기록이 많습니다. 이전 작업을 확인하세요.',
      );
    this.records.push(job);
    await this.save();
    const controller = new AbortController();
    const abort = () => controller.abort(options.signal.reason);
    options.signal.addEventListener('abort', abort, { once: true });
    if (this.closing || options.signal.aborted) abort();
    let ready!: (execution: CommandExecution) => void, fail!: (error: unknown) => void;
    const started = new Promise<CommandExecution>((resolve, reject) => {
      ready = resolve;
      fail = reject;
    });
    const live: {
      controller: AbortController;
      task: Promise<CommandExecution>;
      write?: (text: string, eof: boolean) => void;
      resize?: (cols: number, rows: number) => void;
    } = { controller, task: undefined as unknown as Promise<CommandExecution> };
    this.live.set(job.id, live);
    const shared = {
      ...options,
      signal: controller.signal,
      ...(job.interactive
        ? {
            inputControl: (write: (text: string, eof: boolean) => void) => {
              live.write = write;
              job.inputOpen = true;
              void this.save().catch((error) => controller.abort(error));
              return () => {
                delete live.write;
                job.inputOpen = false;
                void this.save().catch((error) => controller.abort(error));
              };
            },
          }
        : {}),
      ...(input.pty
        ? {
            terminalControl: (resize: (cols: number, rows: number) => void) => {
              live.resize = resize;
              return () => {
                delete live.resize;
              };
            },
          }
        : {}),
      record: async (execution: CommandExecution) => {
        execution.jobId = job.id;
        execution.background = job.background;
        if (job.terminal) execution.terminal = { ...job.terminal };
        job.execution = structuredClone(execution);
        await this.save();
        await options.record(execution);
        ready(structuredClone(execution));
      },
    };
    live.task = (
      environment === 'host'
        ? (executor as typeof executeHostCommand)(shared as HostOptions)
        : (executor as typeof executeCommand)(shared as DockerOptions)
    )
      .catch(async (error) => {
        job.error = error instanceof AppError ? error.message : '작업 실행 실패';
        if (job.execution) {
          job.execution.status = 'interrupted';
          job.execution.cleanupPending = true;
        } else
          job.execution = {
            id: randomUUID(),
            containerName: '',
            projectId: options.project.id,
            environment,
            command: input.command,
            cwd: options.project.path,
            status: controller.signal.aborted ? 'cancelled' : 'failed',
            startedAt: job.createdAt,
            finishedAt: new Date().toISOString(),
            exitCode: null,
            output: '',
            truncated: false,
            cleanupPending: false,
            error: job.error,
          };
        await this.save();
        fail(error);
        throw error;
      })
      .finally(async () => {
        job.inputOpen = false;
        delete live.write;
        delete live.resize;
        this.live.delete(job.id);
        options.signal.removeEventListener('abort', abort);
        await this.save();
      });
    void live.task.catch(() => undefined);
    if (input.background) return await started;
    // Foreground callers await completion; observe the intent promise on startup errors.
    void started.catch(() => undefined);
    return await live.task;
  }
  async close() {
    this.closing = true;
    for (const live of this.live.values()) live.controller.abort();
    await Promise.allSettled([...this.live.values()].map((live) => live.task));
    await this.queue;
  }
}
