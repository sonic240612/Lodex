import { spawn as spawnProcess } from 'node:child_process';
import * as pty from 'node-pty';
import type { IPty } from 'node-pty';

let terminal: IPty | undefined,
  closing = false,
  stopping = false;
let outputBytes = 0,
  pendingBytes = 0;
const send = (value: object, done?: () => void) => {
  if (process.connected) process.send!(value, () => done?.());
  else done?.();
};
const finish = (code: number) => {
  if (closing) return;
  closing = true;
  if (terminal && process.platform !== 'win32') {
    try {
      process.kill(-terminal.pid, 'SIGKILL');
    } catch {
      /* Terminal process group exited. */
    }
  }
  send({ type: 'exit', code }, () => process.exit(0));
};
const stop = () => {
  if (closing || stopping) return;
  stopping = true;
  if (!terminal) {
    finish(1);
    return;
  }
  const owned = terminal;
  if (process.platform === 'win32') {
    const killer = spawnProcess('taskkill.exe', ['/pid', String(owned.pid), '/t', '/f'], {
      windowsHide: true,
      shell: false,
      stdio: 'ignore',
    });
    killer.once('error', () => {
      try {
        owned.kill();
      } catch {
        finish(1);
      }
    });
    killer.once('close', (code) => {
      if (code !== 0 && !closing) {
        try {
          owned.kill();
        } catch {
          finish(1);
        }
      }
    });
  } else {
    try {
      process.kill(-owned.pid, 'SIGTERM');
    } catch {
      try {
        owned.kill();
      } catch {
        finish(1);
      }
    }
    setTimeout(() => {
      try {
        process.kill(-owned.pid, 'SIGKILL');
      } catch {
        /* Already exited. */
      }
    }, 700).unref();
  }
};
process.once('disconnect', stop);
process.once('SIGTERM', stop);
process.on(
  'message',
  (message: {
    type: string;
    executable: string;
    args: string[];
    cwd: string;
    env: NodeJS.ProcessEnv;
    cols: number;
    rows: number;
    input: string;
    text: string;
    eof: boolean;
  }) => {
    try {
      if (message.type === 'stop') {
        stop();
        return;
      }
      if (message.type === 'start' && !terminal && !closing && !stopping) {
        terminal = pty.spawn(message.executable, message.args, {
          cwd: message.cwd,
          env: { ...message.env, TERM: 'xterm-256color' },
          name: 'xterm-256color',
          cols: message.cols,
          rows: message.rows,
          useConpty: true,
        });
        terminal.onData((data) => {
          const bytes = Buffer.byteLength(data);
          outputBytes += bytes;
          if (outputBytes > 1048576) {
            send({ type: 'limit' });
            stop();
            return;
          }
          pendingBytes += bytes;
          if (pendingBytes > 65536) terminal?.pause();
          send({ type: 'data', data }, () => {
            pendingBytes -= bytes;
            if (!closing && !stopping && pendingBytes < 32768) terminal?.resume();
          });
        });
        terminal.onExit(({ exitCode }) => finish(exitCode));
        send({ type: 'ready', pid: terminal.pid });
        if (message.input) terminal.write(message.input);
      } else if (terminal && !closing && !stopping) {
        if (message.type === 'input') {
          if (message.text) terminal.write(message.text);
          if (message.eof) terminal.write(process.platform === 'win32' ? '\x1a\r' : '\x04');
        } else if (message.type === 'resize') terminal.resize(message.cols, message.rows);
      }
    } catch {
      send({ type: 'error' }, () => {
        stop();
        if (!terminal) process.exit(1);
      });
    }
  },
);
