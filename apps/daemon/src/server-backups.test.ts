import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { defaultModelConfig, makeCommand } from '@lodex/contracts';
import { Store } from '@lodex/storage';
import { startServer } from './server';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

describe('backup API', () => {
  it('exports application state without provider or bot secrets', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lodex-server-backup-'));
    const store = await Store.open(join(dir, 'state.sqlite'), resolve('apps/daemon/dist/worker.cjs'));
    const token = 'a'.repeat(64);
    const app = await startServer({
      token,
      store,
      backupRoot: join(dir, 'backups'),
      openrouterKey: 'openrouter-secret-value',
      telegramToken: '123456789:telegram_secret_value_fixture',
    });
    cleanups.push(async () => {
      await app.close();
      if (dirname(resolve(dir)) !== resolve(tmpdir())) throw new Error('Unsafe fixture');
      await rm(dir, { recursive: true, force: true });
    });
    const request = (path: string, body?: unknown) =>
      fetch(`http://127.0.0.1:${app.port}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    await request(
      '/v1/commands',
      makeCommand({
        type: 'create_session',
        sessionId: crypto.randomUUID(),
        title: 'Backup fixture',
        config: { ...defaultModelConfig(), provider: 'demo', model: 'demo' },
      }),
    );
    const response = await request('/v1/backups/export', {});
    expect(response.status).toBe(201);
    const result = (await response.json()) as { path: string; snapshot: { backups: unknown[] } };
    expect(result.snapshot.backups.length).toBeGreaterThan(0);
    const text = await readFile(result.path, 'utf8');
    expect(text).toContain('Backup fixture');
    expect(text).not.toContain('openrouter-secret-value');
    expect(text).not.toContain('telegram_secret_value_fixture');
    expect(JSON.parse(text)).toMatchObject({
      format: 'lodex-backup-v1',
      secretsIncluded: false,
    });
  });
});
