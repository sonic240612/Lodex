import { afterEach, describe, expect, it } from 'vitest';
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  chmod,
  lstat,
  link,
  rename,
  symlink,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import {
  inspectProject,
  proposeChanges,
  checkChanges,
  writeChanges,
  applyEdit,
  digest,
  runProjectTool,
} from './index';
import type { EditProposal, CreatedFileProposal } from '@lodex/contracts';
const dirs: string[] = [];
const signal = new AbortController().signal;
async function setup() {
  const path = await mkdtemp(join(tmpdir(), 'lodex-changes-한글 '));
  dirs.push(path);
  await mkdir(join(path, 'src'));
  await writeFile(join(path, 'src/a.ts'), '\ufeffconst value = 1;\r\n');
  return { path, project: await inspectProject(path) };
}
const edit = {
  kind: 'edit',
  path: 'src/a.ts',
  expectedHash: digest('\ufeffconst value = 1;\r\n'),
  oldText: 'value = 1',
  newText: 'value = 2',
};
const create = { kind: 'create', path: 'src/new.ts', content: 'export const 새값 = 2;\n' };
afterEach(async () => {
  for (const path of dirs.splice(0)) {
    if (dirname(resolve(path)) !== resolve(tmpdir())) throw new Error('Unsafe cleanup');
    await rm(path, { recursive: true, force: true });
  }
});
describe('reviewed file change sets', () => {
  it('proposes without writes, applies edit/create, and restores bytes and absence exactly once', async () => {
    const { path, project } = await setup();
    const changes = await proposeChanges(project, { files: [edit, create] }, signal);
    await expect(lstat(join(path, create.path))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(path, edit.path), 'utf8')).toContain('value = 1');
    await Promise.all([
      writeChanges(project, changes, 'apply', signal),
      writeChanges(project, changes, 'apply', signal),
    ]);
    expect((await checkChanges(project, changes, signal)).status).toBe('applied');
    expect(await readFile(join(path, edit.path))).toEqual(
      Buffer.from('\ufeffconst value = 2;\r\n'),
    );
    expect(await readFile(join(path, create.path), 'utf8')).toBe(create.content);
    const undone = { ...changes, operation: 'undo' as const };
    await writeChanges(project, undone, 'undo', signal);
    await writeChanges(project, undone, 'undo', signal);
    expect((await checkChanges(project, undone, signal)).status).toBe('reverted');
    expect(await readFile(join(path, edit.path))).toEqual(
      Buffer.from('\ufeffconst value = 1;\r\n'),
    );
    await expect(lstat(join(path, create.path))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('preflights all files and never claims an independently created identical file', async () => {
    const { path, project } = await setup();
    const changes = await proposeChanges(project, { files: [edit, create] }, signal);
    await writeFile(join(path, create.path), create.content);
    await expect(writeChanges(project, changes, 'apply', signal)).rejects.toMatchObject({
      code: 'EDIT_CONFLICT',
    });
    await expect(writeChanges(project, changes, 'undo', signal)).rejects.toMatchObject({
      code: 'EDIT_CONFLICT',
    });
    expect(await readFile(join(path, edit.path), 'utf8')).toContain('value = 1');
    expect(await readFile(join(path, create.path), 'utf8')).toBe(create.content);
  });
  it('refuses to undo replaced created files even when bytes are identical', async () => {
    const { path, project } = await setup();
    const changes = await proposeChanges(project, { files: [edit, create] }, signal);
    await writeChanges(project, changes, 'apply', signal);
    await rename(join(path, create.path), join(path, 'saved.ts'));
    await writeFile(join(path, create.path), create.content);
    await expect(writeChanges(project, changes, 'undo', signal)).rejects.toMatchObject({
      code: 'EDIT_CONFLICT',
    });
    expect(await readFile(join(path, edit.path), 'utf8')).toContain('value = 2');
    expect(await readFile(join(path, create.path), 'utf8')).toBe(create.content);
  });
  it('exposes partial effects after a write failure, then finishes only the remaining files', async () => {
    const { path, project } = await setup();
    const second = { ...edit, path: 'src/b.ts' };
    await writeFile(join(path, second.path), '\ufeffconst value = 1;\r\n');
    const changes = await proposeChanges(project, { files: [edit, second] }, signal);
    await chmod(join(path, second.path), 0o444);
    try {
      await expect(writeChanges(project, changes, 'apply', signal)).rejects.toMatchObject({
        code: 'EDIT_READ_ONLY',
      });
      const partial = await checkChanges(project, changes, signal);
      expect(partial.status).toBe('partial');
      expect(partial.observations?.map((o) => o.state)).toEqual(['after', 'before']);
    } finally {
      await chmod(join(path, second.path), 0o644);
    }
    await writeChanges(project, changes, 'apply', signal);
    expect((await checkChanges(project, changes, signal)).status).toBe('applied');
  });
  it('can undo only the applied subset after interruption', async () => {
    const { path, project } = await setup();
    const changes = await proposeChanges(project, { files: [edit, create] }, signal);
    await applyEdit(project, changes.files[0] as EditProposal, signal);
    expect((await checkChanges(project, changes, signal)).status).toBe('partial');
    await writeChanges(project, changes, 'undo', signal);
    expect(await readFile(join(path, edit.path), 'utf8')).toContain('value = 1');
    await expect(lstat(join(path, create.path))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('reconciles a crash after atomic publication and before staging-link cleanup', async () => {
    const { path, project } = await setup();
    const changes = await proposeChanges(project, { files: [create] }, signal);
    const file = changes.files[0] as CreatedFileProposal;
    const staged = join(path, 'src', '.lodex-edit-' + file.stagingId + '.tmp');
    await writeFile(staged, file.content);
    const info = await lstat(staged);
    file.identity = info.dev + ':' + info.ino;
    await link(staged, join(path, file.path));
    expect((await checkChanges(project, changes, signal)).status).toBe('applied');
    expect((await lstat(join(path, file.path))).nlink).toBe(1);
    await expect(lstat(staged)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(
      JSON.parse(
        await runProjectTool(project, 'read_file', JSON.stringify({ path: file.path }), signal),
      ).sha256,
    ).toBe(file.afterHash);
  });
  it('does not publish if persisting created-file identity fails', async () => {
    const { path, project } = await setup();
    const changes = await proposeChanges(project, { files: [create] }, signal);
    await expect(
      writeChanges(project, changes, 'apply', signal, async () => {
        throw new Error('storage failed');
      }),
    ).rejects.toThrow('storage failed');
    await expect(lstat(join(path, create.path))).rejects.toMatchObject({ code: 'ENOENT' });
    await writeChanges(project, changes, 'apply', signal);
    expect((await checkChanges(project, changes, signal)).status).toBe('applied');
  });
  it('creates and can undo a reviewed project dotenv without exposing it to read tools', async () => {
    const { path, project } = await setup();
    const dotenv = { kind: 'create' as const, path: '.env', content: 'APP_MODE=local\n' };
    const changes = await proposeChanges(project, { files: [dotenv] }, signal);
    await writeChanges(project, changes, 'apply', signal);
    expect(await readFile(join(path, '.env'), 'utf8')).toBe(dotenv.content);
    expect((await checkChanges(project, changes, signal)).status).toBe('applied');
    expect(
      JSON.parse(
        await runProjectTool(project, 'read_file', JSON.stringify({ path: '.env' }), signal),
      ).error,
    ).toBe('PATH_DENIED');
    await expect(
      proposeChanges(project, { files: [{ ...dotenv, content: 'APP_MODE=cloud\n' }] }, signal),
    ).rejects.toMatchObject({ code: 'CREATE_EXISTS' });
    await writeChanges(project, { ...changes, operation: 'undo' }, 'undo', signal);
    await expect(lstat(join(path, '.env'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it.each(['../escape.ts', 'src/.env', 'src/NUL.txt', 'src/space. ', 'missing/file.ts'])(
    'rejects unsupported creation path %s',
    async (path) => {
      const { project } = await setup();
      await expect(
        proposeChanges(project, { files: [{ ...create, path }] }, signal),
      ).rejects.toThrow();
    },
  );
  it('rejects duplicate normalized paths and symlink parents', async () => {
    const { path, project } = await setup();
    await expect(
      proposeChanges(project, { files: [create, { ...create, path: 'src/./NEW.ts' }] }, signal),
    ).rejects.toMatchObject({ code: 'CHANGE_DUPLICATE' });
    await symlink(
      join(path, 'src'),
      join(path, 'alias'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    await expect(
      proposeChanges(project, { files: [{ ...create, path: 'alias/new.ts' }] }, signal),
    ).rejects.toMatchObject({ code: 'PATH_DENIED' });
  });
});
