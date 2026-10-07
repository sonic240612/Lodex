import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  defaultModelConfig,
  makeCommand,
  type Activity,
  type Command,
  type InferenceProvider,
  type PermissionMode,
  type Session,
} from '@lodex/contracts';
import { Store } from '@lodex/storage';
import { startServer } from './server';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});

async function setup(
  provider: InferenceProvider,
  webFetcher: NonNullable<Parameters<typeof startServer>[0]['webFetcher']>,
) {
  const dir = await mkdtemp(join(tmpdir(), 'lodex-web-'));
  const store = await Store.open(join(dir, 'state.sqlite'), resolve('apps/daemon/dist/worker.cjs'));
  const token = 'b'.repeat(64);
  const app = await startServer({ token, store, providerFactory: () => provider, webFetcher });
  cleanup.push(async () => {
    await app.close();
    if (dirname(resolve(dir)) !== resolve(tmpdir())) throw new Error('Unsafe test directory');
    await rm(dir, { recursive: true, force: true });
  });
  const request = (path: string, body: unknown) =>
    fetch(`http://127.0.0.1:${app.port}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  const command = async (value: Command): Promise<Session> => {
    const response = await request('/v1/commands', value);
    expect(response.status).toBe(200);
    return (await response.json()).session;
  };
  const create = async (permissionMode: PermissionMode, mode: 'plan' | 'build') => {
    let session = await command(
      makeCommand({
        type: 'create_session',
        sessionId: crypto.randomUUID(),
        title: 'Web test',
        config: {
          ...defaultModelConfig(),
          provider: 'demo',
          model: 'demo',
          contextBudgetTokens: 32768,
        },
      }),
    );
    session = await command(
      makeCommand({
        type: 'set_permission_mode',
        sessionId: session.id,
        expectedVersion: session.version,
        mode: permissionMode,
      }),
    );
    session = await command(
      makeCommand({
        type: 'set_mode',
        sessionId: session.id,
        expectedVersion: session.version,
        mode,
      }),
    );
    return session;
  };
  const pending = async (id: string): Promise<Activity> => {
    let found: Activity | undefined;
    await vi.waitFor(async () => {
      const session = await store.session(id);
      expect(session.run?.status).toBe('running');
      found = session.messages
        .at(-1)
        ?.activities?.find((activity) => activity.approval?.status === 'pending');
      expect(found).toBeDefined();
    });
    return found!;
  };
  const decide = async (id: string, activityId: string, action: 'approve' | 'reject') => {
    const current = await store.session(id);
    const response = await request('/v1/approvals', {
      sessionId: id,
      expectedVersion: current.version,
      activityId,
      action,
    });
    expect(response.status).toBe(200);
  };
  return { store, command, create, pending, decide };
}

function webProvider(
  check: (result: Record<string, unknown>) => void,
  name: 'web_fetch' | 'web_search' = 'web_fetch',
): InferenceProvider {
  let round = 0;
  return {
    listModels: async () => [],
    capabilities: async () => ({ streaming: true, tools: true }),
    async *generate(request) {
      expect(request.tools?.some((tool) => tool.function.name === name)).toBe(true);
      if (round++ === 0) {
        yield {
          type: 'tool_call_delta',
          index: 0,
          id: 'web-1',
          name,
          arguments: JSON.stringify(
            name === 'web_search'
              ? { query: 'public documentation' }
              : { url: 'https://example.com/docs' },
          ),
        };
        yield { type: 'finished', reason: 'tool_calls' };
      } else {
        check(JSON.parse(request.messages.at(-1)!.content));
        yield { type: 'text_delta', text: 'Source checked.' };
        yield { type: 'finished', reason: 'stop' };
      }
    },
  };
}

describe('web tool agent integration', () => {
  it('does not follow private redirects when public web requests are auto-approved', async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(null, { status: 302, headers: { Location: 'http://127.0.0.1/secrets' } }),
    );
    const app = await setup(
      webProvider((result) => expect(result.error).toBe('WEB_URL_DENIED')),
      fetcher,
    );
    const session = await app.create('auto', 'build');
    await app.command(
      makeCommand({
        type: 'send_message',
        sessionId: session.id,
        expectedVersion: session.version,
        content: 'Read public docs',
      }),
    );
    await expect
      .poll(async () => (await app.store.session(session.id)).run?.status)
      .toBe('completed');
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it.each([
    ['ask', 'plan'],
    ['auto', 'plan'],
    ['auto', 'build'],
  ] as const)('applies %s permissions to web search in %s', async (permissionMode, mode) => {
    const fetcher = vi.fn(
      async () =>
        new Response(
          '<a class="result__a" href="https://example.com/docs">Docs</a><div class="result__snippet">Public docs</div>',
        ),
    );
    const app = await setup(
      webProvider(
        (result) =>
          expect(result).toMatchObject({
            provider: 'duckduckgo',
            results: [{ url: 'https://example.com/docs' }],
          }),
        'web_search',
      ),
      fetcher,
    );
    const session = await app.create(permissionMode, mode);
    await app.command(
      makeCommand({
        type: 'send_message',
        sessionId: session.id,
        expectedVersion: session.version,
        content: 'Search public documentation',
      }),
    );
    if (permissionMode === 'ask') {
      const pending = await app.pending(session.id);
      expect(new URL(pending.approval!.target!).searchParams.get('q')).toBe('public documentation');
      expect(fetcher).not.toHaveBeenCalled();
      await app.decide(session.id, pending.id, 'approve');
    }
    await expect
      .poll(async () => (await app.store.session(session.id)).run?.status)
      .toBe('completed');
    expect(fetcher).toHaveBeenCalledOnce();
    const final = await app.store.session(session.id);
    expect(
      final.messages.at(-1)?.activities?.find((activity) => activity.label === 'web_search')
        ?.approval,
    ).toMatchObject({
      status: 'approved',
      decidedBy: permissionMode === 'auto' ? 'policy' : 'user',
      risk: 'low',
    });
  });
  it.each([
    ['ask', 'plan', 'approve'],
    ['auto', 'build', 'approve'],
    ['auto', 'plan', 'approve'],
    ['ask', 'build', 'reject'],
    ['full', 'plan', 'approve'],
  ] as const)(
    'continues the same %s/%s response after %s',
    async (permissionMode, mode, action) => {
      const fetcher = vi.fn(
        async () => new Response('Source content', { headers: { 'Content-Type': 'text/plain' } }),
      );
      const provider = webProvider((result) =>
        expect(result).toMatchObject(
          action === 'reject' ? { status: 'rejected' } : { status: 200, content: 'Source content' },
        ),
      );
      const app = await setup(provider, fetcher);
      const session = await app.create(permissionMode, mode);
      await app.command(
        makeCommand({
          type: 'send_message',
          sessionId: session.id,
          expectedVersion: session.version,
          content: 'Read https://example.com/docs',
        }),
      );
      if (permissionMode === 'ask') {
        const activity = await app.pending(session.id);
        expect(activity.approval).toMatchObject({
          kind: 'web',
          target: 'https://example.com/docs',
          actor: 'desktop',
        });
        expect(fetcher).not.toHaveBeenCalled();
        await app.decide(session.id, activity.id, action);
      }
      await vi.waitFor(async () =>
        expect((await app.store.session(session.id)).run?.status).toBe('completed'),
      );
      expect(fetcher).toHaveBeenCalledTimes(action === 'reject' ? 0 : 1);
      const final = await app.store.session(session.id);
      expect(final.messages.at(-1)?.content).toBe('Source checked.');
      expect(
        final.messages.at(-1)?.activities?.find((activity) => activity.label === 'web_fetch')
          ?.approval,
      ).toMatchObject({
        status: action === 'reject' ? 'rejected' : 'approved',
        decidedBy:
          permissionMode === 'full' ? 'full_access' : permissionMode === 'auto' ? 'policy' : 'user',
      });
    },
  );

  it.each(['ask', 'auto'] as const)(
    'audits redirected URLs under %s permissions',
    async (permissionMode) => {
      const fetcher = vi
        .fn(
          async () =>
            new Response('Redirected source', { headers: { 'Content-Type': 'text/plain' } }),
        )
        .mockResolvedValueOnce(
          new Response(null, {
            status: 302,
            headers: { Location: 'https://docs.example.com/api' },
          }),
        );
      const app = await setup(
        webProvider((result) => expect(result.finalUrl).toBe('https://docs.example.com/api')),
        fetcher,
      );
      const session = await app.create(permissionMode, 'plan');
      await app.command(
        makeCommand({
          type: 'send_message',
          sessionId: session.id,
          expectedVersion: session.version,
          content: 'Read docs',
        }),
      );
      if (permissionMode === 'ask') {
        const first = await app.pending(session.id);
        await app.decide(session.id, first.id, 'approve');
        const second = await app.pending(session.id);
        expect(second.id).not.toBe(first.id);
        expect(second.approval?.target).toBe('https://docs.example.com/api');
        expect(fetcher).toHaveBeenCalledTimes(1);
        await app.decide(session.id, second.id, 'approve');
      }
      await vi.waitFor(async () =>
        expect((await app.store.session(session.id)).run?.status).toBe('completed'),
      );
      const final = await app.store.session(session.id);
      expect(
        final.messages
          .at(-1)
          ?.activities?.filter((activity) => activity.approval?.kind === 'web')
          .map((activity) => activity.approval?.target),
      ).toEqual(['https://example.com/docs', 'https://docs.example.com/api']);
      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(
        final.messages
          .at(-1)
          ?.activities?.filter((activity) => activity.approval?.kind === 'web')
          .map((activity) => activity.approval?.decidedBy),
      ).toEqual(permissionMode === 'auto' ? ['policy', 'policy'] : ['user', 'user']);
    },
  );
});
