import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { Store } from '@lodex/storage';
import {
  defaultModelConfig,
  makeCommand,
  type InferenceEvent,
  type PermissionMode,
  type Session,
} from '@lodex/contracts';
import { inspectProject } from '@lodex/tools';
import { startServer } from './server';
const exec = promisify(execFile),
  cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
});
function* call(name: string, input: unknown, id: string): Generator<InferenceEvent> {
  yield { type: 'tool_call_delta', index: 0, id, name, arguments: JSON.stringify(input) };
  yield { type: 'finished', reason: 'tool_calls' };
}
async function setup(permission: PermissionMode, mode: 'plan' | 'build' = 'build') {
  const dir = await mkdtemp(join(tmpdir(), 'lodex-build-child-')),
    repo = join(dir, 'repo');
  await mkdir(repo);
  const git = (...args: string[]) =>
    exec(
      'git',
      ['-c', 'core.hooksPath=' + join(dir, 'no-hooks'), '-c', 'core.autocrlf=false', ...args],
      { cwd: repo, windowsHide: true },
    );
  await git('init', '-b', 'main');
  await writeFile(join(repo, 'file.txt'), 'before\n');
  await writeFile(join(repo, 'AGENTS.md'), 'Keep the project-specific test policy.');
  await git('add', '.');
  await git(
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-m',
    'base',
  );
  const store = await Store.open(join(dir, 'state.sqlite'), resolve('apps/daemon/dist/worker.cjs')),
    project = await store.registerProject(await inspectProject(repo));
  let childCalls = 0,
    parentCalls = 0,
    executedCwd = '';
  const app = await startServer({
    store,
    token: 'c'.repeat(64),
    worktreeRoot: join(dir, 'managed'),
    providerFactory: () => ({
      listModels: async () => [],
      capabilities: async () => ({ tools: true, streaming: true }),
      generate: async function* (request) {
        expect(request.messages[0]!.content).toContain('project-specific test policy');
        if (request.config.model === 'child') {
          childCalls++;
          if (childCalls === 1) yield* call('read_file', { path: 'file.txt' }, 'child-read');
          else if (childCalls === 2)
            yield* call(
              'propose_edit',
              {
                path: 'file.txt',
                expectedHash: createHash('sha256').update('before\n').digest('hex'),
                oldText: 'before',
                newText: 'after',
              },
              'child-edit',
            );
          else if (childCalls === 3 && permission === 'full')
            yield* call('run_host_command', { command: 'fixture validation' }, 'child-check');
          else {
            yield { type: 'text_delta', text: 'Child work finished; review the worktree.' };
            yield { type: 'finished', reason: 'stop' };
          }
        } else {
          parentCalls++;
          if (parentCalls === 1)
            yield* call(
              'delegate_tasks',
              { tasks: [{ task: 'Change file and validate', mode: 'build' }] },
              'parent-delegate',
            );
          else if (parentCalls === 2 && permission === 'full' && mode === 'build') {
            const report = JSON.parse(request.messages.at(-1)!.content);
            yield* call(
              'review_worktree',
              { worktreeId: report.subagents[0].worktreeId },
              'parent-review',
            );
          } else if (parentCalls === 3 && permission === 'full' && mode === 'build') {
            const preview = JSON.parse(request.messages.at(-1)!.content);
            yield* call('merge_worktree', { previewId: preview.id }, 'parent-merge');
          } else {
            yield { type: 'text_delta', text: 'Finished or reported the denied operation.' };
            yield { type: 'finished', reason: 'stop' };
          }
        }
      },
    }),
    hostCommandExecutor: async (options) => {
      executedCwd = options.project.path;
      expect(await readFile(join(repo, 'file.txt'), 'utf8')).toBe('before\n');
      expect(await readFile(join(options.project.path, 'file.txt'), 'utf8')).toBe('after\n');
      const execution = {
        id: crypto.randomUUID(),
        projectId: options.project.id,
        containerName: 'fixture',
        environment: 'host' as const,
        command: 'fixture validation',
        cwd: options.project.path,
        status: 'completed' as const,
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        output: 'validated',
        exitCode: 0,
        truncated: false,
        cleanupPending: false,
      };
      await options.record(execution);
      return execution;
    },
  });
  cleanup.push(async () => {
    await app.close();
    if (dirname(resolve(dir)) !== resolve(tmpdir())) throw Error('unsafe');
    await rm(dir, { recursive: true, force: true });
  });
  const request = (path: string, body: unknown) =>
    fetch(`http://127.0.0.1:${app.port}${path}`, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + 'c'.repeat(64), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  let session = (
    await store.apply(
      makeCommand({
        type: 'create_session',
        sessionId: crypto.randomUUID(),
        title: 'build child',
        mode,
        projectId: project.id,
        config: {
          ...defaultModelConfig(),
          provider: 'demo',
          model: 'parent',
          contextBudgetTokens: 131072,
        },
        routing: {
          subagentsEnabled: true,
          subagent: {
            ...defaultModelConfig(),
            provider: 'demo',
            model: 'child',
            contextBudgetTokens: 131072,
          },
        },
      }),
    )
  ).session;
  session = (
    await store.apply(
      makeCommand({
        type: 'set_permission_mode',
        sessionId: session.id,
        expectedVersion: session.version,
        mode: permission,
      }),
    )
  ).session;
  const send = () =>
    request(
      '/v1/commands',
      makeCommand({
        type: 'send_message',
        sessionId: session.id,
        expectedVersion: session.version,
        content: 'Implement in an isolated worktree',
      }),
    );
  return {
    app,
    store,
    repo,
    session,
    project,
    request,
    send,
    childCalls: () => childCalls,
    executedCwd: () => executedCwd,
  };
}
it('builds and verifies in a worktree, audits child commands, then reviews and merges into the source', async () => {
  const app = await setup('full');
  expect((await app.send()).status).toBe(200);
  await expect
    .poll(async () => (await app.store.session(app.session.id)).run?.status, { timeout: 15000 })
    .toBe('completed');
  const final = await app.store.session(app.session.id),
    activities = final.messages.at(-1)!.activities!;
  expect(await readFile(join(app.repo, 'file.txt'), 'utf8')).toBe('after\n');
  expect(app.executedCwd()).not.toBe(app.repo);
  expect(final.run?.context?.projectInstructions?.map((source) => source.path)).toContain(
    'AGENTS.md',
  );
  const child = activities.find((activity) => activity.subagents)?.subagents![0]!;
  expect(child).toMatchObject({
    mode: 'build',
    status: 'completed',
    worktreeId: expect.any(String),
    projectId: expect.any(String),
  });
  expect(activities.find((activity) => activity.execution)?.execution).toMatchObject({
    projectId: child.projectId,
    status: 'completed',
  });
  const editResult = activities.find((activity) => activity.label.endsWith('propose_edit'));
  expect(editResult).toBeDefined();
  expect(JSON.parse(editResult!.text)).toMatchObject({
    status: 'applied',
    files: [{ path: 'file.txt', sha256: createHash('sha256').update('after\n').digest('hex') }],
  });
  expect(
    activities.find((activity) => activity.label === 'merge_worktree')?.approval,
  ).toMatchObject({ kind: 'file', status: 'approved', decidedBy: 'full_access' });
  expect((await app.store.integration('worktrees'))?.document).toMatchObject([
    { merge: { status: 'applied' } },
  ]);
});
it('shows child approvals in the parent while it runs, and passes rejection back without applying files', async () => {
  const app = await setup('ask');
  expect((await app.send()).status).toBe(200);
  let pending: Session = app.session;
  await expect
    .poll(
      async () => {
        pending = await app.store.session(app.session.id);
        return pending.messages
          .at(-1)
          ?.activities?.some((activity) => activity.approval?.status === 'pending');
      },
      { timeout: 15000 },
    )
    .toBe(true);
  const activity = pending.messages
    .at(-1)!
    .activities!.find((activity) => activity.approval?.status === 'pending')!;
  expect(activity.approval?.target).not.toBe('file.txt');
  expect(pending.run?.status).toBe('running');
  const response = await app.request('/v1/approvals', {
    sessionId: pending.id,
    expectedVersion: pending.version,
    activityId: activity.id,
    action: 'reject',
  });
  expect(response.status).toBe(200);
  await expect
    .poll(async () => (await app.store.session(app.session.id)).run?.status, { timeout: 15000 })
    .toBe('completed');
  expect(await readFile(join(app.repo, 'file.txt'), 'utf8')).toBe('before\n');
  expect(app.childCalls()).toBe(3);
  const record = (await app.store.integration('worktrees'))!
    .document as import('@lodex/contracts').WorktreeRecord[];
  expect(await readFile(join(record[0]!.path, 'file.txt'), 'utf8')).toBe('before\n');
});
it('does not expose writable children in Plan mode', async () => {
  const app = await setup('full', 'plan');
  expect((await app.send()).status).toBe(200);
  await expect
    .poll(async () => (await app.store.session(app.session.id)).run?.status, { timeout: 15000 })
    .toBe('completed');
  expect(app.childCalls()).toBe(0);
  expect(await app.store.integration('worktrees')).toBeNull();
  expect(await readFile(join(app.repo, 'file.txt'), 'utf8')).toBe('before\n');
});
it('requires the source Build session for a manual reviewed merge, rejects stale files and records user approval', async () => {
  const app = await setup('ask', 'plan');
  const created = await app.request('/v1/worktrees', { projectId: app.project.id });
  expect(created.status).toBe(200);
  const { record } = (await created.json()) as {
    record: import('@lodex/contracts').WorktreeRecord;
  };
  await writeFile(join(record.path, 'file.txt'), 'manual change\n');
  const reviewed = await app.request('/v1/worktrees/review', { worktreeId: record.id });
  expect(reviewed.status).toBe(200);
  const { preview } = (await reviewed.json()) as {
    preview: import('@lodex/contracts').WorktreePreview;
  };
  const merge = () =>
    app.request('/v1/worktrees/merge', { sessionId: app.session.id, previewId: preview.id });
  expect((await merge()).status).toBe(403);
  expect(await readFile(join(app.repo, 'file.txt'), 'utf8')).toBe('before\n');
  let current = await app.store.session(app.session.id);
  await app.store.apply(
    makeCommand({
      type: 'set_mode',
      sessionId: current.id,
      expectedVersion: current.version,
      mode: 'build',
    }),
  );
  await writeFile(join(record.path, 'file.txt'), 'changed after review\n');
  expect((await merge()).status).toBe(409);
  expect(await readFile(join(app.repo, 'file.txt'), 'utf8')).toBe('before\n');
  const fresh = await app.request('/v1/worktrees/review', { worktreeId: record.id });
  const body = (await fresh.json()) as { preview: import('@lodex/contracts').WorktreePreview };
  const applied = await app.request('/v1/worktrees/merge', {
    sessionId: app.session.id,
    previewId: body.preview.id,
  });
  expect(applied.status).toBe(200);
  expect(await readFile(join(app.repo, 'file.txt'), 'utf8')).toBe('changed after review\n');
  current = await app.store.session(app.session.id);
  expect(current.messages.at(-1)?.activities?.[0]?.approval).toMatchObject({
    mode: 'ask',
    decidedBy: 'user',
    actor: 'desktop',
    status: 'approved',
  });
  await app.store.apply(
    makeCommand({
      type: 'set_mode',
      sessionId: current.id,
      expectedVersion: current.version,
      mode: 'plan',
    }),
  );
  expect(
    (await app.request('/v1/worktrees/undo', { sessionId: current.id, worktreeId: record.id }))
      .status,
  ).toBe(403);
  expect(
    (await app.request('/v1/worktrees/archive', { sessionId: current.id, worktreeId: record.id }))
      .status,
  ).toBe(403);
  current = await app.store.session(current.id);
  await app.store.apply(
    makeCommand({
      type: 'set_mode',
      sessionId: current.id,
      expectedVersion: current.version,
      mode: 'build',
    }),
  );
  expect(
    (await app.request('/v1/worktrees/undo', { sessionId: current.id, worktreeId: record.id }))
      .status,
  ).toBe(200);
  expect(await readFile(join(app.repo, 'file.txt'), 'utf8')).toBe('before\n');
  expect(
    (await app.request('/v1/worktrees/archive', { sessionId: current.id, worktreeId: record.id }))
      .status,
  ).toBe(409);
  const again = await app.request('/v1/worktrees/review', { worktreeId: record.id });
  const againPreview = (await again.json()) as {
    preview: import('@lodex/contracts').WorktreePreview;
  };
  expect(
    (
      await app.request('/v1/worktrees/merge', {
        sessionId: current.id,
        previewId: againPreview.preview.id,
      })
    ).status,
  ).toBe(200);
  current = await app.store.session(current.id);
  const running = (
    await app.store.apply(
      makeCommand({
        type: 'send_message',
        sessionId: current.id,
        expectedVersion: current.version,
        content: 'pending fixture',
      }),
    )
  ).session;
  expect(
    (await app.request('/v1/worktrees/archive', { sessionId: current.id, worktreeId: record.id }))
      .status,
  ).toBe(409);
  await app.store.apply(
    makeCommand({ type: 'cancel_run', sessionId: current.id, runId: running.run!.id }),
  );
  const archived = await app.request('/v1/worktrees/archive', {
    sessionId: current.id,
    worktreeId: record.id,
  });
  expect(archived.status).toBe(200);
  expect((await archived.json()).record).toMatchObject({
    status: 'archived',
    archive: { ref: 'refs/lodex/archive/' + record.id },
  });
});
