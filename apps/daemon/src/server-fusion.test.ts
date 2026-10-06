import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  defaultExecutionConfig,
  defaultModelConfig,
  makeCommand,
  type Command,
  type CommandExecution,
  type InferenceProvider,
  type PermissionMode,
  type Session,
} from '@lodex/contracts';
import { type executeCommand, type executeHostCommand, withFusedFileQueue } from '@lodex/tools';
import { Store } from '@lodex/storage';
import { startServer } from './server';
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});
const hash = (text: string) => createHash('sha256').update(text).digest('hex');

async function setup(
  name: string,
  input: (root: string, project: string) => Record<string, unknown>,
  check: (result: Record<string, any>) => void,
  options: {
    mode?: 'plan' | 'build';
    permission?: PermissionMode;
    docker?: boolean;
    network?: 'none' | 'bridge';
    code?: number;
    realHost?: boolean;
    unknownOutcome?: boolean;
    actor?: 'desktop' | 'telegram';
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'lodex-fusion-agent-'));
  const projectPath = join(root, 'project');
  await mkdir(projectPath);
  const file = join(projectPath, 'value.txt');
  await writeFile(file, 'before\r\n');
  const store = await Store.open(
    join(root, 'state.sqlite'),
    resolve('apps/daemon/dist/worker.cjs'),
  );
  let rounds = 0;
  const provider: InferenceProvider = {
    listModels: async () => [],
    capabilities: async () => ({ tools: true, streaming: true }),
    async *generate(request) {
      if (rounds++ === 0) {
        yield {
          type: 'tool_call_delta',
          index: 0,
          id: 'fusion-call',
          name,
          arguments: JSON.stringify(input(root, projectPath)),
        };
        yield { type: 'finished', reason: 'tool_calls' };
      } else {
        check(JSON.parse(request.messages.at(-1)!.content));
        yield { type: 'text_delta', text: 'Checked the actual outcome.' };
        yield { type: 'finished', reason: 'stop' };
      }
    },
  };
  const executions: CommandExecution[] = [];
  const execute = async (
    value: Parameters<typeof executeHostCommand>[0],
    environment: 'host' | 'docker',
  ) => {
    const command = JSON.parse(value.argumentsJson);
    const record: CommandExecution = {
      id: crypto.randomUUID(),
      containerName: 'test',
      command: command.command,
      cwd: command.cwd ?? '.',
      environment,
      status: options.unknownOutcome ? 'running' : options.code ? 'failed' : 'completed',
      exitCode: options.unknownOutcome ? null : (options.code ?? 0),
      output: options.code ? 'validation failed' : 'validation passed',
      truncated: false,
      cleanupPending: false,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
    };
    executions.push(record);
    value.captureOutput?.(record.output);
    await value.record(record);
    if (options.unknownOutcome) throw new Error('Lost command acknowledgement');
    return record;
  };
  const app = await startServer({
    token: 'f'.repeat(64),
    store,
    observationRoot: join(root, 'observations'),
    providerFactory: () => provider,
    commandExecutor: (value: Parameters<typeof executeCommand>[0]) => execute(value, 'docker'),
    ...(!options.realHost
      ? {
          hostCommandExecutor: (value: Parameters<typeof executeHostCommand>[0]) =>
            execute(value, 'host'),
        }
      : {}),
  });
  cleanup.push(async () => {
    await app.close();
    if (dirname(resolve(root)) !== resolve(tmpdir())) throw new Error('Unsafe test root');
    await rm(root, { recursive: true, force: true });
  });
  const request = (path: string, body: unknown) =>
    fetch(`http://127.0.0.1:${app.port}${path}`, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + 'f'.repeat(64), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  const command = async (value: Command): Promise<Session> => {
    const response = await request('/v1/commands', value);
    expect(response.status, await response.clone().text()).toBe(200);
    return (await response.json()).session;
  };
  const registered = await request('/v1/projects', { path: projectPath });
  const { project } = await registered.json();
  let session = await command(
    makeCommand({
      type: 'create_session',
      sessionId: crypto.randomUUID(),
      title: 'Fusion',
      config: {
        ...defaultModelConfig(),
        provider: 'demo',
        model: 'demo',
        contextBudgetTokens: 65536,
        eco: true,
      },
      projectId: project.id,
    }),
  );
  session = await command(
    makeCommand({
      type: 'set_permission_mode',
      sessionId: session.id,
      expectedVersion: session.version,
      mode: options.permission ?? 'full',
    }),
  );
  session = await command(
    makeCommand({
      type: 'set_mode',
      sessionId: session.id,
      expectedVersion: session.version,
      mode: options.mode ?? 'build',
    }),
  );
  if (options.docker)
    session = await command(
      makeCommand({
        type: 'configure_execution',
        sessionId: session.id,
        expectedVersion: session.version,
        execution: {
          ...defaultExecutionConfig(),
          backend: 'docker',
          projectAccess: true,
          network: options.network ?? 'none',
        },
      }),
    );
  const send = async () => {
    const current = await store.session(session.id);
    await command({
      ...makeCommand({
        type: 'send_message',
        sessionId: session.id,
        expectedVersion: current.version,
        content: 'Make the change and run its known check.',
      }),
      actor: options.actor ?? 'desktop',
    });
  };
  const finish = async (status = 'completed') => {
    await vi.waitFor(async () =>
      expect((await store.session(session.id)).run?.status).not.toBe('running'),
    );
    const current = await store.session(session.id);
    expect(current.run?.status, current.messages.at(-1)?.error ?? undefined).toBe(status);
    return current;
  };
  const decide = async (action: 'approve' | 'reject') => {
    let activityId = '';
    await vi.waitFor(async () => {
      activityId =
        (await store.session(session.id)).messages
          .at(-1)
          ?.activities?.find((entry) => entry.approval?.status === 'pending')?.id ?? '';
      expect(activityId).not.toBe('');
    });
    const current = await store.session(session.id);
    const response = await request('/v1/approvals', {
      sessionId: session.id,
      expectedVersion: current.version,
      activityId,
      action,
    });
    expect(response.status, await response.clone().text()).toBe(200);
  };
  const cancel = async () => {
    const current = await store.session(session.id);
    await command(
      makeCommand({ type: 'cancel_run', sessionId: session.id, runId: current.run!.id }),
    );
  };
  return {
    root,
    file,
    store,
    session,
    send,
    finish,
    decide,
    cancel,
    executions,
    rounds: () => rounds,
  };
}
const edit = () => ({
  path: 'value.txt',
  expectedHash: hash('before\r\n'),
  oldText: 'before\n',
  newText: 'after\n',
  thenRun: { command: 'npm test' },
});

