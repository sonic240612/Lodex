import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

/** Exercise the packaged add-on and supervisor using the shipped Node executable. */
export async function smokePty(runtime, daemonDirectory, cwd) {
  const child = spawn(runtime, [resolve(daemonDirectory, 'pty-supervisor.cjs')], {
    cwd,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '' },
  });
  let output = '',
    stderr = '',
    sent = false,
    result;
  child.stderr.on('data', (chunk) => {
    stderr = (stderr + chunk).slice(-4096);
  });
  child.on('message', (event) => {
    if (event.type === 'data') output += event.data;
    if (!sent && output.includes('READY:true')) {
      sent = true;
      child.send({ type: 'resize', cols: 110, rows: 32 });
      setTimeout(
        () => child.connected && child.send({ type: 'input', text: 'q', eof: false }),
        150,
      );
    }
    if (event.type === 'exit') result = event.code;
  });
  const timer = setTimeout(() => {
    if (child.connected) child.send({ type: 'stop' });
    else child.kill();
  }, 10000);
  child.send({
    type: 'start',
    executable: runtime,
    cwd,
    env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '' },
    cols: 80,
    rows: 24,
    input: '',
    args: [
      '-e',
      "process.stdin.setRawMode(true);process.stdout.write('READY:'+process.stdout.isTTY+'\\n');process.stdin.on('data',()=>{process.stdout.write('SIZE:'+process.stdout.columns+'x'+process.stdout.rows+'\\n');process.exit(0);});",
    ],
  });
  const code = await new Promise((resolveResult, reject) => {
    child.once('error', reject);
    child.once('close', resolveResult);
  }).finally(() => clearTimeout(timer));
  assert.equal(code, 0, stderr);
  assert.equal(result, 0, stderr);
  assert.equal(output.includes('SIZE:110x32'), true, output + stderr);
  console.log('Bundled PTY runtime: terminal, resize and input passed');
}
