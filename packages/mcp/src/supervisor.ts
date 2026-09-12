import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

// Bootstrap and ownership acknowledgments use IPC; stdio stays exclusively MCP JSON-RPC.
let child: ChildProcessWithoutNullStreams | undefined,
  stopping = false,
  finished = false;
const finish = (code: number) => {
  if (finished) return;
  finished = true;
  if (process.send && process.connected)
    process.send({ type: 'server_stopped' }, () => process.exit(code));
  else process.exit(code);
};
const stop = () => {
  if (stopping) return;
  stopping = true;
  if (!child) {
    finish(0);
    return;
  }
  child.stdin.end();
  setTimeout(() => child?.kill(), 500).unref();
  setTimeout(() => child?.kill('SIGKILL'), 1500).unref();
};
process.stdin.pause();
process.stdin.on('end', stop);
process.stdin.on('error', stop);
process.stdout.on('error', stop);
process.stderr.on('error', stop);
process.on('disconnect', stop);
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
process.on('message', (raw) => {
  const data = raw as {
    type?: string;
    executable?: string;
    args?: string[];
    cwd?: string;
    env?: Record<string, string>;
  };
  if (data.type === 'stop') {
    stop();
    return;
  }
  if (child || stopping || data.type !== 'bootstrap') return;
  try {
    if (!data.executable || !Array.isArray(data.args) || !data.cwd || !data.env)
      throw new Error('Invalid bootstrap');
    child = spawn(data.executable, data.args, {
      cwd: data.cwd,
      env: data.env,
      windowsHide: true,
      shell: false,
    });
    child.stdin.on('error', stop);
    process.stdin.pipe(child.stdin);
    child.stdout.pipe(process.stdout, { end: false });
    child.stderr.pipe(process.stderr, { end: false });
    child.on('error', stop);
    child.on('spawn', () => process.send?.({ type: 'server_started' }));
    child.on('close', (code) => finish(stopping ? 0 : (code ?? 1)));
  } catch {
    finish(1);
  }
});
