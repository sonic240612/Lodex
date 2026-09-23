import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { inspectProject, runProjectTool } from './index';

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) {
    if (dirname(resolve(directory)) !== resolve(tmpdir())) throw new Error('Unsafe test directory');
    await rm(directory, { recursive: true, force: true });
  }
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'lodex-path-operations-'));
  directories.push(directory);
  return { directory, project: await inspectProject(directory), signal: AbortSignal.timeout(5000) };
}

async function call(
  project: Awaited<ReturnType<typeof inspectProject>>,
  signal: AbortSignal,
  name: string,
  args: unknown,
  authorize = vi.fn(async () => true),
) {
  return {
    authorize,
    result: JSON.parse(
      await runProjectTool(
        project,
        name,
        JSON.stringify(args),
        signal,
        undefined,
        undefined,
        authorize,
      ),
    ),
  };
}

describe('reviewed project path operations', () => {
  it('creates one directory only after mutation authorization', async () => {
    const { directory, project, signal } = await fixture();
    const denied = await call(
      project,
      signal,
      'make_directory',
      { path: 'denied' },
      vi.fn(async () => false),
    );
    expect(denied.result).toEqual({ status: 'rejected' });
    await expect(readFile(join(directory, 'denied'))).rejects.toMatchObject({ code: 'ENOENT' });
    const allowed = await call(project, signal, 'make_directory', { path: 'src' });
    expect(allowed.authorize).toHaveBeenCalledWith(['src'], false);
    expect(allowed.result).toEqual({ status: 'created', path: 'src' });
  });

  it('moves a fingerprinted directory without overwriting or losing nested bytes', async () => {
    const { directory, project, signal } = await fixture();
    await mkdir(join(directory, 'source'));
    await writeFile(join(directory, 'source', '한글.txt'), 'fixture');
    const inspected = await call(project, signal, 'inspect_path', { path: 'source' });
    const moved = await call(project, signal, 'move_path', {
      source: 'source',
      destination: 'renamed',
      expectedFingerprint: inspected.result.fingerprint,
    });
    expect(moved.authorize).toHaveBeenCalledWith(['source', 'renamed'], false);
    expect(moved.result.status).toBe('moved');
    expect(await readFile(join(directory, 'renamed', '한글.txt'), 'utf8')).toBe('fixture');
    await expect(readFile(join(directory, 'source', '한글.txt'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('refuses stale fingerprints and requires destructive authorization for recursive delete', async () => {
    const { directory, project, signal } = await fixture();
    await mkdir(join(directory, 'remove'));
    await writeFile(join(directory, 'remove', 'a.txt'), 'before');
    const inspected = await call(project, signal, 'inspect_path', { path: 'remove' });
    await writeFile(join(directory, 'remove', 'a.txt'), 'after');
    const stale = await call(project, signal, 'delete_path', {
      path: 'remove',
      expectedFingerprint: inspected.result.fingerprint,
      recursive: true,
    });
    expect(stale.result.error).toBe('PATH_CHANGED');
    expect(await readFile(join(directory, 'remove', 'a.txt'), 'utf8')).toBe('after');
    const current = await call(project, signal, 'inspect_path', { path: 'remove' });
    const removed = await call(project, signal, 'delete_path', {
      path: 'remove',
      expectedFingerprint: current.result.fingerprint,
      recursive: true,
    });
    expect(removed.authorize).toHaveBeenCalledWith(['remove'], true);
    expect(removed.result.status).toBe('deleted');
    await expect(readFile(join(directory, 'remove', 'a.txt'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('does not fingerprint the project root or a directory containing secret files', async () => {
    const { directory, project, signal } = await fixture();
    await mkdir(join(directory, 'mixed'));
    await writeFile(join(directory, 'mixed', '.env'), 'TOKEN=hidden');
    expect((await call(project, signal, 'inspect_path', { path: '.' })).result.error).toBe(
      'PROJECT_ROOT',
    );
    expect((await call(project, signal, 'inspect_path', { path: 'mixed' })).result.error).toBe(
      'PATH_DENIED',
    );
  });
});
