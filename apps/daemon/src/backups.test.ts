import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Backups } from './backups';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

describe('data backups', () => {
  it('creates versioned secret-free envelopes and applies count retention', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lodex-backups-'));
    let sequence = 0;
    const backups = await Backups.open(root, async () => ({ sequence: ++sequence, sessions: [] }));
    cleanups.push(async () => {
      await backups.close();
      if (dirname(resolve(root)) !== resolve(tmpdir())) throw new Error('Unsafe fixture');
      await rm(root, { recursive: true, force: true });
    });
    await expect.poll(() => backups.snapshot().then((value) => value.backups.length)).toBe(1);
    await backups.configure({ automatic: false, retentionCount: 1, retentionDays: 30 });
    const created = await backups.create('manual');
    expect(created.snapshot.backups).toHaveLength(1);
    expect(created.backup.sha256).toMatch(/^[a-f0-9]{64}$/);
    const document = JSON.parse(await readFile(created.path, 'utf8'));
    expect(document).toMatchObject({
      format: 'lodex-backup-v1',
      reason: 'manual',
      secretsIncluded: false,
      data: { sessions: [] },
    });
    expect(JSON.stringify(document)).not.toContain('apiKey');
    await backups.remove(created.backup.name);
    expect((await backups.snapshot()).backups).toEqual([]);
  });
  it('waits for an active automatic backup before closing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lodex-backups-close-'));
    let release!: () => void;
    let markStarted!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const started = new Promise<void>((resolve) => (markStarted = resolve));
    const backups = await Backups.open(root, async () => {
      markStarted();
      await gate;
      return { sessions: [] };
    });
    await started;
    let closed = false;
    const closing = backups.close().then(() => (closed = true));
    await Promise.resolve();
    expect(closed).toBe(false);
    release();
    await closing;
    expect((await backups.snapshot()).backups).toHaveLength(1);
    if (dirname(resolve(root)) !== resolve(tmpdir())) throw new Error('Unsafe fixture');
    await rm(root, { recursive: true, force: true });
  });
});
