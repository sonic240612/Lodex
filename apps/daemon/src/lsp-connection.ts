import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { AppError, type LanguageServerRegistration, type Project } from '@lodex/contracts';
declare const __dirname: string;
type Pending = {
  resolve: (result: unknown) => void;
  reject: (error: unknown) => void;
  clear: () => void;
};
const MAX_FRAME = 4 * 1024 * 1024;
export class LspConnection {
  private child: ChildProcess | undefined;
  private buffer = Buffer.alloc(0);
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private closed = false;
  private stopping = false;
  private ownedPid: number | undefined;
  private closePromise: Promise<void> | undefined;
  private notificationBytes = 0;
  private windowStarted = Date.now();
  constructor(
    private registration: LanguageServerRegistration,
    private project: Project,
    private notification: (method: string, params: unknown) => void,
    private serverRequest: (method: string, params: unknown) => unknown,
  ) {}
  get live() {
    return !!this.child && !this.closed && !this.stopping;
  }
  async start(signal: AbortSignal) {
    signal.throwIfAborted();
    const adjacent = typeof __dirname === 'string' ? join(__dirname, 'lsp-supervisor.cjs') : '';
    const supervisor =
      adjacent && existsSync(adjacent) ? adjacent : resolve('apps/daemon/dist/lsp-supervisor.cjs');
    const env: NodeJS.ProcessEnv = {};
    for (const key of [
      'PATH',
      'Path',
      'SystemRoot',
      'WINDIR',
      'TEMP',
      'TMP',
      'HOME',
      'USERPROFILE',
      'APPDATA',
      'LOCALAPPDATA',
      'LANG',
      'LC_ALL',
    ])
      if (process.env[key]) env[key] = process.env[key];
    const child = (this.child = spawn(process.execPath, [supervisor], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
      env,
      detached: process.platform !== 'win32',
    }));
    child.stderr!.resume();
    child.stdout!.on('data', (chunk: Buffer) => {
      try {
        this.parse(chunk);
      } catch (error) {
        this.fail(error);
        void this.close();
      }
    });
    child.stdin!.on('error', () =>
      this.fail(new AppError('LSP_CLOSED', '언어 서버 연결이 끊어졌습니다.')),
    );
    child.once('close', () => {
      this.closed = true;
      this.fail(new AppError('LSP_CLOSED', '언어 서버가 종료되었습니다.'));
    });
    child.once('error', () => {
      this.closed = true;
      this.fail(new AppError('LSP_START', '언어 서버 감독 프로세스를 시작하지 못했습니다.'));
    });
    await new Promise<void>((resolveStart, reject) => {
      let settled = false;
      const done = (error?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        child.removeListener('close', died);
        error ? reject(error) : resolveStart();
      };
      const abort = () => {
          done(signal.reason);
          void this.close();
        },
        died = () => done(new AppError('LSP_START', '언어 서버를 시작하지 못했습니다.'));
      const timer = setTimeout(() => {
        done(new AppError('LSP_START', '언어 서버 시작 시간이 초과되었습니다.'));
        void this.close();
      }, 10000);
      signal.addEventListener('abort', abort, { once: true });
      child.once('close', died);
      child.once('error', died);
      child.on('message', (raw: { type: string; pid?: number }) => {
        if (raw.type === 'started' && typeof raw.pid === 'number') {
          this.ownedPid = raw.pid;
          done();
        }
      });
      child.send(
        {
          type: 'start',
          executable: this.registration.config.executable,
          args: this.registration.config.args,
          cwd: this.project.path,
          env,
        },
        (error) => {
          if (error) done(error);
        },
      );
    });
  }
  private parse(chunk: Buffer) {
    if (this.buffer.length + chunk.length > MAX_FRAME + 8192)
      throw new AppError('LSP_OUTPUT_LIMIT', '언어 서버 응답 크기 제한을 초과했습니다.');
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length) {
      const boundary = this.buffer.indexOf('\r\n\r\n');
      if (boundary < 0) {
        if (this.buffer.length > 8192)
          throw new AppError('LSP_PROTOCOL', '언어 서버 응답 헤더가 잘못되었습니다.');
        return;
      }
      const header = this.buffer.subarray(0, boundary).toString('ascii'),
        lengths = [...header.matchAll(/^Content-Length:\s*(\d+)\s*$/gim)];
      const length = Number(lengths[0]?.[1]);
      if (
        lengths.length !== 1 ||
        !Number.isSafeInteger(length) ||
        length < 2 ||
        length > MAX_FRAME ||
        /Content-Type:.*charset=(?!utf-?8(?:\s|$))/i.test(header)
      )
        throw new AppError('LSP_PROTOCOL', '언어 서버 응답 형식이 잘못되었습니다.');
      if (this.buffer.length < boundary + 4 + length) return;
      const value = JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(
          this.buffer.subarray(boundary + 4, boundary + 4 + length),
        ),
      ) as Record<string, unknown>;
      this.buffer = this.buffer.subarray(boundary + 4 + length);
      if (value.jsonrpc !== '2.0' || typeof value !== 'object')
        throw new AppError('LSP_PROTOCOL', '올바른 JSON-RPC 응답이 아닙니다.');
      if (typeof value.method === 'string') {
        if (Date.now() - this.windowStarted > 60000) {
          this.notificationBytes = 0;
          this.windowStarted = Date.now();
        }
        this.notificationBytes += length;
        if (this.notificationBytes > 16 * 1024 * 1024)
          throw new AppError('LSP_OUTPUT_LIMIT', '언어 서버 알림이 너무 많아 연결을 종료했습니다.');
        if (value.id !== undefined) {
          if (!(typeof value.id === 'string' || typeof value.id === 'number'))
            throw new AppError('LSP_PROTOCOL', '잘못된 요청 ID입니다.');
          const result = this.serverRequest(value.method, value.params);
          this.send(
            result === undefined
              ? {
                  jsonrpc: '2.0',
                  id: value.id,
                  error: { code: -32601, message: 'Unsupported server request' },
                }
              : { jsonrpc: '2.0', id: value.id, result },
          );
        } else this.notification(value.method, value.params);
      } else if (typeof value.id === 'number') {
        const pending = this.pending.get(value.id);
        if (!pending) continue;
        this.pending.delete(value.id);
        pending.clear();
        value.error
          ? pending.reject(new AppError('LSP_REQUEST', '언어 서버가 요청을 처리하지 못했습니다.'))
          : pending.resolve(value.result ?? null);
      }
    }
  }
  private send(value: unknown) {
    if (!this.child?.stdin?.writable || this.closed)
      throw new AppError('LSP_CLOSED', '언어 서버 연결이 닫혔습니다.');
    const bytes = Buffer.from(JSON.stringify(value));
    if (bytes.length > MAX_FRAME || this.child.stdin.writableLength > MAX_FRAME)
      throw new AppError('LSP_INPUT_LIMIT', '언어 서버 요청 크기 제한을 초과했습니다.');
    this.child.stdin.write(
      Buffer.concat([Buffer.from(`Content-Length: ${bytes.length}\r\n\r\n`, 'ascii'), bytes]),
    );
  }
  notify(method: string, params: unknown) {
    this.send({ jsonrpc: '2.0', method, params });
  }
  request(
    method: string,
    params: unknown,
    signal: AbortSignal,
    timeoutMs = 30000,
  ): Promise<unknown> {
    signal.throwIfAborted();
    const id = this.nextId++;
    return new Promise((resolveResult, reject) => {
      const abort = () => {
        const value = this.pending.get(id);
        if (!value) return;
        this.pending.delete(id);
        value.clear();
        try {
          this.notify('$/cancelRequest', { id });
        } catch {
          /* Disconnected. */
        }
        reject(
          signal.aborted
            ? signal.reason
            : new AppError('LSP_TIMEOUT', '언어 서버 응답 시간이 초과되었습니다.'),
        );
      };
      const timer = setTimeout(abort, timeoutMs);
      const clear = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
      };
      this.pending.set(id, { resolve: resolveResult, reject, clear });
      signal.addEventListener('abort', abort, { once: true });
      try {
        this.send({ jsonrpc: '2.0', id, method, params });
      } catch (error) {
        this.pending.delete(id);
        clear();
        reject(error);
      }
    });
  }
  private fail(error: unknown) {
    for (const value of this.pending.values()) {
      value.clear();
      value.reject(error);
    }
    this.pending.clear();
  }
  async close() {
    if (this.closePromise) return this.closePromise;
    this.stopping = true;
    this.closePromise = (async () => {
      const child = this.child;
      if (!child || this.closed) return;
      try {
        await this.request('shutdown', null, AbortSignal.timeout(500), 500);
        this.notify('exit', null);
      } catch {
        /* Force owned process cleanup below. */
      }
      // Keep the supervisor alive until its whole owned process tree is stopped.
      if (child.connected) child.send({ type: 'stop' }, () => {});
      await Promise.race([
        new Promise<void>((done) => child.once('close', () => done())),
        delay(2000),
      ]);
      if (!this.closed && child.pid) {
        if (process.platform === 'win32') {
          const kill = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], {
            windowsHide: true,
            shell: false,
            stdio: 'ignore',
          });
          await new Promise<void>((done) => {
            kill.once('close', () => done());
            kill.once('error', () => {
              child.kill();
              done();
            });
          });
        } else {
          if (this.ownedPid) {
            try {
              process.kill(-this.ownedPid, 'SIGKILL');
            } catch {
              /* Already exited. */
            }
          }
          try {
            process.kill(-child.pid, 'SIGKILL');
          } catch {
            child.kill('SIGKILL');
          }
        }
      }
      this.fail(new AppError('LSP_CLOSED', '언어 서버 연결이 종료되었습니다.'));
    })();
    return this.closePromise;
  }
}
