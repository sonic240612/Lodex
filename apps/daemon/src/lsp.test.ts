import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm, copyFile, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Store } from '@lodex/storage';
import { inspectProject } from '@lodex/tools';
import { defaultModelConfig, makeCommand, type InferenceEvent } from '@lodex/contracts';
import { LanguageServers } from './lsp';
import { startServer } from './server';
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});
async function fixture(args: string[] = []) {
  const dir = await mkdtemp(join(tmpdir(), 'lodex-lsp-')),
    repo = join(dir, 'project');
  await mkdir(repo);
  await writeFile(join(repo, 'file.ts'), 'const answer = 42;\n');
  await writeFile(join(repo, '.env'), 'TEST_ONLY=example');
  await writeFile(join(dir, 'outside.txt'), 'outside fixture');
  const store = await Store.open(join(dir, 'state.sqlite'), resolve('apps/daemon/dist/worker.cjs')),
    project = await store.registerProject(await inspectProject(repo)),
    manager = await LanguageServers.open(store);
  let ownsStore = true;
  cleanup.push(async () => {
    await manager.close();
    if (ownsStore) await store.close();
    if (dirname(dir) !== tmpdir()) throw new Error('Unsafe fixture');
    await rm(dir, { force: true, recursive: true });
  });
  const config = {
    projectId: project.id,
    name: 'Fixture LSP',
    executable: process.execPath,
    args: [resolve('scripts/fixtures/lsp-server.cjs'), ...args],
    languageId: 'typescript',
    extensions: ['.ts'],
    hostExecutionConsent: true as const,
  };
  const registration = await manager.register(config);
  const query = (
    operation: Parameters<LanguageServers['query']>[1],
    signal: AbortSignal = AbortSignal.timeout(15000),
  ) =>
    manager.query(
      project,
      operation,
      { serverId: registration.id, path: 'file.ts', line: 1, column: 7 },
      signal,
    );
  return {
    dir,
    repo,
    store,
    project,
    manager,
    config,
    registration,
    query,
    handOffStore: () => {
      ownsStore = false;
    },
  };
}
it('initializes real stdio, provides five read-only features, updates changed files and rejects server effects', async () => {
  const app = await fixture();
  expect((await app.query('hover')).result).toMatchObject({
    contents: { value: 'fixture hover: const answer = 42;\n' },
  });
  expect((await app.query('definitions')).result).toHaveLength(1);
  expect((await app.query('references')).result).toHaveLength(1);
  expect((await app.query('document_symbols')).result).toMatchObject([{ name: 'fixtureSymbol' }]);
  expect((await app.query('diagnostics')).result).toMatchObject({
    versionConfirmed: true,
    items: [{ message: expect.stringContaining('fixture diagnostic') }],
  });
  await writeFile(join(app.repo, 'file.ts'), 'const changed = 100;\n');
  const updated = await app.query('hover');
  expect(updated.documentVersion).toBe(2);
  expect(JSON.stringify(updated.result)).toContain('changed = 100');
  await app.manager.stop(app.registration.id);
  const events = (await readFile(join(app.repo, 'lsp-events.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  expect(events.find((entry) => entry.id === 'edit-request').result).toMatchObject({
    applied: false,
  });
  expect(events.find((entry) => entry.id === 'exec-request').error.code).toBe(-32601);
  expect(
    events.some(
      (entry) => entry.method === 'textDocument/didChange' && entry.params.contentChanges[0].range,
    ),
  ).toBe(true);
  expect(events.some((entry) => entry.method === 'shutdown')).toBe(true);
  expect(app.manager.list()[0]!.running).toBe(false);
});
it('supports pull diagnostics and refuses to report missing push diagnostics as a clean result', async () => {
  const pull = await fixture(['--pull']);
  expect((await pull.query('diagnostics')).result).toMatchObject({
    items: [{ message: 'pull fixture' }],
  });
  const pending = await fixture(['--no-diagnostics']);
  expect((await pending.query('diagnostics')).result).toMatchObject({ pending: true, items: [] });
});
it('cancels pending requests and cleans up the language server child process tree', async () => {
  const app = await fixture(['--hang', '--child']),
    abort = new AbortController();
  const query = app.query('hover', abort.signal);
  void query.catch(() => {});
  await expect
    .poll(async () => readFile(join(app.repo, 'lsp-child.pid'), 'utf8').catch(() => ''), {
      timeout: 10000,
    })
    .not.toBe('');
  const childPid = Number(await readFile(join(app.repo, 'lsp-child.pid'), 'utf8'));
  await expect
    .poll(
      async () =>
        (await readFile(join(app.repo, 'lsp-events.jsonl'), 'utf8')).includes(
          '"method":"textDocument/hover"',
        ),
      { timeout: 10000 },
    )
    .toBe(true);
  abort.abort(new Error('fixture cancelled'));
  await expect(query).rejects.toThrow('fixture cancelled');
  await expect
    .poll(
      () => {
        try {
          process.kill(childPid, 0);
          return true;
        } catch {
          return false;
        }
      },
      { timeout: 5000 },
    )
    .toBe(false);
  const events = await readFile(join(app.repo, 'lsp-events.jsonl'), 'utf8');
  expect(events).toContain('$/cancelRequest');
});
it('rejects unapproved registrations, invalid framing, secrets, escaped paths and restored configurations', async () => {
  const app = await fixture(['--bad-frame']);
  await expect(
    app.manager.register({ ...app.config, hostExecutionConsent: false }),
  ).rejects.toThrow();
  await expect(app.query('hover')).rejects.toMatchObject({ code: 'LSP_PROTOCOL' });
  for (const path of ['../outside.txt', '.env'])
    await expect(
      app.manager.query(
        app.project,
        'hover',
        { path, line: 1, column: 1 },
        AbortSignal.timeout(5000),
      ),
    ).rejects.toThrow();
  const saved = await app.store.integration('language_servers');
  await app.store.saveIntegration('language_servers', saved!.version, [
    { ...app.registration, requiresReview: true },
  ]);
  await app.manager.reload();
  expect(app.manager.available(app.project.id)).toBe(false);
  expect(app.manager.list()[0]!.error).toContain('복원한 설정');
  await expect(app.query('hover')).rejects.toMatchObject({ code: 'LSP_SERVER' });
  await app.manager.register(app.config, app.registration.id, app.registration.revision);
  expect(app.manager.available(app.project.id)).toBe(true);
});
it('pins exact executable identity even when replacement bytes are identical', async () => {
  const app = await fixture(),
    executable = join(app.dir, process.platform === 'win32' ? 'node.exe' : 'node');
  await copyFile(process.execPath, executable);
  const registration = await app.manager.register({ ...app.config, executable });
  await copyFile(executable, executable + '.replacement');
  await rename(executable + '.replacement', executable);
  await expect(
    app.manager.query(
      app.project,
      'hover',
      { serverId: registration.id, path: 'file.ts', line: 1, column: 1 },
      AbortSignal.timeout(10000),
    ),
  ).rejects.toMatchObject({ code: 'LSP_CHANGED' });
});
it('exposes registered LSP read tools end to end in a Plan request with normal project consent gating', async () => {
  const app = await fixture();
  let calls = 0;
  const server = await startServer({
    store: app.store,
    token: 'l'.repeat(64),
    providerFactory: () => ({
      listModels: async () => [],
      capabilities: async () => ({ streaming: true, tools: true }),
      generate: async function* (request): AsyncGenerator<InferenceEvent> {
        expect(request.tools?.some((tool) => tool.function.name === 'lsp_hover')).toBe(true);
        if (++calls === 1) {
          yield {
            type: 'tool_call_delta',
            index: 0,
            id: 'lsp-call',
            name: 'lsp_hover',
            arguments: JSON.stringify({ path: 'file.ts', line: 1, column: 7 }),
          };
          yield { type: 'finished', reason: 'tool_calls' };
        } else {
          expect(JSON.stringify(request.messages)).toContain('fixture hover');
          yield { type: 'text_delta', text: 'LSP investigation complete.' };
          yield { type: 'finished', reason: 'stop' };
        }
      },
    }),
  });
  cleanup.unshift(async () => {
    await server.close();
  });
  app.handOffStore();
  const request = (path: string, body: unknown) =>
    fetch(`http://127.0.0.1:${server.port}${path}`, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + 'l'.repeat(64), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  const session = (
    await app.store.apply(
      makeCommand({
        type: 'create_session',
        sessionId: crypto.randomUUID(),
        title: 'LSP Plan',
        mode: 'plan',
        projectId: app.project.id,
        config: { ...defaultModelConfig(), provider: 'demo', model: 'fixture' },
      }),
    )
  ).session;
  expect(
    (
      await request(
        '/v1/commands',
        makeCommand({
          type: 'send_message',
          sessionId: session.id,
          expectedVersion: session.version,
          content: 'Inspect this file.',
        }),
      )
    ).status,
  ).toBe(200);
  await expect
    .poll(async () => (await app.store.session(session.id)).run?.status, { timeout: 15000 })
    .toBe('completed');
  expect(calls).toBe(2);
  expect(
    (
      await request('/v1/lsp/query', {
        projectId: app.project.id,
        operation: 'document_symbols',
        query: { path: 'file.ts' },
      })
    ).status,
  ).toBe(200);
});
