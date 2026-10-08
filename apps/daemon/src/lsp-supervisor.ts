import { spawn, type ChildProcess } from 'node:child_process';
let child: ChildProcess | undefined,
  stopping = false,
  finished = false;
const finish = () => {
  if (finished) return;
  finished = true;
  if (process.connected) process.send?.({ type: 'stopped' }, () => process.exit(0));
  else process.exit(0);
};
const stop = () => {
  if (stopping) return;
  stopping = true;
  if (!child?.pid) {
    finish();
    return;
  }
  const pid = child.pid;
  if (process.platform === 'win32') {
    const kill = spawn('taskkill.exe', ['/pid', String(pid), '/t', '/f'], {
      windowsHide: true,
      shell: false,
      stdio: 'ignore',
    });
    kill.once('error', () => child?.kill());
    kill.once('close', () => setTimeout(finish, 100).unref());
  } else {
    try {
      process.kill(-pid, 'SIGTERM');
    } catch {
      /* Already exited. */
    }
    setTimeout(() => {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        /* Already exited. */
      }
      finish();
    }, 500).unref();
  }
  setTimeout(finish, 1500).unref();
};
process.once('disconnect', stop);
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
process.stdin.on('error', stop);
process.stdout.on('error', stop);
process.stderr.on('error', stop);
process.stdin.pause();
process.on(
  'message',
  (message: {
    type?: string;
    executable?: string;
    args?: string[];
    cwd?: string;
    env?: NodeJS.ProcessEnv;
  }) => {
    if (message.type === 'stop') {
      stop();
      return;
    }
    if (
      message.type !== 'start' ||
      child ||
      stopping ||
      !message.executable ||
      !message.args ||
      !message.cwd ||
      !message.env
    )
      return;
    child = spawn(message.executable, message.args, {
      cwd: message.cwd,
      env: message.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
      detached: process.platform !== 'win32',
    });
    child.stdin!.on('error', stop);
    process.stdin.pipe(child.stdin!);
    child.stdout!.pipe(process.stdout, { end: false });
    child.stderr!.pipe(process.stderr, { end: false });
    child.once('spawn', () => process.send?.({ type: 'started', pid: child!.pid }));
    child.once('error', stop);
    child.once('exit', () => {
      if (process.platform !== 'win32' && child?.pid) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          /* Group exited. */
        }
      }
    });
    child.once('close', finish);
  },
);
