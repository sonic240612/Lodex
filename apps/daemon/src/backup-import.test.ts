import { afterEach, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '@lodex/storage';
import {
  defaultModelConfig,
  defaultPlan,
  engineSettingsSchema,
  makeCommand,
  deleteSessionsSchema,
  type Session,
} from '@lodex/contracts';
import { inspectProject } from '@lodex/tools';
import { inspectSkillDirectory } from '@lodex/skills';
import { BackupImporter } from './backup-import';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});
const now = () => new Date().toISOString();
function session(): Session {
  return {
    id: randomUUID(),
    title: 'Restored conversation',
    version: 10,
    createdAt: now(),
    updatedAt: now(),
    config: {
      ...defaultModelConfig(),
      provider: 'openrouter',
      model: 'fixture',
      cloudConsent: true,
      projectCloudConsent: true,
    },
    routing: { subagentsEnabled: true, plan: { ...defaultModelConfig(), cloudConsent: true } },
    plan: { ...defaultPlan(), goal: 'Saved goal' },
    permissionMode: 'full',
    run: null,
    messages: [
      {
        id: randomUUID(),
        role: 'assistant',
        content: 'Existing answer',
        status: 'complete',
        createdAt: now(),
        usage: null,
        error: null,
      },
    ],
  };
}
function envelope(sessions: Session[] = [session()]) {
  return {
    format: 'lodex-backup-v1',
    backupId: randomUUID(),
    exportedAt: now(),
    secretsIncluded: false,
    data: {
      state: { protocolVersion: 1, sessions, projects: [] as unknown[] },
      profiles: [] as unknown[],
      skills: [] as unknown[],
      mcp: [] as unknown[],
      integrations: {
        telegram: { config: { enabled: true } },
        worktrees: { active: true },
      } as Record<string, unknown>,
    },
  };
}
async function fixture(document = envelope()) {
  const root = await mkdtemp(join(tmpdir(), 'lodex-restore-'));
  const store = await Store.open(
    join(root, 'state.sqlite'),
    resolve('apps/daemon/dist/worker.cjs'),
  );
  const path = join(root, 'backup.json');
  await writeFile(path, JSON.stringify(document));
  cleanup.push(async () => {
    await store.close();
    if (dirname(resolve(root)) !== resolve(tmpdir())) throw new Error('Unsafe fixture');
    await rm(root, { recursive: true, force: true });
  });
  return { root, store, path, document, importer: new BackupImporter(store) };
}
async function create(store: Store, id: string = randomUUID()) {
  return (
    await store.apply(
      makeCommand({
        type: 'create_session',
        sessionId: id,
        title: 'Existing local conversation',
        config: defaultModelConfig(),
      }),
    )
  ).session;
}

