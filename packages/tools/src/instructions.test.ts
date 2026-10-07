import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectProject, readProjectInstructions } from './index';
const folders: string[] = [];
afterEach(async () => {
  for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true });
});
it('loads inherited and nested guidance with scopes, precedence and content hashes', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'lodex-instructions-'));
  folders.push(folder);
  await mkdir(join(folder, 'src'));
  await mkdir(join(folder, 'node_modules'));
  for (const [path, content] of [
    ['CLAUDE.md', 'general'],
    ['AGENTS.md', 'root policy'],
    ['AGENTS.override.md', 'override'],
    ['src/AGENTS.md', 'nested rule'],
    ['node_modules/AGENTS.md', 'dependency rule'],
  ])
    await writeFile(join(folder, path!), content!);
  const result = await readProjectInstructions(
    await inspectProject(folder),
    new AbortController().signal,
  );
  expect(result.sources.map((source) => source.path)).toEqual([
    'CLAUDE.md',
    'AGENTS.md',
    'AGENTS.override.md',
    'src/AGENTS.md',
  ]);
  expect(result.sources.at(-1)).toMatchObject({
    scope: 'src',
    sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
  });
  expect(result.text).toContain('application permissions take precedence');
  expect(result.text).not.toContain('dependency rule');
  await writeFile(join(folder, 'AGENTS.md'), 'updated');
  expect(
    (await readProjectInstructions(await inspectProject(folder), new AbortController().signal))
      .sources[1]!.sha256,
  ).not.toBe(result.sources[1]!.sha256);
});
it('reports oversized files, refuses links, and respects cancellation', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'lodex-instructions-'));
  folders.push(folder);
  await writeFile(join(folder, 'AGENTS.md'), 'x'.repeat(17000));
  const project = await inspectProject(folder),
    result = await readProjectInstructions(project, new AbortController().signal);
  expect(result.sources).toEqual([]);
  expect(result.warnings[0]).toContain('size limit');
  const outside = await mkdtemp(join(tmpdir(), 'lodex-instructions-outside-'));
  folders.push(outside);
  await writeFile(join(outside, 'AGENTS.md'), 'outside secret');
  await symlink(outside, join(folder, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  expect((await readProjectInstructions(project, new AbortController().signal)).text).not.toContain(
    'outside secret',
  );
  const controller = new AbortController();
  controller.abort();
  await expect(readProjectInstructions(project, controller.signal)).rejects.toThrow();
});
