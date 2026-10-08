import { afterEach, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  unlink,
  rename,
  link,
  open,
} from 'node:fs/promises';
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
it('reviews more than eight files in independent pages, supports selected paths, and rejects stale page versions', async () => {
  const app = await setup();
  for (let index = 0; index < 25; index++)
    await writeFile(
      join(app.child.project.path, `new-${String(index).padStart(2, '0')}.txt`),
      'work ' + index,
    );
  const first = await app.reviews.preview(app.child.record.id, signal(), { limit: 10 });
  expect(first.files).toHaveLength(10);
  expect(first.totalPaths).toBe(25);
  expect(first.nextOffset).toBe(10);
  await app.reviews.apply(first.id, {}, signal());
  await expect(readFile(join(app.repo, 'new-10.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  const selected = await app.reviews.preview(app.child.record.id, signal(), {
    paths: ['new-24.txt'],
    reviewVersion: first.reviewVersion,
  });
  expect(selected.files.map((file) => file.path)).toEqual(['new-24.txt']);
  await app.reviews.apply(selected.id, {}, signal());
  const second = await app.reviews.preview(app.child.record.id, signal(), {
    offset: 10,
    limit: 10,
    reviewVersion: first.reviewVersion,
  });
  expect(second.files).toHaveLength(10);
  await writeFile(join(app.child.project.path, 'new-00.txt'), 'later');
  await expect(
    app.reviews.preview(app.child.record.id, signal(), {
      offset: 20,
      reviewVersion: first.reviewVersion,
    }),
  ).rejects.toMatchObject({ code: 'WORKTREE_STALE' });
  await expect(app.reviews.apply(second.id, {}, signal())).rejects.toMatchObject({
    code: 'WORKTREE_STALE',
  });
});
it('applies large UTF-8 conflicts and restores durable original bytes after reopening the reviewer', async () => {
  const app = await setup(),
    original = '사용자 내용\n'.repeat(9000),
    resolved = '해결한 내용\n'.repeat(12000);
  await writeFile(join(app.repo, 'file.txt'), original);
  await writeFile(join(app.child.project.path, 'file.txt'), '서브 작업 내용\n'.repeat(10000));
  const preview = await app.reviews.preview(app.child.record.id, signal());
  expect(preview.files[0]!.conflict).toBe(true);
  expect(preview.files[0]!.binary).toBe(false);
  await app.reviews.apply(preview.id, { 'file.txt': resolved }, signal());
  expect(await readFile(join(app.repo, 'file.txt'), 'utf8')).toBe(resolved);
  const reopened = await Worktrees.open(app.store, join(app.dir, 'managed'));
  const reviews = new WorktreeReviews(app.store, reopened);
  await reviews.undo(app.child.record.id, signal());
  expect(await readFile(join(app.repo, 'file.txt'), 'utf8')).toBe(original);
  expect(reopened.list()[0]!.merge!.status).toBe('reverted');
});
it('requires explicit binary choices, applies exact bytes, and undoes creation and deletion safely', async () => {
  const app = await setup(),
    bytes = Buffer.from([0, 255, 254, 13, 10, 88]);
  await writeFile(join(app.child.project.path, 'binary.dat'), bytes);
  await unlink(join(app.child.project.path, 'delete.txt'));
  const preview = await app.reviews.preview(app.child.record.id, signal());
  expect(preview.files.find((file) => file.path === 'binary.dat')).toMatchObject({
    binary: true,
    conflict: true,
    theirsBytes: bytes.length,
  });
  await expect(app.reviews.apply(preview.id, {}, signal())).rejects.toMatchObject({
    code: 'WORKTREE_CONFLICT',
  });
  await expect(
    app.reviews.apply(preview.id, { 'binary.dat': null }, signal()),
  ).rejects.toMatchObject({ code: 'WORKTREE_CONFLICT' });
  await app.reviews.apply(preview.id, { 'binary.dat': { choice: 'theirs' } }, signal());
  expect(await readFile(join(app.repo, 'binary.dat'))).toEqual(bytes);
  await app.reviews.undo(app.child.record.id, signal());
  await expect(readFile(join(app.repo, 'binary.dat'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await readFile(join(app.repo, 'delete.txt'), 'utf8')).toBe('remove\n');
});
it('rejects same-content inode replacement, hard links, and changes after an applied merge before undo', async () => {
  const app = await setup();
  await writeFile(join(app.child.project.path, 'file.txt'), 'updated\n');
  let preview = await app.reviews.preview(app.child.record.id, signal());
  await writeFile(join(app.repo, 'replacement.tmp'), await readFile(join(app.repo, 'file.txt')));
  await rename(join(app.repo, 'replacement.tmp'), join(app.repo, 'file.txt'));
  await expect(app.reviews.apply(preview.id, {}, signal())).rejects.toMatchObject({
    code: 'WORKTREE_STALE',
  });
  preview = await app.reviews.preview(app.child.record.id, signal());
  await app.reviews.apply(preview.id, {}, signal());
  await writeFile(join(app.repo, 'file.txt'), 'user changed after merge');
  await expect(app.reviews.undo(app.child.record.id, signal())).rejects.toMatchObject({
    code: 'WORKTREE_UNDO_CONFLICT',
  });
  expect(await readFile(join(app.repo, 'file.txt'), 'utf8')).toBe('user changed after merge');
  await link(join(app.child.project.path, 'file.txt'), join(app.child.project.path, 'linked.txt'));
  await expect(app.reviews.preview(app.child.record.id, signal())).rejects.toMatchObject({
    code: 'WORKTREE_FILE',
  });
});
it('archives only reviewed changes, preserves a recoverable Git snapshot and source index, and rejects ignored files', async () => {
  const app = await setup();
  await writeFile(join(app.child.project.path, 'created.txt'), 'recover me');
  await expect(app.worktrees.archive(app.child.record.id, signal())).rejects.toMatchObject({
    code: 'WORKTREE_UNMERGED',
  });
  const preview = await app.reviews.preview(app.child.record.id, signal());
  await app.reviews.apply(preview.id, {}, signal());
  await writeFile(join(app.child.project.path, '.gitignore'), 'ignored.tmp\n');
  await writeFile(join(app.child.project.path, 'ignored.tmp'), 'must preserve');
  await expect(app.worktrees.archive(app.child.record.id, signal())).rejects.toMatchObject({
    code: 'WORKTREE_IGNORED',
  });
  expect(await readFile(join(app.child.project.path, 'ignored.tmp'), 'utf8')).toBe('must preserve');
  await unlink(join(app.child.project.path, 'ignored.tmp'));
  await unlink(join(app.child.project.path, '.gitignore'));
  const sourceBefore = (await app.git('status', '--porcelain')).stdout;
  const archived = await app.worktrees.archive(app.child.record.id, signal());
  expect(archived.status).toBe('archived');
  expect(archived.archive?.commit).toMatch(/^[0-9a-f]{40,64}$/);
  expect((await app.git('show', archived.archive!.ref + ':created.txt')).stdout).toBe('recover me');
  expect((await app.git('status', '--porcelain')).stdout).toBe(sourceBefore);
  await expect(readFile(join(app.child.project.path, 'created.txt'))).rejects.toMatchObject({
    code: 'ENOENT',
  });
  expect(await readFile(join(app.repo, 'created.txt'), 'utf8')).toBe('recover me');
});
it('never archives changed Git registration or a forged path pointing at the source project', async () => {
  const app = await setup();
  const gitFile = join(app.child.project.path, '.git'),
    original = await readFile(gitFile);
  const changeGitFile = async (value: Buffer) => {
    const handle = await open(gitFile, 'r+');
    try {
      await handle.writeFile(value);
      await handle.truncate(value.length);
    } finally {
      await handle.close();
    }
  };
  await changeGitFile(Buffer.concat([original, Buffer.from('\n')]));
  await expect(app.worktrees.archive(app.child.record.id, signal())).rejects.toMatchObject({
    code: 'WORKTREE_OWNERSHIP',
  });
  await changeGitFile(original);
  const state = await app.store.integration('worktrees'),
    records = app.worktrees.list();
  records[0]!.path = app.repo;
  await app.store.saveIntegration('worktrees', state!.version, records);
  const reopened = await Worktrees.open(app.store, join(app.dir, 'managed'));
  await expect(reopened.archive(app.child.record.id, signal())).rejects.toMatchObject({
    code: 'WORKTREE_PATH',
  });
  expect(await readFile(join(app.repo, 'file.txt'), 'utf8')).toContain('one');
});
