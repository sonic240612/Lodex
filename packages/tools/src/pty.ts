import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { AppError } from '@lodex/contracts';
import type { CliResult, InputControl } from './execution';
declare const __dirname: string;

export type TerminalControl = (resize: (cols: number, rows: number) => void) => () => void;
export interface TerminalOptions {
  cols: number;
  rows: number;
  control?: TerminalControl;
}

/** Isolate native ConPTY workers so completion releases every native handle. */
export async function runPty(options: {
  executable: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
  input?: string;
  progress?: (output: string, chunk?: string) => void;
  inputControl?: InputControl;
  terminal: TerminalOptions;
}): Promise<CliResult> {
  const { signal } = options;
  signal.throwIfAborted();
  const adjacent = typeof __dirname === 'string' ? join(__dirname, 'pty-supervisor.cjs') : '';
  const supervisor =
    adjacent && existsSync(adjacent) ? adjacent : resolve('apps/daemon/dist/pty-supervisor.cjs');
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [supervisor], {
      cwd: options.cwd,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '' },
    });
    let output = '',
      total = 0,
      truncated = false,
      ended = false,
      terminating = false;
    let ptyPid: number | undefined,
      exitCode: number | null = null,
      receivedExit = false,
      failure: unknown;
    let detachInput: (() => void) | undefined, detachResize: (() => void) | undefined;
    let forceTimer: NodeJS.Timeout | undefined;
    const send = (message: object) => {
      if (!child.connected || ended || terminating)
        throw new AppError('COMMAND_INPUT_CLOSED', '터미널이 종료되었습니다.', 409);
      child.send(message, (error) => {
        if (error && !ended) terminate();
      });
    };
    const forceKill = () => {
      if (ended || !child.pid) return;
      if (process.platform === 'win32') {
        const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], {
          windowsHide: true,
          shell: false,
          stdio: 'ignore',
        });
        killer.once('error', () => child.kill());
      } else {
        if (ptyPid) {
          try {
            process.kill(-ptyPid, 'SIGKILL');
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
    };
    const terminate = () => {
      if (ended || terminating) return;
      terminating = true;
      if (child.connected) child.send({ type: 'stop' }, () => {});
      forceTimer = setTimeout(forceKill, 3000);
      forceTimer.unref();
    };
    child.on('message', (message: { type: string; data?: string; pid?: number; code?: number }) => {
      if (ended) return;
      if (message.type === 'ready' && Number.isSafeInteger(message.pid)) {
        ptyPid = message.pid;
        if (terminating) {
          child.send({ type: 'stop' }, () => {});
          return;
        }
        detachInput = options.inputControl?.((text, eof) => send({ type: 'input', text, eof }));
        detachResize = options.terminal.control?.((cols, rows) =>
          send({ type: 'resize', cols, rows }),
        );
      } else if (message.type === 'data' && typeof message.data === 'string') {
        total += Buffer.byteLength(message.data);
        output += message.data;
        if (output.length > 24000) {
          output = output.slice(0, 8000) + '\n[output truncated]\n' + output.slice(-15000);
          truncated = true;
        }
        try {
          options.progress?.(output, message.data);
        } catch (error) {
          failure = error;
          terminate();
        }
        if (total > 1048576) {
          truncated = true;
          terminate();
        }
      } else if (message.type === 'exit') {
        receivedExit = true;
        exitCode = message.code ?? null;
      } else if (message.type === 'limit') {
        total = 1048577;
        truncated = true;
        terminate();
      } else if (message.type === 'error') {
        failure = new AppError(
          'PTY_UNAVAILABLE',
          '터미널을 시작하지 못했습니다. 현재 OS용 Lodex 런타임과 셸 설치를 확인하세요.',
        );
        terminate();
      }
    });
    child.once('error', (error) => {
      failure = error;
    });
    child.once('close', async () => {
      ended = true;
      clearTimeout(forceTimer);
      signal.removeEventListener('abort', terminate);
      detachInput?.();
      detachResize?.();
      // A supervisor crash must not orphan its independently sessioned PTY.
      // This PID came from the currently owned child, never persisted history.
      if (!receivedExit && ptyPid) {
        if (process.platform === 'win32') {
          await new Promise<void>((done) => {
            const killer = spawn('taskkill.exe', ['/pid', String(ptyPid), '/t', '/f'], {
              windowsHide: true,
              stdio: 'ignore',
            });
            killer.once('error', () => done());
            killer.once('close', () => done());
          });
        } else {
          try {
            process.kill(-ptyPid, 'SIGKILL');
          } catch {
            /* Owned group already exited. */
          }
        }
      }
      if (failure) {
        reject(failure);
        return;
      }
      if (!receivedExit && !signal.aborted && !truncated) {
        reject(
          new AppError(
            'PTY_EXIT',
            '터미널 실행 결과를 확인하지 못했습니다. 같은 명령을 자동 재실행하지 않았습니다.',
          ),
        );
        return;
      }
      resolveResult({
        code: signal.aborted || total > 1048576 ? null : exitCode,
        output,
        truncated,
      });
    });
    signal.addEventListener('abort', terminate, { once: true });
    child.send(
      {
        type: 'start',
        executable: options.executable,
        args: options.args,
        cwd: options.cwd,
        env: options.env,
        cols: options.terminal.cols,
        rows: options.terminal.rows,
        input: options.input ?? '',
      },
      (error) => {
        if (error) {
          failure = error;
          terminate();
        }
      },
    );
    if (signal.aborted) terminate();
  });
}
