import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPty } from './pty';
const directories: string[] = [];
afterEach(async () => {
  for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true });
});
async function directory() {
  const path = await mkdtemp(join(tmpdir(), 'lodex-pty-'));
  directories.push(path);
  return path;
}

it('runs a real terminal, resizes it and transports raw interactive input', async () => {
  const cwd = await directory(),
    path = join(cwd, 'terminal.cjs');
  await writeFile(
    path,
    `
    process.stdin.setRawMode(true);
    process.stdout.write('PTY_READY:' + process.stdin.isTTY + ':' + process.stdout.isTTY + '\\n');
    process.stdin.on('data', (data) => {
      require('fs').writeFileSync('result.json', JSON.stringify({ input: data.toString(), cols: process.stdout.columns, rows: process.stdout.rows }));
      process.stdout.write('\\x1b[32mPTY_DONE\\x1b[0m'); process.exit(0);
    });
  `,
  );
  let write: ((text: string, eof: boolean) => void) | undefined,
    resize: ((cols: number, rows: number) => void) | undefined,
    sent = false;
  const result = await runPty({
    executable: process.execPath,
    args: [path],
    cwd,
    env: process.env,
    signal: AbortSignal.timeout(10000),
    inputControl: (callback) => {
      write = callback;
      return () => {
        write = undefined;
      };
    },
    terminal: {
      cols: 90,
      rows: 24,
      control: (callback) => {
        resize = callback;
        return () => {
          resize = undefined;
        };
      },
    },
    progress: (output) => {
      if (!sent && output.includes('PTY_READY:true:true')) {
        sent = true;
        resize!(112, 35);
        setTimeout(() => write?.('q', false), 150);
      }
    },
  });
  expect(result.code).toBe(0);
  expect(result.output).toContain('PTY_DONE');
  expect(JSON.parse(await readFile(join(cwd, 'result.json'), 'utf8'))).toEqual({
    input: 'q',
    cols: 112,
    rows: 35,
  });
  expect(write).toBeUndefined();
  expect(resize).toBeUndefined();
}, 15000);

it('sends the platform EOF key without claiming that a PTY pipe was closed', async () => {
  const cwd = await directory(),
    path = join(cwd, 'eof.cjs');
  await writeFile(
    path,
    `process.stdin.setRawMode(true);process.stdout.write('EOF_READY');process.stdin.on('data',data=>{require('fs').writeFileSync('eof.json',JSON.stringify([...data]));process.exit(0);});`,
  );
  let write: ((text: string, eof: boolean) => void) | undefined,
    sent = false;
  const result = await runPty({
    executable: process.execPath,
    args: [path],
    cwd,
    env: process.env,
    signal: AbortSignal.timeout(10000),
    terminal: { cols: 80, rows: 24 },
    inputControl: (callback) => {
      write = callback;
      return () => {};
    },
    progress: (output) => {
      if (!sent && output.includes('EOF_READY')) {
        sent = true;
        write!('', true);
      }
    },
  });
  expect(result.code).toBe(0);
  expect(JSON.parse(await readFile(join(cwd, 'eof.json'), 'utf8'))[0]).toBe(
    process.platform === 'win32' ? 26 : 4,
  );
}, 15000);

it('cancels its owned terminal process tree, including an active child', async () => {
  const cwd = await directory(),
    path = join(cwd, 'parent.cjs');
  await writeFile(
    path,
    `
    const child=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'});
    require('fs').writeFileSync('child.pid',String(child.pid));
    process.stdout.write('TREE_READY');setInterval(()=>{},1000);
  `,
  );
  const abort = new AbortController();
  const result = await runPty({
    executable: process.execPath,
    args: [path],
    cwd,
    env: process.env,
    signal: AbortSignal.any([abort.signal, AbortSignal.timeout(10000)]),
    terminal: { cols: 80, rows: 24 },
    progress: (output) => {
      if (output.includes('TREE_READY')) abort.abort();
    },
  });
  expect(result.code).toBeNull();
  const pid = Number(await readFile(join(cwd, 'child.pid'), 'utf8'));
  await expect
    .poll(
      () => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      },
      { timeout: 5000 },
    )
    .toBe(false);
}, 15000);
