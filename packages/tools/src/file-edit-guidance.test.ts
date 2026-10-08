import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  applyEdit,
  inspectProject,
  proposeChanges,
  proposeEdit,
  runProjectTool,
  undoEdit,
  writeChanges,
} from './index';
import { runHostFileTool } from './host-files';

const roots: string[] = [];
const signal = new AbortController().signal;
async function setup(content: string) {
  const root = await mkdtemp(join(tmpdir(), 'lodex-edit-guide-'));
  roots.push(root);
  await mkdir(join(root, 'src'));
  const path = join(root, 'src/file.txt');
  await writeFile(path, content);
  const project = await inspectProject(root);
  const run = async (name: string, args: unknown) =>
    JSON.parse(await runProjectTool(project, name, JSON.stringify(args), signal));
  return { root, path, project, run };
}
afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (dirname(resolve(root)) !== resolve(tmpdir())) throw new Error('Unsafe test cleanup');
    await rm(root, { recursive: true, force: true });
  }
});

describe('file editing guidance and evidence', () => {
  it.each(['read_file', 'read_many_files'])(
    '%s identifies partial CRLF source and supplies the whole-file hash for a unique block edit',
    async (tool) => {
      const before = 'first\r\n  repeated\r\nsecond\r\n  repeated\r\n';
      const { path, project, run } = await setup(before);
      const range = { path: 'src/file.txt', startLine: 1, maxLines: 2 };
      const output = await run(tool, tool === 'read_file' ? range : { files: [range] });
      const read = tool === 'read_file' ? output : output.files[0];
      expect(read).toMatchObject({
        bytes: Buffer.byteLength(before),
        lineEnding: 'crlf',
        complete: false,
        sha256: createHash('sha256').update(before).digest('hex'),
      });
      const duplicate = await run('propose_edit', {
        path: range.path,
        expectedHash: read.sha256,
        oldText: '  repeated',
        newText: 'changed',
      });
      expect(duplicate).toMatchObject({
        error: 'EDIT_MATCH',
        recovery: expect.stringContaining('surrounding lines'),
      });
      const oldText = read.lines.map((line: { text: string }) => line.text).join('\n');
      const edit = await proposeEdit(
        project,
        {
          path: range.path,
          expectedHash: read.sha256,
          oldText,
          newText: oldText.replace('repeated', 'changed'),
        },
        signal,
      );
      await applyEdit(project, edit, signal);
      expect(await readFile(path, 'utf8')).toBe(before.replace('repeated', 'changed'));
      const tail = await run('read_file', { path: range.path, startLine: 4 });
      expect(tail).toMatchObject({ truncated: false, complete: false });
    },
  );

  it.each(['propose_edit', 'propose_changes'])(
    '%s edits an empty existing file with its real hash but rejects empty anchors in nonempty files',
    async (tool) => {
      const { path, project, run } = await setup('');
      const read = await run('read_file', { path: 'src/file.txt' });
      expect(read).toMatchObject({ bytes: 0, lineEnding: 'none', complete: true });
      const input = {
        path: 'src/file.txt',
        expectedHash: read.sha256,
        oldText: '',
        newText: 'first\n',
      };
      let revert: () => Promise<unknown>;
      if (tool === 'propose_edit') {
        const edit = await proposeEdit(project, input, signal);
        await applyEdit(project, edit, signal);
        revert = () => undoEdit(project, { ...edit, operation: 'undo' }, signal);
      } else {
        const changes = await proposeChanges(
          project,
          { files: [{ kind: 'edit', ...input }] },
          signal,
        );
        await writeChanges(project, changes, 'apply', signal);
        revert = () => writeChanges(project, { ...changes, operation: 'undo' }, 'undo', signal);
      }
      expect(await readFile(path, 'utf8')).toBe('first\n');
      const current = await run('read_file', { path: input.path });
      const invalid = { ...input, expectedHash: current.sha256, newText: 'overwrite' };
      const result = await run(
        tool,
        tool === 'propose_edit' ? invalid : { files: [{ kind: 'edit', ...invalid }] },
      );
      expect(result.error).toBe('EDIT_MATCH');
      expect(await readFile(path, 'utf8')).toBe('first\n');
      await revert();
      // A successful read verifies the original empty file still exists after undo.
      expect(await readFile(path, 'utf8')).toBe('');
    },
  );

  it('reports mixed endings without presenting a partial range as complete', async () => {
    const { run } = await setup('one\r\ntwo\n');
    expect(await run('read_file', { path: 'src/file.txt' })).toMatchObject({
      lineEnding: 'mixed',
      complete: true,
    });
    expect(
      await run('read_many_files', { files: [{ path: 'src/file.txt', startLine: 2 }] }),
    ).toMatchObject({ files: [{ lineEnding: 'mixed', complete: false }] });
  });

  it.each(['propose_edit', 'propose_changes'])(
    '%s identifies invalid fields without echoing their supplied values',
    async (tool) => {
      const { run } = await setup('source');
      const input = {
        path: 'src/file.txt',
        expectedHash: 'private-invalid-hash',
        oldText: 'source',
        newText: 123456789,
      };
      const result = await run(
        tool,
        tool === 'propose_edit' ? input : { files: [{ kind: 'edit', ...input }] },
      );
      const prefix = tool === 'propose_edit' ? '' : 'files.0.';
      expect(result).toMatchObject({
        error: 'TOOL_ARGUMENTS',
        issues: expect.arrayContaining([
          expect.objectContaining({ path: prefix + 'expectedHash' }),
          expect.objectContaining({ path: prefix + 'newText' }),
        ]),
        recovery: expect.stringContaining('schema'),
      });
      expect(JSON.stringify(result)).not.toContain('private-invalid-hash');
      expect(JSON.stringify(result)).not.toContain('123456789');
    },
  );

  it('does not turn an existing empty file into a create operation', async () => {
    const { path, run } = await setup('');
    expect(
      await run('propose_changes', {
        files: [{ kind: 'create', path: 'src/file.txt', content: 'new' }],
      }),
    ).toMatchObject({ error: 'CREATE_EXISTS', recovery: expect.stringContaining('Read it') });
    expect(await readFile(path, 'utf8')).toBe('');
  });

  it('uses full-content host writes and the returned hash for a second write', async () => {
    const before = 'keep\r\nchange\r\nkeep too\r\n';
    const { path } = await setup(before);
    const read = JSON.parse(
      await runHostFileTool('host_read_file', JSON.stringify({ path }), 'build'),
    );
    const first = JSON.parse(
      await runHostFileTool(
        'host_write_file',
        JSON.stringify({
          path: read.path,
          expectedHash: read.sha256,
          content: read.content.replace('change', 'changed'),
        }),
        'build',
      ),
    );
    const content = before.replace('change', 'changed twice');
    await runHostFileTool(
      'host_write_file',
      JSON.stringify({ path: read.path, expectedHash: first.sha256, content }),
      'build',
    );
    expect(await readFile(path, 'utf8')).toBe(content);
    await expect(
      runHostFileTool(
        'host_write_file',
        JSON.stringify({ path: read.path, expectedHash: null, content: 'unsafe' }),
        'build',
      ),
    ).rejects.toMatchObject({ code: 'HOST_FILE_CONFLICT' });
    expect(await readFile(path, 'utf8')).toBe(content);
  });
});
