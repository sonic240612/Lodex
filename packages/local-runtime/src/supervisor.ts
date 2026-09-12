import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';

// Keep a private parent pipe open. A daemon crash closes it, so this supervisor
// terminates only the engine child it created, without recovering a recycled PID.
const lines = createInterface({ input: process.stdin });
let engine: ChildProcessWithoutNullStreams | undefined,
  stopping = false;
const finish = (code: number) => {
  if (process.send && process.connected)
    process.send({ type: 'engine_stopped' }, () => process.exit(code));
  else process.exit(code);
};
const shutdown = () => {
  if (stopping) return;
  stopping = true;
  if (!engine || engine.exitCode !== null || engine.signalCode !== null) {
    finish(0);
    return;
  }
  engine.kill();
  setTimeout(() => engine?.kill('SIGKILL'), 1200).unref();
};
process.stdin.on('end', shutdown);
process.stdin.on('error', shutdown);
process.on('disconnect', shutdown);
process.stdout.on('error', shutdown);
process.stderr.on('error', shutdown);
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
lines.once('line', (line) => {
  lines.close();
  process.stdin.resume();
  try {
    if (stopping || line.length > 262144) throw new Error('Invalid bootstrap');
    const config = JSON.parse(line) as { executable: string; args: string[]; cwd: string };
    if (
      typeof config.executable !== 'string' ||
      !Array.isArray(config.args) ||
      config.args.some((arg) => typeof arg !== 'string') ||
      typeof config.cwd !== 'string'
    )
      throw new Error('Invalid bootstrap');
    engine = spawn(config.executable, config.args, {
      cwd: config.cwd,
      env: process.env,
      windowsHide: true,
      shell: false,
    });
    engine.stdin.on('error', shutdown);
    engine.stdin.end();
    engine.stdout.pipe(process.stdout, { end: false });
    engine.stderr.pipe(process.stderr, { end: false });
    engine.on('error', () => {
      process.stderr.write('Engine process could not start.\n');
      process.exitCode = 1;
    });
    engine.on('close', (code) => finish(stopping ? 0 : (code ?? 1)));
  } catch {
    process.stderr.write('Invalid engine bootstrap.\n');
    finish(1);
  }
});
