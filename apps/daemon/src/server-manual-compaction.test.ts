import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  defaultModelConfig,
  makeCommand,
  type Command,
  type CommandResult,
  type InferenceProvider,
  type ModelConfig,
  type Session,
} from '@lodex/contracts';
import { compileContext } from '@lodex/context';
import { Store } from '@lodex/storage';
import { startServer } from './server';

const summary =
  '## Goal\nImplement the requested fix.\n## Progress\nThe existing code was reviewed; validation remains pending.';
const cleanup: (() => Promise<void>)[] = [];
const listModels = async () =>
  ['fixture', 'summarizer'].map((id) => ({
    id,
    name: id,
    contextLength: 32768,
    maxCompletionTokens: 4096,
    defaultTemperature: null,
    defaultTopP: null,
    tools: true,
    pricing: { prompt: 0.000001, completion: 0.000002, request: 0 },
  }));
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});

async function fixture(
  options: {
    config?: Partial<ModelConfig>;
    consentHistory?: 'project' | 'skill' | 'mcp' | 'lsp';
    provider?: InferenceProvider;
    key?: boolean;
  } = {},
) {
  const dir = await mkdtemp(join(tmpdir(), 'lodex-manual-compaction-'));
  const path = join(dir, 'state.sqlite');
  const generate = vi.fn<InferenceProvider['generate']>(async function* () {
    yield {
      type: 'usage',
      usage: { generationId: 'gen-summary', inputTokens: 125, outputTokens: 30, costUsd: 0.003 },
    };
    yield { type: 'text_delta', text: summary };
    yield { type: 'finished', reason: 'stop' };
  });
  const provider: InferenceProvider = options.provider ?? {
    generate,
    listModels,
    capabilities: async () => ({ streaming: true, tools: true }),
  };
  let store = await Store.open(path, resolve('apps/daemon/dist/worker.cjs'));
  let app = await startServer({
    token: 'x'.repeat(64),
    store,
    ...(options.key === false ? {} : { openrouterKey: 'fixture-only' }),
    providerFactory: () => provider,
  });
  cleanup.push(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });
  const request = (url: string, body: unknown) =>
    fetch(`http://127.0.0.1:${app.port}${url}`, {
      method: 'POST',
      headers: { authorization: 'Bearer ' + 'x'.repeat(64), 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  let projectId: string | null = null;
  if (options.consentHistory === 'project') {
    const response = await request('/v1/projects', { path: dir });
    projectId = (await response.json()).project.id;
  }
  let session = (
    await store.apply(
      makeCommand({
        type: 'create_session',
        sessionId: crypto.randomUUID(),
        title: 'Manual summary',
        projectId,
        config: {
          ...defaultModelConfig(),
          provider: 'openrouter',
          model: 'fixture',
          cloudConsent: true,
          contextBudgetTokens: 32768,
          autoMaxTokens: false,
          maxTokens: 2048,
          ...options.config,
        },
      }),
    )
  ).session;
  for (let i = 0; i < 3; i++) {
    const manifest = compileContext(session, `Source ${i}`).manifest;
    if (options.consentHistory === 'skill')
      manifest.skillCatalog = {
        includedIds: [crypto.randomUUID()],
        omittedIds: [],
        serializedBytes: 25,
      };
    if (options.consentHistory === 'mcp') manifest.mcpTools = ['fixture_tool'];
    session = (
      await store.apply(
        makeCommand({
          type: 'send_message',
          sessionId: session.id,
          expectedVersion: session.version,
          content: `Source ${i}: preserve this user instruction.`,
        }),
        manifest,
      )
    ).session;
    session = await store.updateRun({
      sessionId: session.id,
      runId: session.run!.id,
      text: `Result ${i}: no actions were executed.`,
      status: 'completed',
      ...(options.consentHistory === 'project'
        ? {
            activities: [
              {
                id: crypto.randomUUID(),
                kind: 'tool' as const,
                label: 'read_file',
                status: 'completed' as const,
                text: 'Project source contents.',
              },
            ],
          }
        : {}),
      ...(options.consentHistory === 'lsp'
        ? {
            continuation: [
              {
                role: 'assistant' as const,
                content: '',
                toolCalls: [{ id: `hover-${i}`, name: 'lsp_hover', arguments: '{}' }],
              },
              {
                role: 'tool' as const,
                toolCallId: `hover-${i}`,
                toolName: 'lsp_hover',
                content: 'Fixture private project source.',
              },
            ],
          }
        : {}),
    });
  }
  return {
    get store() {
      return store;
    },
    session,
    generate,
    request,
    command: (value: Command) => request('/v1/commands', value),
    async restart() {
      await app.close();
      store = await Store.open(path, resolve('apps/daemon/dist/worker.cjs'));
      app = await startServer({
        token: 'x'.repeat(64),
        store,
        openrouterKey: 'fixture-only',
        providerFactory: () => provider,
      });
    },
  };
}
const compact = (session: Session) =>
  makeCommand({ type: 'compact_context', sessionId: session.id, expectedVersion: session.version });
const fast = (session: Session) =>
  makeCommand({
    type: 'quick_compact_context',
    sessionId: session.id,
    expectedVersion: session.version,
  });

describe('manual LLM compaction boundaries and billing', () => {
  it('uses the summary role and reserves its price, then preserves the selection after restart', async () => {
    const app = await fixture({ config: { provider: 'llama-server', cloudConsent: false } });
    const configured = await app.store.apply(
      makeCommand({
        type: 'configure_routing',
        sessionId: app.session.id,
        expectedVersion: app.session.version,
        routing: {
          summary: {
            ...defaultModelConfig(),
            provider: 'openrouter',
            model: 'summarizer',
            cloudConsent: true,
            maxTokens: 512,
            autoMaxTokens: false,
          },
        },
      }),
    );
    const response = await app.command(compact(configured.session));
    expect(response.status, await response.clone().text()).toBe(200);
    const result = (await response.json()).session as Session;
    expect(result.contextCompaction?.model).toBe('summarizer');
    expect(app.generate.mock.calls[0]?.[0].config.model).toBe('summarizer');
    const call = result.messages.at(-1)!.costCalls!.at(-1)!;
    expect(call.model).toBe('summarizer');
    expect(call.reservedCostUsd).toBeGreaterThan(0);
    expect(call.actualCostUsd).toBe(0.003);
    await app.restart();
    expect((await app.store.session(app.session.id)).routing?.summary?.model).toBe('summarizer');
  });

  it.each([
    { config: { cloudConsent: false }, code: 'CLOUD_CONSENT' },
    { key: false, code: 'KEY_REQUIRED' },
    { consentHistory: 'project' as const, code: 'PROJECT_CLOUD_CONSENT' },
    { consentHistory: 'lsp' as const, code: 'PROJECT_CLOUD_CONSENT' },
    { consentHistory: 'skill' as const, code: 'SKILL_CLOUD_CONSENT' },
    { consentHistory: 'mcp' as const, code: 'MCP_CLOUD_CONSENT' },
  ])('blocks $code before generation or any billing reservation', async ({ code, ...options }) => {
    const app = await fixture(options);
    const response = await app.command(compact(app.session));
    expect((await response.json()).error.code).toBe(code);
    expect(app.generate).not.toHaveBeenCalled();
    const stored = await app.store.session(app.session.id);
    expect(stored.version).toBe(app.session.version);
    expect(stored.contextCompaction).toBeUndefined();
    expect(stored.messages.flatMap((message) => message.costCalls ?? [])).toEqual([]);
    const quick = await app.command(fast(stored));
    expect(quick.status).toBe(200);
    expect(app.generate).not.toHaveBeenCalled();
  });

  it('rejects active and stale sessions before inference', async () => {
    const app = await fixture();
    const stale = await app.command(compact({ ...app.session, version: app.session.version - 1 }));
    expect((await stale.json()).error.code).toBe('VERSION_CONFLICT');
    const running = (
      await app.store.apply(
        makeCommand({
          type: 'send_message',
          sessionId: app.session.id,
          expectedVersion: app.session.version,
          content: 'Keep working.',
        }),
      )
    ).session;
    const busy = await app.command(compact(running));
    expect((await busy.json()).error.code).toBe('BUSY');
    expect(app.generate).not.toHaveBeenCalled();
  });

  it('validates the active role and a missing managed model before generation', async () => {
    const app = await fixture({ config: { provider: 'llama-server', cloudConsent: false } });
    const roleSession = (
      await app.store.apply(
        makeCommand({
          type: 'configure_session',
          sessionId: app.session.id,
          expectedVersion: app.session.version,
          role: 'build',
          config: { ...app.session.config, provider: 'openrouter' },
        }),
      )
    ).session;
    const denied = await app.command(compact(roleSession));
    expect((await denied.json()).error.code).toBe('CLOUD_CONSENT');
    expect(app.generate).not.toHaveBeenCalled();
    const managed = (
      await app.store.apply(
        makeCommand({
          type: 'configure_session',
          sessionId: roleSession.id,
          expectedVersion: roleSession.version,
          role: 'build',
          config: {
            ...app.session.config,
            managedModelId: crypto.randomUUID(),
            managedModelVersion: 1,
          },
        }),
      )
    ).session;
    const changed = await app.command(compact(managed));
    expect((await changed.json()).error.code).toBe('MODEL_PROFILE_CHANGED');
    expect(app.generate).not.toHaveBeenCalled();
  });

  it('persists an unsuccessful local operation claim and rejects reused IDs after restart', async () => {
    let generations = 0;
    const app = await fixture({
      config: { provider: 'llama-server' },
      provider: {
        listModels,
        capabilities: async () => ({ streaming: true, tools: true }),
        async *generate() {
          generations++;
          yield { type: 'error', code: 'MODEL_FAILED', message: 'Fixture failure' };
        },
      },
    });
    const command = compact(app.session);
    expect((await app.command(command)).status).toBe(502);
    await app.restart();
    const duplicate = await app.command(command);
    expect((await duplicate.json()).error.code).toBe('COMPACTION_ALREADY_ATTEMPTED');
    const reused = await app.command({ ...fast(app.session), commandId: command.commandId });
    expect((await reused.json()).error.code).toBe('COMMAND_REUSE');
    expect(generations).toBe(1);
  });

  it('persists usage and charge exactly once, including repeated requests after restart', async () => {
    const app = await fixture();
    const command = compact(app.session);
    const [first, duplicate] = await Promise.all([app.command(command), app.command(command)]);
    expect(first.status).toBe(200);
    expect(duplicate.status).toBe(200);
    expect((await duplicate.json()).replayed).toBe(true);
    const result = (await first.json()) as CommandResult;
    expect(result.session.contextCompaction).toMatchObject({
      summary: summary.replaceAll('\n', ' '),
      method: 'semantic',
    });
    expect(result.session.messages.at(-1)!.costCalls).toEqual([
      expect.objectContaining({
        purpose: 'manual_compaction',
        status: 'settled',
        actualCostUsd: 0.003,
        generationId: 'gen-summary',
        inputTokens: 125,
        outputTokens: 30,
      }),
    ]);
    expect(result.session.messages.map((message) => message.content)).toEqual(
      app.session.messages.map((message) => message.content),
    );
    expect(app.generate).toHaveBeenCalledOnce();
    await app.restart();
    expect((await app.command(command)).status).toBe(200);
    expect(app.generate).toHaveBeenCalledOnce();
    expect((await app.store.session(app.session.id)).messages.at(-1)!.costCalls).toHaveLength(1);
  });

  it('keeps unknown charges for reconciliation without regenerating a summary', async () => {
    let available = false,
      generations = 0;
    const app = await fixture({
      provider: {
        listModels,
        capabilities: async () => ({ streaming: true, tools: true }),
        getGenerationUsage: async (id) =>
          available
            ? { generationId: id, costUsd: 0.004, inputTokens: 127, outputTokens: 40 }
            : null,
        async *generate() {
          generations++;
          yield { type: 'usage', usage: { generationId: 'gen-delayed' } };
          yield { type: 'text_delta', text: summary };
          yield { type: 'finished', reason: 'stop' };
        },
      },
    });
    const response = await app.command(compact(app.session));
    expect(response.status).toBe(200);
    expect(
      ((await response.json()) as CommandResult).session.messages.at(-1)!.costCalls![0]!.status,
    ).toBe('unconfirmed');
    await app.restart();
    available = true;
    const stored = await app.store.session(app.session.id);
    const reconciled = await app.request('/v1/costs/reconcile', {
      sessionId: stored.id,
      expectedVersion: stored.version,
    });
    expect(reconciled.status).toBe(200);
    const result = await reconciled.json();
    expect(result).toMatchObject({ reconciled: 1, remaining: 0, withoutId: 0 });
    expect(result.session.messages.at(-1).costCalls[0]).toMatchObject({
      status: 'settled',
      actualCostUsd: 0.004,
    });
    expect(generations).toBe(1);
  });

  it.each(['invalid', 'stream-failed'] as const)(
    'preserves an earlier checkpoint and charge when the model is %s',
    async (failure) => {
      let generations = 0;
      const app = await fixture({
        provider: {
          listModels,
          capabilities: async () => ({ streaming: true, tools: true }),
          getGenerationUsage: async (id) => ({ generationId: id, costUsd: 0.002 }),
          async *generate() {
            generations++;
            yield { type: 'usage', usage: { generationId: 'gen-failed' } };
            if (failure === 'stream-failed') throw new Error('Disconnected');
            yield { type: 'text_delta', text: 'too short' };
            yield { type: 'finished', reason: 'stop' };
          },
        },
      });
      const quick = await app.command(fast(app.session));
      const baseline = ((await quick.json()) as CommandResult).session;
      const command = compact(baseline);
      const failed = await app.command(command);
      expect(failed.status).toBe(502);
      const stored = await app.store.session(baseline.id);
      expect(stored.contextCompaction).toEqual(baseline.contextCompaction);
      expect(stored.messages.at(-1)!.costCalls![0]).toMatchObject({
        generationId: 'gen-failed',
        status: 'settled',
        actualCostUsd: 0.002,
      });
      await app.restart();
      expect((await app.command(command)).status).toBe(409);
      expect(generations).toBe(1);
      expect((await app.store.session(baseline.id)).contextCompaction).toEqual(
        baseline.contextCompaction,
      );
    },
  );

  it('refuses to apply a summary over a changed conversation while retaining its bill', async () => {
    let mutate!: () => Promise<void>;
    const app = await fixture({
      provider: {
        listModels,
        capabilities: async () => ({ streaming: true, tools: true }),
        async *generate() {
          yield { type: 'usage', usage: { generationId: 'gen-conflict' } };
          await mutate();
          yield { type: 'text_delta', text: summary };
          yield { type: 'usage', usage: { costUsd: 0.001 } };
          yield { type: 'finished', reason: 'stop' };
        },
      },
    });
    mutate = async () => {
      const current = await app.store.session(app.session.id);
      await app.store.apply(
        makeCommand({
          type: 'save_plan',
          sessionId: current.id,
          expectedVersion: current.version,
          plan: { ...current.plan, instructions: 'New user correction.' },
        }),
      );
    };
    const response = await app.command(compact(app.session));
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe('VERSION_CONFLICT');
    const stored = await app.store.session(app.session.id);
    expect(stored.plan.instructions).toBe('New user correction.');
    expect(stored.contextCompaction).toBeUndefined();
    expect(stored.messages.at(-1)!.costCalls![0]).toMatchObject({
      status: 'settled',
      actualCostUsd: 0.001,
    });
  });
});
