import { afterEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '@lodex/storage';
import { inspectProject } from '@lodex/tools';
import { Worktrees } from './worktrees';
const exec = promisify(execFile),
  cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});
async function setup(git = true) {
  const dir = await mkdtemp(join(tmpdir(), 'lodex-worktree 한글-')),
    repo = join(dir, 'repo');
  await mkdir(repo);
  const store = await Store.open(join(dir, 'state.sqlite'), resolve('apps/daemon/dist/worker.cjs'));
  const manager = await Worktrees.open(store, join(dir, 'managed'));
  cleanup.push(async () => {
    await manager.close();
    await store.close();
    if (dirname(resolve(dir)) !== resolve(tmpdir())) throw new Error('Unsafe fixture');
    await rm(dir, { recursive: true, force: true });
  });
  const run = (...args: string[]) =>
    exec(
      'git',
      ['-c', 'core.hooksPath=' + join(dir, 'no-hooks'), '-c', 'core.autocrlf=false', ...args],
      { cwd: repo, windowsHide: true },
    );
  if (git) {
    await run('init', '-b', 'main');
    await writeFile(join(repo, 'file.txt'), 'committed\n');
    await run('add', 'file.txt');
    await run(
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '-m',
      'base',
    );
  }
  const project = await store.registerProject(await inspectProject(repo));
  return { dir, repo, store, manager, project, run };
}
describe('isolated worktree projects', () => {
  it('starts from committed HEAD and preserves original dirty and untracked files', async () => {
    const app = await setup();
    await writeFile(join(app.repo, 'file.txt'), 'user edits\n');
    await writeFile(join(app.repo, 'untracked.txt'), 'private draft');
    const before = (await app.run('status', '--porcelain')).stdout;
    const result = await app.manager.create(app.project, new AbortController().signal);
    expect(await readFile(join(result.project.path, 'file.txt'), 'utf8')).toBe('committed\n');
    expect(await readFile(join(app.repo, 'file.txt'), 'utf8')).toBe('user edits\n');
    expect((await app.run('status', '--porcelain')).stdout).toBe(before);
    expect((await app.run('branch', '--show-current')).stdout.trim()).toBe('main');
    expect(result.record).toMatchObject({
      status: 'ready',
      sourceProjectId: app.project.id,
      projectId: result.project.id,
    });
    await writeFile(join(result.project.path, 'file.txt'), 'isolated changes\n');
    expect(await readFile(join(app.repo, 'file.txt'), 'utf8')).toBe('user edits\n');
    expect((await app.store.integration('worktrees'))?.document).toEqual([result.record]);
  });
  it('does not run repository checkout filters or hooks', async () => {
    const app = await setup(),
      marker = join(app.dir, 'executed.txt');
    const script = join(app.dir, 'filter.cjs');
    await writeFile(
      script,
      `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran'); process.stdin.pipe(process.stdout);`,
    );
    await writeFile(join(app.repo, '.gitattributes'), 'file.txt filter=fixture\n');
    await app.run('add', '.gitattributes');
    await app.run(
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '-m',
      'attributes',
    );
    await app.run('config', 'filter.fixture.smudge', `"${process.execPath}" "${script}"`);
    await app.run('config', 'filter.fixture.required', 'true');
    await mkdir(join(app.repo, 'hooks'));
    await writeFile(
      join(app.repo, 'hooks', 'post-checkout'),
      `#!/bin/sh\necho hook > '${marker.replaceAll('\\', '/')}'\n`,
      { mode: 0o755 },
    );
    await app.run('config', 'core.hooksPath', join(app.repo, 'hooks'));
    const result = await app.manager.create(app.project, new AbortController().signal);
    expect(await readFile(join(result.project.path, 'file.txt'), 'utf8')).toBe('committed\n');
    await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('rejects non-Git projects and cancellation before creating ownership records', async () => {
    const app = await setup(false);
    await expect(app.manager.create(app.project, new AbortController().signal)).rejects.toThrow();
    expect(app.manager.list()).toEqual([]);
    const stop = new AbortController();
    stop.abort();
    await expect(app.manager.create(app.project, stop.signal)).rejects.toThrow();
    expect(app.manager.list()).toEqual([]);
  });
  it('marks unfinished creation interrupted on reopen without deleting its path', async () => {
    const app = await setup();
    const path = join(app.dir, 'unfinished');
    await mkdir(path);
    await writeFile(join(path, 'user.txt'), 'preserve');
    await app.store.saveIntegration('worktrees', 0, [
      {
        id: crypto.randomUUID(),
        sourceProjectId: app.project.id,
        path,
        branch: 'lodex/fixture',
        baseCommit: 'a'.repeat(40),
        createdAt: new Date().toISOString(),
        status: 'creating',
      },
    ]);
    const reopened = await Worktrees.open(app.store, join(app.dir, 'managed'));
    expect(reopened.list()[0]?.status).toBe('interrupted');
    expect(await readFile(join(path, 'user.txt'), 'utf8')).toBe('preserve');
  });
});
