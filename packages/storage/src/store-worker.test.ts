import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile, readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Worker } from 'node:worker_threads';
import {
  defaultModelConfig,
  defaultPlan,
  makeCommand,
  deleteSessionsSchema,
  type Session,
  type LocalProfile,
  type ContextManifest,
  engineSettingsSchema,
} from '@lodex/contracts';
import { Store } from './index';
import { inspectSkillDirectory, readSkill } from '@lodex/skills';
import {
  inspectProject,
  proposeEdit,
  applyEdit,
  undoEdit,
  checkEdit,
  proposeChanges,
  checkChanges,
  writeChanges,
} from '@lodex/tools';
import { createHash } from 'node:crypto';
const stores = new Set<Store>(),
  directories: string[] = [];
async function open(path: string) {
  const store = await Store.open(path, resolve('apps/daemon/dist/worker.cjs'));
  stores.add(store);
  return store;
}
async function close(store: Store) {
  await store.close();
  stores.delete(store);
}
async function db() {
  const dir = await mkdtemp(join(tmpdir(), 'lodex-저장 테스트-'));
  directories.push(dir);
  const path = join(dir, 'state.sqlite');
  return { store: await open(path), path };
}
async function create(store: Store): Promise<Session> {
  return (
    await store.apply(
      makeCommand({
        type: 'create_session',
        sessionId: crypto.randomUUID(),
        title: '한글 프로젝트',
        config: defaultModelConfig(),
      }),
    )
  ).session;
}
afterEach(async () => {
  for (const store of stores) await store.close();
  stores.clear();
  for (const dir of directories.splice(0)) {
    if (dirname(resolve(dir)) !== resolve(tmpdir())) throw new Error('Unsafe test path');
    await rm(dir, { recursive: true, force: true });
  }
});
describe('durable worker storage', () => {
  it('retains catalog exposure after deselection and later runs with no skill reads', async () => {
    const { store, path } = await db();
    const root = join(dirname(path), 'catalog-skill');
    await mkdir(root);
    await writeFile(
      join(root, 'SKILL.md'),
      '---\nname: catalog\ndescription: Private workflow metadata.\n---\nUnread body.\n',
    );
    const skill = await store.saveRegisteredSkill(await inspectSkillDirectory(root));
    let session = await create(store);
    expect(session.hasSkillHistory).toBe(false);
    session = (
      await store.apply(
        makeCommand({
          type: 'configure_skills',
          sessionId: session.id,
          expectedVersion: session.version,
          skills: [{ id: skill.id, revision: skill.revision }],
          skillCloudConsent: true,
        }),
      )
    ).session;
    const context: ContextManifest = {
      compilerVersion: 'context-v1',
      sourceSessionVersion: session.version,
      requestSha256: 'a'.repeat(64),
      estimateSource: 'utf8_bytes_v1',
      inputEstimateTokens: 1000,
      outputReserveTokens: 2048,
      safetyReserveTokens: 1639,
      contextBudgetTokens: 32768,
      serializedBytes: 950,
      messageCount: 2,
      historyMessageIds: [],
      excludedMessageIds: [],
      planIncluded: false,
      eco: false,
      skillCatalog: { includedIds: [skill.id], omittedIds: [], serializedBytes: 200 },
    };
    session = (
      await store.apply(
        makeCommand({
          type: 'send_message',
          sessionId: session.id,
          expectedVersion: session.version,
          content: 'Describe the catalog.',
        }),
        context,
      )
    ).session;
    expect(session.hasSkillHistory).toBe(true);
    session = await store.updateRun({
      sessionId: session.id,
      runId: session.run!.id,
      status: 'completed',
      text: 'Private workflow metadata.',
    });
    session = (
      await store.apply(
        makeCommand({
          type: 'configure_skills',
          sessionId: session.id,
          expectedVersion: session.version,
          skills: [],
          skillCloudConsent: false,
        }),
      )
    ).session;
    session = (
      await store.apply(
        makeCommand({
          type: 'send_message',
          sessionId: session.id,
          expectedVersion: session.version,
          content: 'Continue locally.',
        }),
      )
    ).session;
    session = await store.updateRun({
      sessionId: session.id,
      runId: session.run!.id,
      status: 'completed',
      text: 'Continued.',
    });
    expect(session.run?.context).toBeUndefined();
    expect(
      session.messages.some((message) =>
        message.activities?.some((activity) => activity.skillRead),
      ),
    ).toBe(false);
    await close(store);
    const reopened = await open(path);
    expect(await reopened.session(session.id)).toMatchObject({
      hasSkillHistory: true,
      skillCloudConsent: false,
      skills: [],
    });
  });
  it('records a completed skill read after cancellation without reviving content or a deleted session', async () => {
    const { store, path } = await db();
    const root = join(dirname(path), 'cancelled-skill');
    await mkdir(root);
    await writeFile(
      join(root, 'SKILL.md'),
      '---\nname: cancelled\ndescription: Cancel audit fixture.\n---\nPrivate skill instructions.\n',
    );
    const skill = await store.saveRegisteredSkill(await inspectSkillDirectory(root));
    let session = await create(store);
    session = (
      await store.apply(
        makeCommand({
          type: 'send_message',
          sessionId: session.id,
          expectedVersion: session.version,
          content: 'Read.',
        }),
      )
    ).session;
    const activityId = crypto.randomUUID();
    session = await store.updateRun({
      sessionId: session.id,
      runId: session.run!.id,
      text: 'Partial response.',
      activities: [
        {
          id: activityId,
          kind: 'tool',
          label: 'read_skill',
          status: 'running',
          text: '',
        },
      ],
    });
    const document = await readSkill(skill, 'model');
    const cancelled = (
      await store.apply(
        makeCommand({ type: 'cancel_run', sessionId: session.id, runId: session.run!.id }),
      )
    ).session;
    const recorded = await store.recordSkillRead(session.id, activityId, document.provenance);
    expect(recorded.hasSkillHistory).toBe(true);
    expect(recorded.run).toEqual(cancelled.run);
    expect(recorded.messages.at(-1)?.content).toBe('Partial response.');
    expect(recorded.messages.at(-1)?.continuation).toEqual(cancelled.messages.at(-1)?.continuation);
    expect(recorded.messages.at(-1)?.activities?.[0]).toMatchObject({
      status: 'cancelled',
      text: '',
      skillRead: document.provenance,
    });
    expect((await store.recordSkillRead(session.id, activityId, document.provenance)).version).toBe(
      recorded.version,
    );
    await expect(
      store.recordSkillRead(session.id, activityId, {
        ...document.provenance,
        sha256: '0'.repeat(64),
      }),
    ).rejects.toMatchObject({ code: 'SKILL_READ_CONFLICT' });
    await close(store);
    const reopened = await open(path);
    expect(
      (await reopened.session(session.id)).messages.at(-1)?.activities?.[0]?.skillRead,
    ).toEqual(document.provenance);
    await reopened.deleteSessions(
      deleteSessionsSchema.parse({
        protocolVersion: 1,
        commandId: crypto.randomUUID(),
        actor: 'desktop',
        policyVersion: 1,
        type: 'delete_sessions',
        targets: [{ sessionId: session.id, expectedVersion: recorded.version }],
      }),
    );
    await expect(
      reopened.recordSkillRead(session.id, activityId, document.provenance),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((await reopened.snapshot()).sessions).toEqual([]);
  });
  it('persists skill registrations with stable IDs, optimistic revisions and metadata-only removal', async () => {
    const { store, path } = await db();
    const root = join(dirname(path), 'registered-skill');
    await mkdir(root);
    const entry = join(root, 'SKILL.md');
    await writeFile(
      entry,
      '---\nname: fixture\ndescription: Test skill.\n---\nFirst instructions.\n',
    );
    const saved = await store.saveRegisteredSkill(await inspectSkillDirectory(root));
    await writeFile(
      entry,
      '---\nname: fixture\ndescription: Updated test skill.\n---\nUpdated instructions.\n',
    );
    const inspected = await inspectSkillDirectory(root);
    const updated = await store.saveRegisteredSkill(inspected, saved.revision);
    expect(updated.id).toBe(saved.id);
    expect(updated.revision).not.toBe(saved.revision);
    await expect(store.saveRegisteredSkill(inspected, saved.revision)).rejects.toMatchObject({
      code: 'VERSION_CONFLICT',
    });
    await expect(store.saveRegisteredSkill(inspected)).rejects.toMatchObject({
      code: 'VERSION_CONFLICT',
    });
    await expect(
      store.saveRegisteredSkill(
        { ...updated, source: { ...updated.source, rootIdentity: 'replacement' } },
        updated.revision,
      ),
    ).rejects.toMatchObject({ code: 'SKILL_SOURCE' });
    await expect(store.removeRegisteredSkill(saved.id, saved.revision)).rejects.toMatchObject({
      code: 'VERSION_CONFLICT',
    });
    await close(store);
    const reopened = await open(path);
    expect(await reopened.registeredSkills()).toEqual([updated]);
    await reopened.removeRegisteredSkill(updated.id, updated.revision);
    expect(await reopened.registeredSkills()).toEqual([]);
    expect(await readFile(entry, 'utf8')).toContain('Updated instructions.');
  });
  it('pins session skills, protects active selections and retains read provenance after consent revocation and removal', async () => {
    const { store, path } = await db();
    const root = join(dirname(path), 'selected-skill');
    await mkdir(root);
    await writeFile(
      join(root, 'SKILL.md'),
      '---\nname: selected\ndescription: Read selected instructions.\n---\nSkill body.\n',
    );
    const skill = await store.saveRegisteredSkill(await inspectSkillDirectory(root));
    const selection = { id: skill.id, revision: skill.revision };
    let session = await create(store);
    expect(session.skills).toEqual([]);
    expect(session.skillCloudConsent).toBe(false);
    const configure = (
      skills = [selection],
      skillCloudConsent = true,
      expectedVersion = session.version,
    ) =>
      makeCommand({
        type: 'configure_skills',
        sessionId: session.id,
        expectedVersion,
        skills,
        skillCloudConsent,
      });
    await expect(
      store.apply(configure([{ ...selection, revision: 'f'.repeat(64) }])),
    ).rejects.toMatchObject({ code: 'SKILL_CHANGED' });
    await expect(
      store.apply(configure([{ ...selection, id: crypto.randomUUID() }])),
    ).rejects.toMatchObject({ code: 'SKILL_NOT_FOUND' });
    const previousVersion = session.version;
    const selectionCommand = configure();
    session = (await store.apply(selectionCommand)).session;
    expect((await store.apply(selectionCommand)).replayed).toBe(true);
    await expect(store.apply(configure([], false, previousVersion))).rejects.toMatchObject({
      code: 'VERSION_CONFLICT',
    });
    session = (
      await store.apply(
        makeCommand({
          type: 'send_message',
          sessionId: session.id,
          expectedVersion: session.version,
          content: 'Read skill.',
        }),
      )
    ).session;
    await expect(store.apply(configure())).rejects.toMatchObject({ code: 'BUSY' });
    await expect(store.removeRegisteredSkill(skill.id, skill.revision)).rejects.toMatchObject({
      code: 'BUSY',
    });
    await expect(store.saveRegisteredSkill(skill, skill.revision)).rejects.toMatchObject({
      code: 'BUSY',
    });
    const document = await readSkill(skill, 'model');
    session = await store.updateRun({
      sessionId: session.id,
      runId: session.run!.id,
      status: 'completed',
      activities: [
        {
          id: crypto.randomUUID(),
          kind: 'tool',
          label: 'read_skill',
          status: 'completed',
          text: document.text,
          skillRead: document.provenance,
        },
      ],
    });
    session = (await store.apply(configure([], false))).session;
    await store.removeRegisteredSkill(skill.id, skill.revision);
    await close(store);
    const reopened = await open(path);
    const restored = await reopened.session(session.id);
    expect(restored.skills).toEqual([]);
    expect(restored.skillCloudConsent).toBe(false);
    expect(restored.messages.at(-1)?.activities?.[0]?.skillRead).toEqual(document.provenance);
    expect(restored.messages.at(-1)?.activities?.[0]?.text).toBe(document.text);
    expect(await reopened.registeredSkills()).toEqual([]);
  });
  it('rejects selecting registrations that prohibit model invocation', async () => {
    const { store, path } = await db();
    const root = join(dirname(path), 'manual-skill');
    await mkdir(root);
    await writeFile(
      join(root, 'SKILL.md'),
      '---\nname: manual\ndescription: Manual only.\ndisable-model-invocation: true\n---\nManual instructions.\n',
    );
    const skill = await store.saveRegisteredSkill(
      await inspectSkillDirectory(root, { dialect: 'claude' }),
    );
    const session = await create(store);
    await expect(
      store.apply(
        makeCommand({
          type: 'configure_skills',
          sessionId: session.id,
          expectedVersion: session.version,
          skills: [{ id: skill.id, revision: skill.revision }],
          skillCloudConsent: false,
        }),
      ),
    ).rejects.toMatchObject({ code: 'SKILL_INVOCATION' });
    expect((await store.session(session.id)).skills).toEqual([]);
  });
  it('persists versioned runtime settings and model metadata without deleting model files', async () => {
    const { store, path } = await db();
    const modelPath = join(dirname(path), 'fixture.gguf');
    await writeFile(modelPath, 'weights fixture');
    const initial = await store.runtimeSettings();
    await store.saveRuntimeSettings({ ...initial, vramBudgetMb: 16384 });
    await expect(
      store.saveRuntimeSettings({ ...initial, vramBudgetMb: 8192 }),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    const profile: LocalProfile = {
      id: crypto.randomUUID(),
      version: 1,
      name: 'fixture',
      modelPath,
      enginePath: process.execPath,
      settings: engineSettingsSchema.parse({}),
      vramReservationMb: 8192,
      modelBytes: 15,
      modelIdentity: 'test-model',
      engineIdentity: 'test-engine',
      engineVersion: 'fixture',
      supportedFlags: [],
      ggufVersion: 3,
    };
    const saved = await store.saveLocalProfile(profile);
    const updated = await store.saveLocalProfile({ ...saved, name: 'renamed' }, saved.version);
    await expect(
      store.saveLocalProfile({ ...saved, name: 'stale' }, saved.version),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    await close(store);
    const reopened = await open(path);
    expect(await reopened.runtimeSettings()).toEqual({
      ...initial,
      version: 1,
      vramBudgetMb: 16384,
    });
    expect(await reopened.localProfiles()).toEqual([updated]);
    await reopened.removeLocalProfile(saved.id);
    expect(await reopened.localProfiles()).toEqual([]);
    expect(await readFile(modelPath, 'utf8')).toBe('weights fixture');
  });
  it('protects plan adoption against concurrent edits and enforces Plan file-write policy in storage', async () => {
    const { store, path } = await db();
    const project = await store.registerProject(await inspectProject(dirname(path)));
    await writeFile(join(project.path, 'a.txt'), 'before');
    let session = (
      await store.apply(
        makeCommand({
          type: 'create_session',
          sessionId: crypto.randomUUID(),
          title: 'policy',
          config: defaultModelConfig(),
          projectId: project.id,
        }),
      )
    ).session;
    session = (
      await store.apply(
        makeCommand({
          type: 'send_message',
          sessionId: session.id,
          expectedVersion: session.version,
          content: 'plan',
        }),
      )
    ).session;
    const planId = crypto.randomUUID(),
      editId = crypto.randomUUID();
    session = await store.updateRun({
      sessionId: session.id,
      runId: session.run!.id,
      status: 'completed',
      activities: [
        {
          id: planId,
          kind: 'tool',
          label: 'propose_plan',
          status: 'completed',
          text: '',
          planProposal: {
            basePlan: session.plan,
            plan: { ...session.plan, goal: 'Proposed goal' },
            status: 'proposed',
          },
        },
        {
          id: editId,
          kind: 'tool',
          label: 'propose_edit',
          status: 'completed',
          text: '',
          edit: await proposeEdit(
            project,
            {
              path: 'a.txt',
              expectedHash: createHash('sha256').update('before').digest('hex'),
              oldText: 'before',
              newText: 'after',
            },
            AbortSignal.timeout(5000),
          ),
        },
      ],
    });
    session = (
      await store.apply(
        makeCommand({
          type: 'save_plan',
          sessionId: session.id,
          expectedVersion: session.version,
          plan: { ...session.plan, goal: 'User edited goal' },
        }),
      )
    ).session;
    await expect(
      store.apply(
        makeCommand({
          type: 'adopt_plan',
          sessionId: session.id,
          expectedVersion: session.version,
          activityId: planId,
        }),
      ),
    ).rejects.toMatchObject({ code: 'PLAN_CONFLICT' });
    session = (
      await store.apply(
        makeCommand({
          type: 'set_mode',
          sessionId: session.id,
          expectedVersion: session.version,
          mode: 'plan',
        }),
      )
    ).session;
    await expect(
      store.beginEdit({
        sessionId: session.id,
        expectedVersion: session.version,
        activityId: editId,
        action: 'apply',
      }),
    ).rejects.toMatchObject({ code: 'PLAN_READ_ONLY' });
    expect(await readFile(join(project.path, 'a.txt'), 'utf8')).toBe('before');
  });
  it('keeps a cancelled command outcome and blocks deletion until owned-container cleanup', async () => {
    const { store, path } = await db();
    let session = await create(store);
    session = (
      await store.apply(
        makeCommand({
          type: 'send_message',
          sessionId: session.id,
          expectedVersion: session.version,
          content: 'run',
        }),
      )
    ).session;
    const activityId = crypto.randomUUID(),
      id = crypto.randomUUID();
    session = await store.updateRun({
      sessionId: session.id,
      runId: session.run!.id,
      activities: [
        { id: activityId, kind: 'tool', label: 'run_command', status: 'running', text: '' },
      ],
    });
    await store.recordExecution(session.id, activityId, {
      id,
      containerName: 'lodex-' + id,
      command: 'test',
      cwd: '.',
      status: 'running',
      startedAt: '',
      exitCode: null,
      output: '',
      truncated: false,
      cleanupPending: true,
    });
    session = (
      await store.apply(
        makeCommand({ type: 'cancel_run', sessionId: session.id, runId: session.run!.id }),
      )
    ).session;
    await close(store);
    const reopened = await open(path);
    session = await reopened.session(session.id);
    expect(session.messages.at(-1)!.activities![0]!.execution?.status).toBe('interrupted');
    await expect(
      reopened.deleteSessions(
        deleteSessionsSchema.parse({
          protocolVersion: 1,
          commandId: crypto.randomUUID(),
          actor: 'desktop',
          policyVersion: 1,
          type: 'delete_sessions',
          targets: [{ sessionId: session.id, expectedVersion: session.version }],
        }),
      ),
    ).rejects.toMatchObject({ code: 'CLEANUP_REQUIRED' });
    const execution = session.messages.at(-1)!.activities![0]!.execution!;
    session = await reopened.recordExecution(session.id, activityId, {
      ...execution,
      cleanupPending: false,
      output: 'late cleanup result',
    });
    expect(session.run?.status).toBe('cancelled');
    expect(session.messages.at(-1)!.activities![0]!.execution?.output).toBe('late cleanup result');
  });
  it.each(['partial', 'published'] as const)(
    'recovers a grouped change after interruption at %s without replaying effects',
    async (point) => {
      const { store, path } = await db();
      const project = await store.registerProject(await inspectProject(dirname(path)));
      await writeFile(join(project.path, 'a.txt'), 'before');
      const signal = new AbortController().signal;
      const changes = await proposeChanges(
        project,
        {
          files: [
            {
              kind: 'edit',
              path: 'a.txt',
              expectedHash: createHash('sha256').update('before').digest('hex'),
              oldText: 'before',
              newText: 'after',
            },
            { kind: 'create', path: 'new.txt', content: 'created' },
          ],
        },
        signal,
      );
      const session = (
        await store.apply(
          makeCommand({
            type: 'create_session',
            sessionId: crypto.randomUUID(),
            title: 'group recovery',
            config: defaultModelConfig(),
            projectId: project.id,
          }),
        )
      ).session;
      const run = (
        await store.apply(
          makeCommand({
            type: 'send_message',
            sessionId: session.id,
            expectedVersion: session.version,
            content: 'proposal',
          }),
        )
      ).session;
      const activityId = crypto.randomUUID();
      const proposed = await store.updateRun({
        sessionId: session.id,
        runId: run.run!.id,
        status: 'completed',
        activities: [
          {
            id: activityId,
            kind: 'tool',
            label: 'propose_changes',
            status: 'completed',
            text: '',
            changes,
          },
        ],
      });
      const pending = await store.beginEdit({
        sessionId: session.id,
        expectedVersion: proposed.version,
        activityId,
        action: 'apply',
      });
      const changeSet = pending.messages.at(-1)!.activities![0]!.changes!;
      if (point === 'partial')
        await applyEdit(
          project,
          changeSet.files[0] as import('@lodex/contracts').EditProposal,
          signal,
        );
      else
        await writeChanges(project, changeSet, 'apply', signal, async (file) => {
          await store.recordCreatedFile(
            session.id,
            activityId,
            file.path,
            file.stagingId,
            file.identity!,
          );
        });
      // Deliberately omit finishEdit, as when the process exits after physical writes.
      await close(store);
      const reopened = await open(path);
      let restored = await reopened.session(session.id);
      const recovered = restored.messages.at(-1)!.activities![0]!.changes!;
      expect(recovered.status).toBe('uncertain');
      expect(await readFile(join(project.path, 'a.txt'), 'utf8')).toBe('after');
      if (point === 'partial')
        await expect(readFile(join(project.path, 'new.txt'))).rejects.toMatchObject({
          code: 'ENOENT',
        });
      else expect(recovered.files[1]).toHaveProperty('identity');
      await expect(
        reopened.beginEdit({
          sessionId: session.id,
          expectedVersion: restored.version,
          activityId,
          action: 'apply',
        }),
      ).rejects.toMatchObject({ code: 'EDIT_STATE' });
      await reopened.beginEdit({
        sessionId: session.id,
        expectedVersion: restored.version,
        activityId,
        action: 'check',
      });
      const checked = await checkChanges(project, recovered, signal);
      expect(checked.status).toBe(point === 'partial' ? 'partial' : 'applied');
      restored = await reopened.finishEdit(
        session.id,
        activityId,
        checked.status,
        undefined,
        checked.observations,
      );
      const undo = await reopened.beginEdit({
        sessionId: session.id,
        expectedVersion: restored.version,
        activityId,
        action: 'undo',
      });
      const undoSet = undo.messages.at(-1)!.activities![0]!.changes!;
      await writeChanges(project, undoSet, 'undo', signal);
      // Crash after undo is also reconciled by bytes and creation identity.
      await close(reopened);
      const again = await open(path);
      const uncertainUndo = (await again.session(session.id)).messages.at(-1)!.activities![0]!
        .changes!;
      expect(uncertainUndo.status).toBe('uncertain');
      expect((await checkChanges(project, uncertainUndo, signal)).status).toBe('reverted');
      expect(await readFile(join(project.path, 'a.txt'), 'utf8')).toBe('before');
      await expect(readFile(join(project.path, 'new.txt'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    },
  );
  it.each([false, true])(
    'recovers interrupted undo without applying or undoing again (committed=%s)',
    async (committed) => {
      const { store, path } = await db();
      const project = await store.registerProject(await inspectProject(dirname(path)));
      const before = 'before\r\n',
        file = join(project.path, 'undo.txt');
      await writeFile(file, before);
      const signal = new AbortController().signal;
      const edit = await proposeEdit(
        project,
        {
          path: 'undo.txt',
          expectedHash: createHash('sha256').update(before).digest('hex'),
          oldText: 'before',
          newText: '',
        },
        signal,
      );
      const created = (
        await store.apply(
          makeCommand({
            type: 'create_session',
            sessionId: crypto.randomUUID(),
            title: 'undo recovery',
            config: defaultModelConfig(),
            projectId: project.id,
          }),
        )
      ).session;
      const run = (
        await store.apply(
          makeCommand({
            type: 'send_message',
            sessionId: created.id,
            expectedVersion: created.version,
            content: 'proposal',
          }),
        )
      ).session;
      const activityId = crypto.randomUUID();
      let current = await store.updateRun({
        sessionId: run.id,
        runId: run.run!.id,
        status: 'completed',
        activities: [
          {
            id: activityId,
            kind: 'tool',
            label: 'propose_edit',
            status: 'completed',
            text: 'proposal',
            edit,
          },
        ],
      });
      await store.beginEdit({
        sessionId: current.id,
        expectedVersion: current.version,
        activityId,
        action: 'apply',
      });
      await applyEdit(project, edit, signal);
      current = await store.finishEdit(current.id, activityId, 'applied');
      const pending = await store.beginEdit({
        sessionId: current.id,
        expectedVersion: current.version,
        activityId,
        action: 'undo',
      });
      const pendingEdit = pending.messages.at(-1)!.activities![0]!.edit!;
      expect(pendingEdit.operation).toBe('undo');
      if (committed) await undoEdit(project, pendingEdit, signal);
      await close(store);
      const reopened = await open(path);
      const restored = await reopened.session(current.id);
      const recovered = restored.messages.at(-1)!.activities![0]!.edit!;
      expect(recovered.status).toBe('uncertain');
      await expect(
        reopened.beginEdit({
          sessionId: restored.id,
          expectedVersion: restored.version,
          activityId,
          action: 'undo',
        }),
      ).rejects.toMatchObject({ code: 'EDIT_STATE' });
      await reopened.beginEdit({
        sessionId: restored.id,
        expectedVersion: restored.version,
        activityId,
        action: 'check',
      });
      const result = await reopened.finishEdit(
        restored.id,
        activityId,
        await checkEdit(project, recovered, signal),
      );
      expect(result.messages.at(-1)!.activities![0]!.edit!.status).toBe(
        committed ? 'reverted' : 'applied',
      );
      expect(await readFile(file, 'utf8')).toBe(committed ? before : '\r\n');
    },
  );
  it.each([false, true])(
    'marks interrupted edit intent uncertain and reconciles bytes after restart (committed=%s)',
    async (committed) => {
      const { store, path } = await db();
      const project = await store.registerProject(await inspectProject(dirname(path)));
      const file = join(project.path, 'recover.txt'),
        before = 'before\r\n';
      await writeFile(file, before);
      const signal = new AbortController().signal;
      const edit = await proposeEdit(
        project,
        {
          path: 'recover.txt',
          expectedHash: createHash('sha256').update(before).digest('hex'),
          oldText: 'before',
          newText: 'after',
        },
        signal,
      );
      const created = (
        await store.apply(
          makeCommand({
            type: 'create_session',
            sessionId: crypto.randomUUID(),
            title: 'edit recovery',
            config: defaultModelConfig(),
            projectId: project.id,
          }),
        )
      ).session;
      const running = (
        await store.apply(
          makeCommand({
            type: 'send_message',
            sessionId: created.id,
            expectedVersion: created.version,
            content: 'propose',
          }),
        )
      ).session;
      const activityId = crypto.randomUUID();
      const finished = await store.updateRun({
        sessionId: created.id,
        runId: running.run!.id,
        status: 'completed',
        activities: [
          {
            id: activityId,
            kind: 'tool',
            label: 'propose_edit',
            status: 'completed',
            text: 'proposal',
            edit,
          },
        ],
      });
      await store.beginEdit({
        sessionId: created.id,
        expectedVersion: finished.version,
        activityId,
        action: 'apply',
      });
      if (committed) await applyEdit(project, edit, signal);
      // Simulate a process ending after durable intent, with no completion receipt.
      await close(store);
      const reopened = await open(path);
      const restored = await reopened.session(created.id);
      expect(restored.messages.at(-1)!.activities![0]!.edit!.status).toBe('uncertain');
      expect(await readFile(file, 'utf8')).toBe(committed ? 'after\r\n' : before);
      await expect(
        reopened.beginEdit({
          sessionId: created.id,
          expectedVersion: restored.version,
          activityId,
          action: 'apply',
        }),
      ).rejects.toMatchObject({ code: 'EDIT_STATE' });
      await reopened.beginEdit({
        sessionId: created.id,
        expectedVersion: restored.version,
        activityId,
        action: 'check',
      });
      const state = await checkEdit(project, edit, signal);
      const reconciled = await reopened.finishEdit(created.id, activityId, state);
      expect(reconciled.messages.at(-1)!.activities![0]!.edit!.status).toBe(
        committed ? 'applied' : 'proposed',
      );
    },
  );
  it('deletes a selection durably, purges event payloads and rejects old commands and IDs', async () => {
    const { store, path } = await db();
    const original = makeCommand({
      type: 'create_session',
      sessionId: crypto.randomUUID(),
      title: 'private title',
      config: defaultModelConfig(),
    });
    const a = (await store.apply(original)).session;
    const b = await create(store);
    const command = deleteSessionsSchema.parse({
      protocolVersion: 1,
      commandId: crypto.randomUUID(),
      actor: 'desktop',
      policyVersion: 1,
      type: 'delete_sessions',
      targets: [
        { sessionId: a.id, expectedVersion: a.version },
        { sessionId: b.id, expectedVersion: b.version },
      ],
    });
    const result = await store.deleteSessions(command);
    expect(result.event.sessionIds).toEqual([a.id, b.id]);
    expect((await store.deleteSessions(command)).replayed).toBe(true);
    expect((await store.snapshot()).sessions).toEqual([]);
    expect(JSON.stringify(await store.events(0))).not.toContain('private title');
    await expect(store.apply(original)).rejects.toMatchObject({ code: 'SESSION_DELETED' });
    await expect(
      store.apply({ ...original, commandId: crypto.randomUUID() }),
    ).rejects.toMatchObject({ code: 'SESSION_DELETED' });
    await close(store);
    const reopened = await open(path);
    expect((await reopened.snapshot()).deletedSessionIds).toEqual(
      expect.arrayContaining([a.id, b.id]),
    );
    expect((await reopened.snapshot()).sessions).toEqual([]);
    expect((await reopened.deleteSessions(command)).replayed).toBe(true);
  });
  it('deletes nothing if any selected conversation changed or is running', async () => {
    const { store } = await db();
    const a = await create(store),
      b = await create(store);
    const base = {
      protocolVersion: 1,
      commandId: crypto.randomUUID(),
      actor: 'desktop',
      policyVersion: 1,
      type: 'delete_sessions',
    };
    await expect(
      store.deleteSessions(
        deleteSessionsSchema.parse({
          ...base,
          targets: [
            { sessionId: a.id, expectedVersion: a.version },
            { sessionId: b.id, expectedVersion: b.version + 1 },
          ],
        }),
      ),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    const running = (
      await store.apply(
        makeCommand({
          type: 'send_message',
          sessionId: b.id,
          expectedVersion: b.version,
          content: 'run',
        }),
      )
    ).session;
    await expect(
      store.deleteSessions(
        deleteSessionsSchema.parse({
          ...base,
          targets: [
            { sessionId: a.id, expectedVersion: a.version },
            { sessionId: b.id, expectedVersion: running.version },
          ],
        }),
      ),
    ).rejects.toMatchObject({ code: 'BUSY' });
    expect((await store.snapshot()).sessions).toHaveLength(2);
  });
  it('retains projects, their events and conversation association across restart', async () => {
    const { store, path } = await db();
    const project = await store.registerProject(await inspectProject(dirname(path)));
    const session = (
      await store.apply(
        makeCommand({
          type: 'create_session',
          sessionId: crypto.randomUUID(),
          title: 'project chat',
          config: defaultModelConfig(),
          projectId: project.id,
        }),
      )
    ).session;
    await expect(
      store.apply(
        makeCommand({
          type: 'create_session',
          sessionId: crypto.randomUUID(),
          title: 'missing',
          config: defaultModelConfig(),
          projectId: crypto.randomUUID(),
        }),
      ),
    ).rejects.toThrow('프로젝트');
    await close(store);
    const reopened = await open(path);
    expect((await reopened.snapshot()).projects).toEqual([project]);
    expect((await reopened.session(session.id)).projectId).toBe(project.id);
    expect((await reopened.events(0))[0]?.type).toBe('projects_changed');
  });
  it('loads old session, event and receipt JSON with opt-in disabled by default', async () => {
    const { store, path } = await db();
    const original = makeCommand({
      type: 'create_session',
      sessionId: crypto.randomUUID(),
      title: 'old fixture',
      config: defaultModelConfig(),
    });
    await store.apply(original);
    await close(store);
    // Construct an old-format fixture outside Vitest's native SQLite VM boundary.
    await new Promise<void>((resolve, reject) => {
      const worker = new Worker(
        `
        const { DatabaseSync } = require('node:sqlite');
        const { workerData } = require('node:worker_threads');
        const db = new DatabaseSync(workerData);
        for (const [table, column] of [['sessions','document'],['events','document'],['commands','result']]) {
          for (const row of db.prepare('SELECT ' + column + ' AS body FROM ' + table).all()) {
            const value = JSON.parse(row.body);
            const session = table === 'sessions' ? value : value.session;
            delete session.config.contextBudgetTokens;
            delete session.plan.instructions;
            delete session.plan.includeInContext;
            delete session.skills;
            delete session.skillCloudConsent;
            delete session.hasSkillHistory;
            db.prepare('UPDATE ' + table + ' SET ' + column + '=? WHERE ' + column + '=?').run(JSON.stringify(value), row.body);
          }
        }
        db.exec('DROP TABLE projects; DROP TABLE runtime_profiles; DROP TABLE runtime_settings; DROP TABLE skill_registrations; PRAGMA user_version=1;');
        db.close();
      `,
        { eval: true, workerData: path },
      );
      worker.once('error', reject);
      worker.once('exit', (code) =>
        code === 0 ? resolve() : reject(new Error('Fixture worker failed')),
      );
    });
    const reopened = await open(path);
    const sources = [
      await reopened.session(original.sessionId),
      (await reopened.snapshot()).sessions[0]!,
      (await reopened.events(0)).filter((e) => e.type === 'session_changed')[0]!.session,
      (await reopened.receipt(original))!.session,
    ];
    for (const session of sources) {
      expect(session.config.contextBudgetTokens).toBe(32768);
      expect(session.plan).toEqual(defaultPlan());
      expect(session.skills).toEqual([]);
      expect(session.skillCloudConsent).toBe(false);
      expect(session.hasSkillHistory).toBe(false);
    }
  });
  it('deduplicates identical commands and rejects altered reuse', async () => {
    const { store } = await db();
    const command = makeCommand({
      type: 'create_session',
      sessionId: crypto.randomUUID(),
      title: '중복 방지',
      config: defaultModelConfig(),
    });
    await store.apply(command);
    expect((await store.apply(command)).replayed).toBe(true);
    expect((await store.snapshot()).sessions).toHaveLength(1);
    expect(await store.events(0)).toHaveLength(1);
    if (command.type !== 'create_session') throw new Error('Unexpected command');
    await expect(store.apply({ ...command, title: '다른 요청' })).rejects.toThrow('다른 내용');
  });
  it('rolls back stale plan edits without adding state or events', async () => {
    const { store } = await db();
    const session = await create(store);
    const command = makeCommand({
      type: 'save_plan',
      sessionId: session.id,
      expectedVersion: 0,
      plan: { ...defaultPlan(), goal: '충돌' },
    });
    await expect(store.apply(command)).rejects.toThrow('최신 상태');
    expect((await store.session(session.id)).plan.goal).toBe('');
    expect(await store.events(0)).toHaveLength(1);
  });
  it('persists editable tasks across database reopen, with replayable events', async () => {
    const { store, path } = await db();
    const session = await create(store);
    await store.apply(
      makeCommand({
        type: 'save_plan',
        sessionId: session.id,
        expectedVersion: session.version,
        plan: {
          ...defaultPlan(),
          goal: '공개 앱 만들기',
          instructions: '기존 API 유지',
          includeInContext: true,
          tasks: [{ id: crypto.randomUUID(), title: '빌드 확인', done: true }],
        },
      }),
    );
    await close(store);
    const reopened = await open(path);
    expect((await reopened.session(session.id)).plan.tasks[0]?.done).toBe(true);
    expect((await reopened.session(session.id)).plan.instructions).toBe('기존 API 유지');
    expect((await reopened.session(session.id)).plan.includeInContext).toBe(true);
    expect(await reopened.events(1)).toHaveLength(1);
    expect((await reopened.snapshot()).lastSeq).toBe(2);
  });
  it('marks crashed runs interrupted, preserves partial text, and never replays work', async () => {
    const { store, path } = await db();
    const session = await create(store);
    const sent = await store.apply(
      makeCommand({
        type: 'send_message',
        sessionId: session.id,
        expectedVersion: session.version,
        content: '실행',
      }),
    );
    const run = sent.session.run!;
    await store.updateRun({ sessionId: session.id, runId: run.id, text: '부분 응답' });
    await close(store);
    const reopened = await open(path);
    expect((await reopened.session(session.id)).run?.status).toBe('interrupted');
    expect((await reopened.session(session.id)).messages.at(-1)?.content).toBe('부분 응답');
    const seq = (await reopened.snapshot()).lastSeq;
    await close(reopened);
    const reopenedAgain = await open(path);
    expect((await reopenedAgain.snapshot()).lastSeq).toBe(seq);
  });
  it('prevents late completion from overwriting cancellation', async () => {
    const { store } = await db();
    const session = await create(store);
    const sent = await store.apply(
      makeCommand({
        type: 'send_message',
        sessionId: session.id,
        expectedVersion: session.version,
        content: '실행',
      }),
    );
    const run = sent.session.run!;
    await store.apply(makeCommand({ type: 'cancel_run', sessionId: session.id, runId: run.id }));
    await store.updateRun({
      sessionId: session.id,
      runId: run.id,
      status: 'completed',
      text: '늦은 응답',
    });
    expect((await store.session(session.id)).run?.status).toBe('cancelled');
    expect((await store.session(session.id)).messages.at(-1)?.content).toBe('');
  });
  it('requires a new conversation to switch an existing local history to cloud', async () => {
    const { store } = await db();
    const session = await create(store);
    const sent = await store.apply(
      makeCommand({
        type: 'send_message',
        sessionId: session.id,
        expectedVersion: session.version,
        content: '개인 데이터',
      }),
    );
    const completed = await store.updateRun({
      sessionId: session.id,
      runId: sent.session.run!.id,
      status: 'completed',
    });
    await expect(
      store.apply(
        makeCommand({
          type: 'configure_session',
          sessionId: session.id,
          expectedVersion: completed.version,
          config: { ...session.config, provider: 'openrouter', cloudConsent: true },
        }),
      ),
    ).rejects.toThrow('새 대화');
  });
});
