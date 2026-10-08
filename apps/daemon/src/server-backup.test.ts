import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { Store } from '@lodex/storage';
import { inspectProject } from '@lodex/tools';
import { defaultModelConfig, defaultPlan, type BackupImportPreview } from '@lodex/contracts';
import { startServer } from './server';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});
it('requires authentication and a confirmed preview token before restoring through the desktop API', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lodex-restore-api-'));
  const store = await Store.open(
    join(root, 'state.sqlite'),
    resolve('apps/daemon/dist/worker.cjs'),
  );
  const app = await startServer({ store, token: 'f'.repeat(64) });
  cleanup.push(async () => {
    await app.close();
    if (dirname(resolve(root)) !== resolve(tmpdir())) throw new Error('Unsafe fixture');
    await rm(root, { recursive: true, force: true });
  });
  const file = join(root, 'export.json'),
    sessionId = randomUUID(),
    at = new Date().toISOString();
  const project = await inspectProject(root);
  await writeFile(
    file,
    JSON.stringify({
      format: 'lodex-backup-v1',
      backupId: randomUUID(),
      exportedAt: at,
      secretsIncluded: false,
      data: {
        integrations: {
          browser: { enabled: true, channel: 'chrome' },
          automations: [
            {
              id: randomUUID(),
              name: 'Imported schedule',
              sessionId,
              prompt: 'Saved request',
              enabled: true,
              trigger: { kind: 'interval', minutes: 1 },
              createdAt: at,
              updatedAt: at,
              nextAt: at,
            },
          ],
          language_servers: [
            {
              id: randomUUID(),
              revision: randomUUID(),
              config: {
                projectId: project.id,
                name: 'Imported language server',
                executable: join(root, 'missing-lsp.exe'),
                args: [],
                extensions: ['.ts'],
                languageId: 'typescript',
                hostExecutionConsent: true,
              },
              executableHash: 'a'.repeat(64),
              executableIdentity: 'old-device',
              createdAt: at,
            },
          ],
        },
        state: {
          protocolVersion: 1,
          projects: [project],
          sessions: [
            {
              id: sessionId,
              version: 1,
              title: 'Restored via API',
              createdAt: at,
              updatedAt: at,
              config: defaultModelConfig(),
              plan: defaultPlan(),
              messages: [],
              run: null,
            },
          ],
        },
      },
    }),
  );
  const call = (path: string, body: unknown, authorized = true) =>
    fetch(`http://127.0.0.1:${app.port}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(authorized ? { Authorization: 'Bearer ' + 'f'.repeat(64) } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
  expect((await call('/v1/backups/preview', { path: file }, false)).status).toBe(401);
  expect((await call('/v1/backups/restore', { path: file })).status).toBe(400);
  expect((await store.snapshot()).sessions).toHaveLength(0);
  const response = await call('/v1/backups/preview', { path: file });
  expect(response.status).toBe(200);
  const preview = (await response.json()) as BackupImportPreview;
  expect(preview.items.find((item) => item.kind === 'sessions')?.importable).toBe(1);
  expect((await store.snapshot()).sessions).toHaveLength(0);
  const restored = await call('/v1/backups/restore', { token: preview.token });
  expect(restored.status).toBe(200);
  expect(await restored.json()).toMatchObject({ imported: { sessions: 1 } });
  expect((await store.session(sessionId)).permissionMode).toBe('ask');
  const get = async (path: string) =>
    (
      await fetch(`http://127.0.0.1:${app.port}${path}`, {
        headers: { Authorization: 'Bearer ' + 'f'.repeat(64) },
      })
    ).json();
  expect(await get('/v1/browser')).toMatchObject({ config: { enabled: false, channel: 'chrome' } });
  expect(await get('/v1/automations')).toMatchObject({
    records: [{ name: 'Imported schedule', enabled: false, sessionId }],
  });
  expect(await get('/v1/lsp')).toMatchObject({
    servers: [
      {
        registration: { requiresReview: true, config: { name: 'Imported language server' } },
        running: false,
        active: false,
      },
    ],
  });
  expect((await store.session(sessionId)).run).toBeNull();
});
