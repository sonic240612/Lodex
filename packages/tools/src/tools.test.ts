import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, symlink, rm, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  inspectProject,
  runProjectTool,
  proposeEdit,
  applyEdit,
  undoEdit,
  checkEdit,
} from './index';
import { createHash } from 'node:crypto';
const directories: string[] = [];
async function setup() {
  const path = await mkdtemp(join(tmpdir(), 'lodex-project-한글 '));
  directories.push(path);
  await mkdir(join(path, 'src'));
  await writeFile(join(path, 'src', 'hello.ts'), 'export const hello = "안녕";\n// needle\n');
  await writeFile(join(path, '.env'), 'PRIVATE_KEY=secret');
  await mkdir(join(path, 'node_modules'));
  await writeFile(join(path, 'node_modules', 'skip.txt'), 'needle');
  const project = await inspectProject(path);
  return {
    path,
    project,
    run: async (name: string, args: unknown) =>
      JSON.parse(
        await runProjectTool(project, name, JSON.stringify(args), new AbortController().signal),
      ),
  };
}
afterEach(async () => {
  for (const dir of directories.splice(0)) {
    if (dirname(resolve(dir)) !== resolve(tmpdir())) throw new Error('Unsafe test path');
    await rm(dir, { recursive: true, force: true });
  }
});
describe('project read tools', () => {
  it.each(['', 'same', '한글\n둘째 줄'])(
    'undoes exact bytes even for empty/repeated replacement %j',
    async (replacement) => {
      const { path, project } = await setup();
      const file = join(path, 'src', 'hello.ts'),
        before = '\ufeffprefix old / same\r\nsuffix\r\n';
      await writeFile(file, before);
      const signal = new AbortController().signal;
      const edit = await proposeEdit(
        project,
        {
          path: 'src/hello.ts',
          expectedHash: createHash('sha256').update(before).digest('hex'),
          oldText: 'old',
          newText: replacement,
        },
        signal,
      );
      await applyEdit(project, edit, signal);
      const undo = { ...edit, operation: 'undo' as const };
      await Promise.all([undoEdit(project, undo, signal), undoEdit(project, undo, signal)]);
      expect(await readFile(file)).toEqual(Buffer.from(before));
      expect(await checkEdit(project, undo, signal)).toBe('reverted');
    },
  );
  it('refuses undo after external edits and refuses ambiguous legacy offsets', async () => {
    const { path, project } = await setup();
    const file = join(path, 'src', 'hello.ts'),
      before = 'old same';
    await writeFile(file, before);
    const signal = new AbortController().signal;
    const edit = await proposeEdit(
      project,
      {
        path: 'src/hello.ts',
        expectedHash: createHash('sha256').update(before).digest('hex'),
        oldText: 'old',
        newText: 'same',
      },
      signal,
    );
    await applyEdit(project, edit, signal);
    const legacy = { ...edit };
    delete legacy.offset;
    await expect(undoEdit(project, legacy, signal)).rejects.toMatchObject({ code: 'UNDO_LEGACY' });
    expect(await readFile(file, 'utf8')).toBe('same same');
    await writeFile(file, 'user changed');
    await expect(undoEdit(project, edit, signal)).rejects.toMatchObject({ code: 'EDIT_CONFLICT' });
    expect(await readFile(file, 'utf8')).toBe('user changed');
  });
  it('proposes without writing, then applies exactly once while preserving BOM and CRLF', async () => {
    const { path, project, run } = await setup();
    const file = join(path, 'src', 'hello.ts');
    const before = '\ufeffconst 값 = 1;\r\nconst 다음 = 2;\r\n';
    await writeFile(file, before);
    const { sha256 } = await run('read_file', { path: 'src/hello.ts' });
    expect(sha256).toBe(
      createHash('sha256')
        .update(await readFile(file))
        .digest('hex'),
    );
    const signal = new AbortController().signal;
    const edit = await proposeEdit(
      project,
      {
        path: 'src/hello.ts',
        expectedHash: sha256,
        oldText: 'const 값 = 1;\n',
        newText: 'const 값 = 3;\n',
      },
      signal,
    );
    expect(await readFile(file, 'utf8')).toBe(before);
    expect(edit.diff).toContain('+\ufeffconst 값 = 3;');
    await Promise.all([applyEdit(project, edit, signal), applyEdit(project, edit, signal)]);
    expect(await readFile(file, 'utf8')).toBe(before.replace('= 1;', '= 3;'));
    expect(await checkEdit(project, edit, signal)).toBe('applied');
    expect((await run('list_files', { path: 'src' })).entries).toHaveLength(1);
  });
  it('rejects stale edits and cancellation without overwriting user changes', async () => {
    const { path, project, run } = await setup();
    const { sha256 } = await run('read_file', { path: 'src/hello.ts' });
    const signal = new AbortController().signal;
    const edit = await proposeEdit(
      project,
      { path: 'src/hello.ts', expectedHash: sha256, oldText: '안녕', newText: '반가워' },
      signal,
    );
    const abort = new AbortController();
    abort.abort();
    await expect(applyEdit(project, edit, abort.signal)).rejects.toThrow();
    await writeFile(join(path, 'src', 'hello.ts'), 'user changed');
    await expect(applyEdit(project, edit, signal)).rejects.toMatchObject({ code: 'EDIT_CONFLICT' });
    expect(await readFile(join(path, 'src', 'hello.ts'), 'utf8')).toBe('user changed');
    expect(await checkEdit(project, edit, signal)).toBe('conflict');
  });
  it('rejects ambiguous replacements and forbidden edit paths', async () => {
    const { path, run } = await setup();
    await writeFile(join(path, 'src', 'hello.ts'), 'repeat repeat');
    const { sha256 } = await run('read_file', { path: 'src/hello.ts' });
    expect(
      (
        await run('propose_edit', {
          path: 'src/hello.ts',
          expectedHash: sha256,
          oldText: 'repeat',
          newText: 'new',
        })
      ).error,
    ).toBe('EDIT_MATCH');
    expect(
      (
        await run('propose_edit', {
          path: '.env',
          expectedHash: sha256,
          oldText: 'secret',
          newText: 'new',
        })
      ).error,
    ).toBe('PATH_DENIED');
  });
  it('lists, reads and searches real UTF-8 files without changing them', async () => {
    const { path, run } = await setup();
    expect((await run('list_files', { path: '.' })).entries).toEqual([
      { name: 'src', directory: true },
    ]);
    expect(
      (await run('read_file', { path: 'src/hello.ts', startLine: 2, maxLines: 1 })).lines,
    ).toEqual([{ line: 2, text: '// needle' }]);
    expect((await run('search_text', { query: 'needle' })).matches).toEqual([
      { path: 'src/hello.ts', line: 2, text: '// needle' },
    ]);
    expect(await readFile(join(path, 'src/hello.ts'), 'utf8')).toBe(
      'export const hello = "안녕";\n// needle\n',
    );
  });
  it.each([
    '../outside.txt',
    '/etc/passwd',
    'src/../../outside',
    '.env',
    'node_modules/skip.txt',
    'src/hello.ts:secret',
  ])('rejects forbidden path %s', async (path) => {
    const { run } = await setup();
    expect((await run('read_file', { path })).error).toBe('PATH_DENIED');
  });
  it('rejects junctions/symlinks outside the project', async () => {
    const { path, run } = await setup();
    const outside = await mkdtemp(join(tmpdir(), 'lodex-outside-'));
    directories.push(outside);
    await writeFile(join(outside, 'secret.txt'), 'OUTSIDE_SECRET');
    await symlink(
      outside,
      join(path, 'external'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    expect((await run('read_file', { path: 'external/secret.txt' })).error).toBe('PATH_DENIED');
  });
  it('validates schemas, rejects executable tools and honors cancellation', async () => {
    const { project, run } = await setup();
    expect((await run('read_file', { path: 'src/hello.ts', extra: true })).error).toBe(
      'TOOL_ARGUMENTS',
    );
    expect((await run('exec', { command: 'anything' })).error).toBe('TOOL_UNAVAILABLE');
    await expect(
      runProjectTool(project, 'list_files', '{}', AbortSignal.abort(new Error('stop'))),
    ).rejects.toThrow('stop');
  });
  it('rejects binary/oversized files and reports search limits', async () => {
    const { path, run } = await setup();
    await writeFile(join(path, 'binary'), Buffer.from([0, 1, 2]));
    await writeFile(join(path, 'large.txt'), 'x'.repeat(1024 * 1024 + 1));
    expect((await run('read_file', { path: 'binary' })).error).toBe('FILE_UNSUPPORTED');
    expect((await run('read_file', { path: 'large.txt' })).error).toBe('FILE_UNSUPPORTED');
    expect((await run('search_text', { query: 'needle', maxResults: 1 })).truncated).toBe(true);
  });
});
