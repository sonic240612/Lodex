import { afterEach, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, rm, unlink } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '@lodex/storage';
import { inspectProject } from '@lodex/tools';
import { Worktrees } from './worktrees';
import { WorktreeReviews } from './worktree-reviews';
const run = promisify(execFile),
  close: (() => Promise<void>)[] = [],
  signal = () => new AbortController().signal;
afterEach(async () => {
  for (const fn of close.splice(0)) await fn();
});
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'lodex-review-')),
    repo = join(dir, 'repo');
  await mkdir(repo);
  const store = await Store.open(join(dir, 'state.sqlite'), resolve('apps/daemon/dist/worker.cjs')),
    worktrees = await Worktrees.open(store, join(dir, 'managed'));
  close.push(async () => {
    await worktrees.close();
    await store.close();
    if (dirname(resolve(dir)) !== resolve(tmpdir())) throw Error('unsafe');
    await rm(dir, { recursive: true, force: true });
  });
  const git = (...args: string[]) =>
    run(
      'git',
      ['-c', 'core.hooksPath=' + join(dir, 'none'), '-c', 'core.autocrlf=false', ...args],
      { cwd: repo, windowsHide: true },
    );
  await git('init', '-b', 'main');
  await writeFile(join(repo, 'file.txt'), 'one\ntwo\nthree\nfour\nfive\nsix\n');
  await writeFile(join(repo, 'delete.txt'), 'remove\n');
  await writeFile(join(repo, 'empty.txt'), '');
  await git('add', '.');
  await git(
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-m',
    'base',
  );
  const source = await store.registerProject(await inspectProject(repo)),
    child = await worktrees.create(source, signal()),
    reviews = new WorktreeReviews(store, worktrees);
  return { dir, repo, source, child, store, worktrees, reviews, git };
}
it('three-way merges disjoint user edits, creates/deletes files, and leaves the source index untouched', async () => {
  const app = await setup();
  await writeFile(join(app.repo, 'file.txt'), 'ONE\ntwo\nthree\nfour\nfive\nsix\n');
  await writeFile(join(app.child.project.path, 'file.txt'), 'one\ntwo\nthree\nfour\nfive\nSIX\n');
  await mkdir(join(app.child.project.path, 'new'));
  await writeFile(join(app.child.project.path, 'new/new.txt'), 'created\n');
  await writeFile(join(app.child.project.path, 'empty.txt'), 'now filled\n');
  await unlink(join(app.child.project.path, 'delete.txt'));
  const index = (await app.git('diff', '--cached', '--name-only')).stdout;
  const preview = await app.reviews.preview(app.child.record.id, signal());
  expect(preview.files).toHaveLength(4);
  expect(preview.files.every((file) => !file.conflict)).toBe(true);
  await app.reviews.apply(preview.id, {}, signal());
  expect(await readFile(join(app.repo, 'file.txt'), 'utf8')).toBe(
    'ONE\ntwo\nthree\nfour\nfive\nSIX\n',
  );
  expect(await readFile(join(app.repo, 'new/new.txt'), 'utf8')).toBe('created\n');
  expect(await readFile(join(app.repo, 'empty.txt'), 'utf8')).toBe('now filled\n');
  await expect(readFile(join(app.repo, 'delete.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect((await app.git('diff', '--cached', '--name-only')).stdout).toBe(index);
  expect(app.worktrees.list()[0]!.merge?.status).toBe('applied');
});
it('requires conflict resolution and rejects source or child changes after review', async () => {
  const app = await setup();
  await writeFile(join(app.repo, 'file.txt'), 'mine\n');
  await writeFile(join(app.child.project.path, 'file.txt'), 'theirs\n');
  let preview = await app.reviews.preview(app.child.record.id, signal());
  expect(preview.files[0]!.conflict).toBe(true);
  await expect(app.reviews.apply(preview.id, {}, signal())).rejects.toMatchObject({
    code: 'WORKTREE_CONFLICT',
  });
  await expect(
    app.reviews.apply(preview.id, { 'file.txt': preview.files[0]!.merged }, signal()),
  ).rejects.toMatchObject({ code: 'WORKTREE_CONFLICT' });
  await writeFile(join(app.child.project.path, 'file.txt'), 'later\n');
  await expect(
    app.reviews.apply(preview.id, { 'file.txt': 'resolved\n' }, signal()),
  ).rejects.toMatchObject({ code: 'WORKTREE_STALE' });
  expect(await readFile(join(app.repo, 'file.txt'), 'utf8')).toBe('mine\n');
  preview = await app.reviews.preview(app.child.record.id, signal());
  await app.reviews.apply(preview.id, { 'file.txt': 'mine and later\n' }, signal());
  expect(await readFile(join(app.repo, 'file.txt'), 'utf8')).toBe('mine and later\n');
});
