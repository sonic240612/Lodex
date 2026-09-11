import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Worker } from 'node:worker_threads';
import {
  defaultModelConfig,
  defaultPlan,
  makeCommand,
  deleteSessionsSchema,
  type Session,
} from '@lodex/contracts';
import { Store } from './index';
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
            db.prepare('UPDATE ' + table + ' SET ' + column + '=? WHERE ' + column + '=?').run(JSON.stringify(value), row.body);
          }
        }
        db.exec('DROP TABLE projects; PRAGMA user_version=1;');
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
