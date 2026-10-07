import { afterEach, expect, it } from 'vitest';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '@lodex/storage';
import { defaultModelConfig, defaultPlan, type Session } from '@lodex/contracts';
import { executeHostCommand, inspectProject } from '@lodex/tools';
import { CommandJobs } from './jobs';
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'lodex-jobs-')),
    store = await Store.open(join(dir, 'state.sqlite'), resolve('apps/daemon/dist/worker.cjs')),
    jobs = await CommandJobs.open(store);
  cleanups.push(async () => {
    await jobs.close();
    await store.close();
    if (dirname(resolve(dir)) !== resolve(tmpdir())) throw Error('unsafe');
    await rm(dir, { recursive: true, force: true });
  });
  const project = await inspectProject(dir),
    session: Session = {
      id: crypto.randomUUID(),
      title: 'test',
      version: 1,
      createdAt: '',
      updatedAt: '',
      config: defaultModelConfig(),
      plan: defaultPlan(),
      messages: [],
      run: {
        id: crypto.randomUUID(),
        messageId: crypto.randomUUID(),
        status: 'running',
        startedAt: new Date().toISOString(),
        finishedAt: null,
        actor: 'telegram',
      },
    };
  return { dir, store, jobs, project, session };
}
const nodeCommand = (script: string) =>
  process.platform === 'win32'
    ? `& '${process.execPath.replaceAll("'", "''")}' '${script.replaceAll("'", "''")}'`
    : `'${process.execPath.replaceAll("'", "'\\''")}' '${script.replaceAll("'", "'\\''")}'`;
it('returns a background job immediately, sends live stdin and EOF, and persists final output without stdin content', async () => {
  const app = await setup(),
    script = join(app.dir, 'input.cjs');
  await writeFile(
    script,
    "process.stdout.write('ready\\n');let data='';process.stdin.on('data',c=>data+=c);process.stdin.on('end',()=>{require('fs').writeFileSync('received.txt',data);process.stdout.write('done\\n');});",
  );
  const started = await app.jobs.run(
    app.session,
    {
      project: app.project,
      argumentsJson: JSON.stringify({
        command: nodeCommand(script),
        interactive: true,
        background: true,
        timeoutMs: 30000,
      }),
      signal: new AbortController().signal,
      record: async () => {},
    },
    'host',
    executeHostCommand,
  );
  expect(started.status).toBe('starting');
  expect(started.jobId).toBeDefined();
  await expect
    .poll(() => app.jobs.get(app.session.id, started.jobId!).inputOpen, { timeout: 15000 })
    .toBe(true);
  await expect
    .poll(() => app.jobs.get(app.session.id, started.jobId!).execution?.output, { timeout: 15000 })
    .toContain('ready');
  expect(() => app.jobs.get(crypto.randomUUID(), started.jobId!)).toThrow('이 대화');
  await app.jobs.input(app.session.id, started.jobId!, '한글 input\n', false);
  await app.jobs.input(app.session.id, started.jobId!, 'secret-input', true);
  await expect
    .poll(() => app.jobs.get(app.session.id, started.jobId!).execution?.status, { timeout: 15000 })
    .toBe('completed');
  expect(await readFile(join(app.dir, 'received.txt'), 'utf8')).toBe('한글 input\nsecret-input');
  const saved = (await app.store.integration('command_jobs'))!.document;
  expect(JSON.stringify(saved)).not.toContain('secret-input');
  const reopened = await CommandJobs.open(app.store);
  expect(reopened.list(app.session.id)[0]).toMatchObject({
    actor: 'telegram',
    inputOpen: false,
    execution: { exitCode: 0, status: 'completed' },
  });
  await reopened.close();
}, 30000);
it('cancels a background command and records failure instead of respawning on restart', async () => {
  const app = await setup(),
    script = join(app.dir, 'wait.cjs');
  await writeFile(script, "process.stdout.write('waiting\\n');setInterval(()=>{},1000);");
  const started = await app.jobs.run(
    app.session,
    {
      project: app.project,
      argumentsJson: JSON.stringify({
        command: nodeCommand(script),
        background: true,
        timeoutMs: 30000,
      }),
      signal: new AbortController().signal,
      record: async () => {},
    },
    'host',
    executeHostCommand,
  );
  await expect
    .poll(() => app.jobs.get(app.session.id, started.jobId!).execution?.output, { timeout: 15000 })
    .toContain('waiting');
  const stopped = await app.jobs.stop(app.session.id, started.jobId!);
  expect(stopped.execution?.status).toBe('cancelled');
  expect(stopped.execution?.exitCode).toBeNull();
  await expect(
    app.jobs.input(app.session.id, started.jobId!, 'ignored', false),
  ).rejects.toMatchObject({ code: 'COMMAND_INPUT_CLOSED' });
  const saved = (await app.store.integration('command_jobs'))!;
  const records = saved.document as import('@lodex/contracts').CommandJob[];
  records[0]!.execution!.status = 'running';
  await app.store.saveIntegration('command_jobs', saved.version, records);
  const reopened = await CommandJobs.open(app.store);
  expect(reopened.list(app.session.id)[0]!.execution?.status).toBe('interrupted');
  await reopened.close();
}, 30000);
