import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { runHostFileTool } from './host-files';

const paths: string[] = [];
afterEach(async () => {
  await Promise.all(paths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('full-access host file tools', () => {
  it.skipIf(process.platform === 'win32').each([0o600, 0o640, 0o750])(
    'preserves existing POSIX permissions %i',
    async (mode) => {
      const root = await mkdtemp(join(tmpdir(), 'lodex-host-mode-'));
      paths.push(root);
      const path = join(root, '.env');
      await writeFile(path, 'FAKE=before');
      await chmod(path, mode);
      const before = await stat(path);
      const { sha256 } = JSON.parse(
        await runHostFileTool('host_read_file', JSON.stringify({ path }), 'build'),
      );
      await runHostFileTool(
        'host_write_file',
        JSON.stringify({ path, expectedHash: sha256, content: 'FAKE=after' }),
        'build',
      );
      const after = await stat(path);
      expect(after.mode & 0o777).toBe(mode);
      expect([after.uid, after.gid]).toEqual([before.uid, before.gid]);
    },
  );
  it.skipIf(process.platform === 'win32')(
    'creates new host files readable only by their owner',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'lodex-host-mode-'));
      paths.push(root);
      const path = join(root, '.env');
      await runHostFileTool(
        'host_write_file',
        JSON.stringify({ path, expectedHash: null, content: 'FAKE=new' }),
        'build',
      );
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    },
  );
  it('reads and writes an absolute file with optimistic concurrency', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lodex-host-'));
    paths.push(root);
    const path = join(root, '.env');
    await writeFile(path, 'TOKEN=first\n');
    const read = JSON.parse(
      await runHostFileTool('host_read_file', JSON.stringify({ path }), 'plan'),
    ) as { sha256: string; content: string };
    expect(read.content).toBe('TOKEN=first\n');
    await runHostFileTool(
      'host_write_file',
      JSON.stringify({ path, expectedHash: read.sha256, content: 'TOKEN=second\n' }),
      'build',
    );
    expect(await readFile(path, 'utf8')).toBe('TOKEN=second\n');
    await expect(
      runHostFileTool(
        'host_write_file',
        JSON.stringify({ path, expectedHash: read.sha256, content: 'stale' }),
        'build',
      ),
    ).rejects.toMatchObject({ code: 'HOST_FILE_CONFLICT' });
  });

  it('blocks writes in Plan mode', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lodex-host-'));
    paths.push(root);
    const path = join(root, 'new.txt');
    await expect(
      runHostFileTool(
        'host_write_file',
        JSON.stringify({ path, expectedHash: null, content: 'no' }),
        'plan',
      ),
    ).rejects.toMatchObject({ code: 'PLAN_READ_ONLY' });
  });
});