describe('SoL-Pi Action Fusion daemon adaptation', () => {
  it('rejects conflicting follow-up argument spellings before a host write and continues the model', async () => {
    const app = await setup(
      'host_write_file',
      (_root, project) => ({
        path: join(project, 'value.txt'),
        expectedHash: hash('before\r\n'),
        content: 'must not write',
        thenRun: { command: 'first' },
        then_run: { command: 'second' },
      }),
      (result) => {
        expect(result.error).toBe('FUSION_ARGUMENTS');
        expect(result.message).toContain('[then_run:skipped]');
      },
    );
    await app.send();
    await app.finish();
    expect(app.executions).toHaveLength(0);
    expect(await readFile(app.file, 'utf8')).toBe('before\r\n');
  });
  it('cancels a queued fusion before mutation or command execution and settles its receipt', async () => {
    const app = await setup('propose_edit', edit, () => {});
    let release!: () => void,
      holding = false;
    const blocker = new Promise<void>((done) => {
      release = done;
    });
    const owner = withFusedFileQueue([app.file], new AbortController().signal, async () => {
      holding = true;
      await blocker;
    });
    try {
      await vi.waitFor(() => expect(holding).toBe(true));
      await app.send();
      await vi.waitFor(async () =>
        expect(
          (await app.store.session(app.session.id)).messages
            .at(-1)
            ?.activities?.some((entry) => entry.fusion?.status === 'pending'),
        ).toBe(true),
      );
      await app.cancel();
      const final = await app.finish('cancelled');
      expect(app.executions).toHaveLength(0);
      expect(await readFile(app.file, 'utf8')).toBe('before\r\n');
      expect(final.messages.at(-1)?.activities?.find((entry) => entry.fusion)?.fusion?.status).toBe(
        'skipped',
      );
    } finally {
      release();
      await owner;
    }
  });
  it('stops on an uncertain command result without retrying or reverting the mutation', async () => {
    const app = await setup('propose_edit', edit, () => {}, { unknownOutcome: true });
    await app.send();
    const final = await app.finish('failed');
    expect(app.executions).toHaveLength(1);
    expect(app.rounds()).toBe(1);
    expect(await readFile(app.file, 'utf8')).toBe('after\r\n');
    expect(final.messages.at(-1)?.error).toContain('자동 재실행하지 않고 중지');
    expect(final.messages.at(-1)?.activities?.find((entry) => entry.fusion)?.fusion?.status).toBe(
      'failed',
    );
  });
  it('uses a host check for a full-access project edit and records Telegram origin', async () => {
    const app = await setup(
      'propose_edit',
      edit,
      (result) => {
        expect(result.validation).toMatchObject({ environment: 'host', exitCode: 0 });
        expect(result.message).toContain('[then_run:succeeded]');
      },
      { actor: 'telegram' },
    );
    await app.send();
    const final = await app.finish();
    expect(await readFile(app.file, 'utf8')).toBe('after\r\n');
    expect(app.rounds()).toBe(2);
    expect(app.executions).toHaveLength(1);
    expect(
      final.messages.at(-1)?.activities?.find((entry) => entry.execution)?.approval,
    ).toMatchObject({ kind: 'fusion', actor: 'telegram', decidedBy: 'full_access' });
  });
  it('accepts original then_run syntax for a multi-file create and edit', async () => {
    const app = await setup(
      'propose_changes',
      () => ({
        files: [
          {
            kind: 'edit',
            path: 'value.txt',
            expectedHash: hash('before\r\n'),
            oldText: 'before\n',
            newText: 'after\n',
          },
          { kind: 'create', path: 'new.txt', content: 'created' },
        ],
        then_run: { command: 'npm test', timeout: 12.5 },
      }),
      (result) => {
        expect(result.editStatus).toBe('applied');
        expect(result.validation.exitCode).toBe(0);
      },
    );
    await app.send();
    await app.finish();
    expect(app.executions).toHaveLength(1);
    expect(await readFile(app.file, 'utf8')).toBe('after\r\n');
    expect(await readFile(join(app.root, 'project', 'new.txt'), 'utf8')).toBe('created');
  });
  it('skips verification when an external writer changes a just-applied project file', async () => {
    const app = await setup('propose_edit', edit, (result) => {
      expect(result.error).toBe('FUSION_CONFLICT');
      expect(result.message).toContain('[then_run:skipped]');
    });
    const finishEdit = app.store.finishEdit.bind(app.store);
    app.store.finishEdit = async (...args) => {
      const updated = await finishEdit(...args);
      if (args[2] === 'applied') await writeFile(app.file, 'external writer');
      return updated;
    };
    await app.send();
    await app.finish();
    expect(app.executions).toHaveLength(0);
    expect(await readFile(app.file, 'utf8')).toBe('external writer');
  });
  it('fuses a host create outside the project with an actual platform shell', async () => {
    const app = await setup(
      'host_write_file',
      (root) => ({
        path: join(root, 'outside.txt'),
        expectedHash: null,
        content: 'fused-host-evidence',
        thenRun: {
          command:
            process.platform === 'win32' ? "Get-Content '../outside.txt'" : "cat '../outside.txt'",
        },
      }),
      (result) => {
        expect(result.editStatus).toBe('written');
        expect(result.validation.exitCode).toBe(0);
        expect(result.validation.output).toContain('fused-host-evidence');
      },
      { realHost: true },
    );
    await app.send();
    await app.finish();
    expect(await readFile(join(app.root, 'outside.txt'), 'utf8')).toBe('fused-host-evidence');
    expect(app.rounds()).toBe(2);
  });
  it('keeps a host replacement after a nonzero check and returns failure to the same model run', async () => {
    const app = await setup(
      'host_write_file',
      (_root, project) => ({
        path: join(project, 'value.txt'),
        expectedHash: hash('before\r\n'),
        content: 'after',
        thenRun: { command: 'failed-check' },
      }),
      (result) => {
        expect(result.validation.exitCode).toBe(7);
        expect(result.message).toContain('[then_run:failed]');
      },
      { code: 7 },
    );
    await app.send();
    await app.finish();
    expect(await readFile(app.file, 'utf8')).toBe('after');
    expect(app.executions).toHaveLength(1);
  });
  it('retains Docker edits after a failed approved check', async () => {
    const app = await setup(
      'propose_edit',
      edit,
      (result) => {
        expect(result.validation.exitCode).toBe(1);
        expect(result.editStatus).toBe('applied');
        expect(result.message).toContain('[then_run:failed]');
      },
      { permission: 'ask', docker: true, code: 1 },
    );
    await app.send();
    expect(app.executions).toHaveLength(0);
    await app.decide('approve');
    await app.finish();
    expect(await readFile(app.file, 'utf8')).toBe('after\r\n');
  });
  it('automatically applies ordinary changes and an offline Docker check in auto mode', async () => {
    const app = await setup(
      'propose_edit',
      edit,
      (result) => expect(result.validation.environment).toBe('docker'),
      { permission: 'auto', docker: true },
    );
    await app.send();
    const final = await app.finish();
    expect(app.executions).toHaveLength(1);
    expect(
      final.messages.at(-1)?.activities?.find((entry) => entry.execution)?.approval?.decidedBy,
    ).toBe('policy');
  });
  it('never mutates or runs a rejected network-capable Docker fusion', async () => {
    const app = await setup(
      'propose_edit',
      edit,
      (result) => {
        expect(result.editStatus).toBe('rejected');
        expect(result.validationStatus).toBe('skipped');
      },
      { permission: 'auto', docker: true, network: 'bridge' },
    );
    await app.send();
    await app.decide('reject');
    await app.finish();
    expect(app.executions).toHaveLength(0);
    expect(await readFile(app.file, 'utf8')).toBe('before\r\n');
  });
  it('skips a command on mutation conflict and lets the model recover', async () => {
    const app = await setup(
      'propose_edit',
      () => ({ ...edit(), expectedHash: hash('stale') }),
      (result) => {
        expect(result.error).toBe('EDIT_CONFLICT');
        expect(result.message).toContain('[then_run:skipped]');
      },
    );
    await app.send();
    await app.finish();
    expect(app.executions).toHaveLength(0);
    expect(await readFile(app.file, 'utf8')).toBe('before\r\n');
  });
  it('blocks a host command in restricted mode before applying the proposed edit', async () => {
    const app = await setup(
      'propose_edit',
      edit,
      (result) => {
        expect(result.error).toBe('EXECUTION_DISABLED');
        expect(result.message).toContain('[then_run:skipped]');
      },
      { permission: 'ask' },
    );
    await app.send();
    await app.finish();
    expect(app.executions).toHaveLength(0);
    expect(await readFile(app.file, 'utf8')).toBe('before\r\n');
  });
  it('keeps Plan read-only even in full access', async () => {
    const app = await setup(
      'host_write_file',
      (_root, project) => ({
        path: join(project, 'value.txt'),
        expectedHash: hash('before\r\n'),
        content: 'no',
        thenRun: { command: 'must not run' },
      }),
      () => {},
      { mode: 'plan' },
    );
    await app.send();
    await app.finish('failed');
    expect(app.executions).toHaveLength(0);
    expect(await readFile(app.file, 'utf8')).toBe('before\r\n');
  });
});