describe('non-destructive backup import', () => {
  it('restores conversations and plans without replaying tools, cloud consent or remote connections', async () => {
    const document = envelope();
    const saved = document.data.state.sessions[0]!;
    saved.messages[0]!.status = 'streaming';
    saved.messages[0]!.activities = [
      {
        id: randomUUID(),
        kind: 'tool',
        label: 'run_command',
        status: 'running',
        text: 'Historical command output',
        approval: {
          kind: 'command',
          target: 'rm example',
          actor: 'telegram',
          mode: 'full',
          risk: 'high',
          reason: 'old approval',
          status: 'approved',
          requestedAt: now(),
        },
        observation: { id: randomUUID(), bytes: 40 },
      },
    ];
    saved.taskList = {
      active: true,
      tasks: [
        { id: randomUUID(), title: 'Saved task', details: '', summary: '', status: 'in_progress' },
      ],
    };
    const app = await fixture(document);
    const existing = await create(app.store);
    const existingBefore = await app.store.session(existing.id);
    const preview = await app.importer.preview(app.path);
    expect(preview.items.find((item) => item.kind === 'sessions')).toMatchObject({
      importable: 1,
      conflicts: 0,
    });
    expect(preview.warnings.join(' ')).toContain('ObservationPack');
    expect(await app.importer.restore(preview.token)).toMatchObject({ imported: { sessions: 1 } });
    const restored = await app.store.session(saved.id);
    expect(restored).toMatchObject({
      permissionMode: 'ask',
      run: null,
      skills: [],
      mcp: [],
      config: { cloudConsent: false, projectCloudConsent: false },
      routing: { plan: { cloudConsent: false } },
    });
    expect(restored.plan.goal).toBe('Saved goal');
    expect(restored.taskList).toMatchObject({ active: false, tasks: [{ status: 'pending' }] });
    expect(restored.messages[0]).toMatchObject({
      status: 'interrupted',
      content: 'Existing answer',
      activities: [{ status: 'interrupted', text: 'Historical command output' }],
    });
    expect(restored.messages[0]!.activities![0]!.approval).toBeUndefined();
    expect(restored.messages[0]!.activities![0]!.observation).toBeUndefined();
    expect(await app.store.session(existing.id)).toEqual(existingBefore);
    expect(await app.store.integration('telegram')).toBeNull();
    expect(await app.store.integration('worktrees')).toBeNull();
    expect(
      (await app.store.events(0)).some(
        (event) => event.type === 'session_changed' && event.sessionId === saved.id,
      ),
    ).toBe(true);
    const repeated = await app.importer.preview(app.path);
    expect(repeated.items.find((item) => item.kind === 'sessions')).toMatchObject({
      importable: 0,
      conflicts: 1,
    });
    await expect(app.importer.restore(preview.token)).rejects.toMatchObject({
      code: 'BACKUP_PREVIEW',
    });
  });

  it('revalidates projects and local files, imports inactive MCP/Skills, and never probes an executable', async () => {
    const app = await fixture();
    const project = await inspectProject(app.root);
    app.document.data.state.projects = [project];
    app.document.data.state.sessions[0]!.projectId = project.id;
    const skillRoot = join(app.root, 'skill');
    await mkdir(skillRoot);
    await writeFile(
      join(skillRoot, 'SKILL.md'),
      '---\nname: restore-fixture\ndescription: Safe fixture\n---\nInstructions',
    );
    app.document.data.skills = [await inspectSkillDirectory(skillRoot)];
    const enginePath = join(app.root, 'engine-not-executed.exe'),
      modelPath = join(app.root, 'model.gguf');
    await writeFile(enginePath, 'This is not an executable; restore must never spawn it.');
    const header = Buffer.alloc(24);
    header.write('GGUF');
    header.writeUInt32LE(3, 4);
    header.writeBigUInt64LE(1n, 8);
    await writeFile(modelPath, header);
    const identity = async (path: string) => {
      const stat = await lstat(path);
      return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
    };
    const profile = {
      id: randomUUID(),
      version: 1,
      name: 'Saved model',
      enginePath,
      modelPath,
      settings: engineSettingsSchema.parse({}),
      vramReservationMb: 2048,
      engineIdentity: await identity(enginePath),
      modelIdentity: await identity(modelPath),
      modelBytes: (await lstat(modelPath)).size,
      engineVersion: 'saved version',
      supportedFlags: ['--model'],
      ggufVersion: 3,
    };
    app.document.data.profiles = [profile];
    const mcpId = randomUUID();
    app.document.data.mcp = [
      {
        id: mcpId,
        config: {
          name: 'Saved MCP',
          transport: 'stdio',
          executable: enginePath,
          args: [],
          cwd: app.root,
          env: {},
        },
      },
    ];
    app.document.data.state.sessions[0]!.config = {
      ...defaultModelConfig(),
      managedModelId: profile.id,
      managedModelVersion: 1,
    };
    await writeFile(app.path, JSON.stringify(app.document));
    const preview = await app.importer.preview(app.path);
    expect(
      preview.items
        .filter((item) => item.kind !== 'integrations')
        .every((item) => item.importable === 1),
    ).toBe(true);
    await app.importer.restore(preview.token);
    expect(await app.store.registeredMcp()).toMatchObject([
      { id: mcpId, tools: [], server: null, protocol: null },
    ]);
    expect(await app.store.localProfiles()).toMatchObject([
      { id: profile.id, engineVersion: 'saved version' },
    ]);
    expect(await app.store.registeredSkills()).toHaveLength(1);
    const restored = await app.store.session(app.document.data.state.sessions[0]!.id);
    expect(restored.projectId).toBe(project.id);
    expect(restored.config.managedModelId).toBe(profile.id);
    expect(restored.skills).toEqual([]);
    expect(restored.mcp).toEqual([]);
  });

  it('restores integration settings without activating browsers, schedules or language servers', async () => {
    const app = await fixture();
    const project = await inspectProject(app.root);
    app.document.data.state.projects = [project];
    const saved = app.document.data.state.sessions[0]!;
    saved.projectId = project.id;
    const automationId = randomUUID(),
      languageId = randomUUID();
    app.document.data.integrations = {
      browser: { enabled: true, channel: 'chrome' },
      automations: [
        {
          id: automationId,
          name: 'Saved schedule',
          sessionId: saved.id,
          prompt: 'Review the project',
          enabled: true,
          trigger: { kind: 'interval', minutes: 5 },
          createdAt: now(),
          updatedAt: now(),
          nextAt: now(),
          lastRun: { status: 'running', startedAt: now() },
          fileHashes: { 'file.txt': 'stale' },
        },
      ],
      language_servers: [
        {
          id: languageId,
          revision: randomUUID(),
          config: {
            projectId: project.id,
            name: 'Saved LSP',
            executable: join(app.root, 'not-present-language-server.exe'),
            args: [],
            languageId: 'typescript',
            extensions: ['.ts'],
            hostExecutionConsent: true,
          },
          executableHash: 'a'.repeat(64),
          executableIdentity: 'old-machine-identity',
          createdAt: now(),
        },
      ],
    };
    await writeFile(app.path, JSON.stringify(app.document));
    const preview = await app.importer.preview(app.path);
    expect(preview.items.find((item) => item.kind === 'integrations')).toMatchObject({
      importable: 3,
      conflicts: 0,
      skipped: 0,
    });
    expect((await app.importer.restore(preview.token)).imported.integrations).toBe(3);
    expect((await app.store.integration('browser'))?.document).toEqual({
      enabled: false,
      channel: 'chrome',
    });
    const automation = (
      (await app.store.integration('automations'))?.document as Record<string, unknown>[]
    )[0]!;
    expect(automation).toMatchObject({ id: automationId, sessionId: saved.id, enabled: false });
    for (const key of ['nextAt', 'lastRun', 'fileHashes', 'changedAt'])
      expect(automation).not.toHaveProperty(key);
    expect((await app.store.integration('language_servers'))?.document).toMatchObject([
      { id: languageId, requiresReview: true, config: { projectId: project.id } },
    ]);
    const repeated = await app.importer.preview(app.path);
    expect(repeated.items.find((item) => item.kind === 'integrations')).toMatchObject({
      importable: 0,
      conflicts: 3,
    });
    await app.importer.restore(repeated.token);
    expect((await app.store.integration('automations'))?.version).toBe(1);
  });

  it('restores a previously deleted conversation with a new ID and blocks stale previews atomically', async () => {
    const app = await fixture();
    const saved = app.document.data.state.sessions[0]!;
    const existing = await create(app.store, saved.id);
    await app.store.deleteSessions(
      deleteSessionsSchema.parse({
        protocolVersion: 1,
        commandId: randomUUID(),
        actor: 'desktop',
        policyVersion: 1,
        type: 'delete_sessions',
        targets: [{ sessionId: existing.id, expectedVersion: existing.version }],
      }),
    );
    const preview = await app.importer.preview(app.path);
    await app.importer.restore(preview.token);
    const restored = (await app.store.snapshot()).sessions[0]!;
    expect(restored.id).not.toBe(existing.id);
    expect(restored.messages[0]!.content).toBe('Existing answer');
    const before = await app.importer.preview(app.path);
    expect(before.items.find((item) => item.kind === 'sessions')).toMatchObject({
      importable: 0,
      conflicts: 1,
    });
    await create(app.store);
    await expect(app.importer.restore(before.token)).rejects.toMatchObject({
      code: 'BACKUP_CHANGED',
    });
    expect((await app.store.snapshot()).sessions).toHaveLength(2);
  });

  it('verifies version, checksum and changes between preview and confirmation', async () => {
    const app = await fixture();
    const preview = await app.importer.preview(app.path);
    await writeFile(app.path, JSON.stringify(app.document) + '\n');
    await expect(app.importer.restore(preview.token)).rejects.toMatchObject({
      code: 'BACKUP_CHANGED',
    });
    const bytes = await readFile(app.path);
    const hash = createHash('sha256').update(bytes).digest('hex');
    const hashedPath = join(app.root, `lodex-fixture-${hash}.json`);
    await writeFile(hashedPath, bytes);
    expect((await app.importer.preview(hashedPath)).sha256).toBe(hash);
    await writeFile(hashedPath, Buffer.concat([bytes, Buffer.from(' ')]));
    await expect(app.importer.preview(hashedPath)).rejects.toMatchObject({
      code: 'BACKUP_CHECKSUM',
    });
    await writeFile(app.path, JSON.stringify({ ...app.document, format: 'lodex-backup-v999' }));
    await expect(app.importer.preview(app.path)).rejects.toMatchObject({ code: 'BACKUP_FORMAT' });
    expect((await app.store.snapshot()).sessions).toEqual([]);
  });

  it('reports invalid or missing items and rolls back all DB writes after an insertion failure', async () => {
    const app = await fixture();
    app.document.data.state.projects = [
      { id: randomUUID(), path: join(app.root, 'missing'), identity: 'unknown' },
    ];
    app.document.data.state.sessions[0]!.projectId = (
      app.document.data.state.projects[0] as { id: string }
    ).id;
    app.document.data.profiles = [{ id: randomUUID(), enginePath: 'not-valid' }];
    await writeFile(app.path, JSON.stringify(app.document));
    const preview = await app.importer.preview(app.path);
    expect(preview.items.find((item) => item.kind === 'projects')?.skipped).toBe(1);
    expect(preview.items.find((item) => item.kind === 'profiles')?.skipped).toBe(1);
    const catalog = await app.store.backupImportCatalog();
    const project = await inspectProject(app.root);
    await expect(
      app.store.importBackup(
        { projects: [project, project], sessions: [], profiles: [], skills: [], mcp: [] },
        catalog.fingerprint,
      ),
    ).rejects.toMatchObject({ code: 'STORAGE_ERROR' });
    expect((await app.store.snapshot()).projects).toEqual([]);
    await app.importer.restore(preview.token);
    expect((await app.store.snapshot()).sessions[0]!.projectId).toBeNull();
  });
});
