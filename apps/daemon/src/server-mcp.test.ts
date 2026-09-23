import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type ServerResponse } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  defaultModelConfig,
  makeCommand,
  type InferenceProvider,
  type InferenceRequest,
  type Session,
} from '@lodex/contracts';
import { mcpToolName, type McpRegistration } from '@lodex/mcp';
import { Store } from '@lodex/storage';
import { startServer } from './server';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
async function fixture(
  options: {
    drop?: boolean;
    hold?: boolean;
    cloud?: boolean;
    plain?: boolean;
    goal?: boolean;
    sampling?: boolean;
    elicitation?: boolean;
    secretElicitation?: boolean;
  } = {},
) {
  let calls = 0,
    connections = 0,
    samplingResponses = 0,
    elicitationResponses = 0;
  let pendingSample: { id: number; response: ServerResponse } | undefined;
  let pendingElicitation: { id: number; response: ServerResponse } | undefined;
  let description = 'Echo fixture';
  const mcp = createServer(async (req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405);
      res.end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const message = JSON.parse(Buffer.concat(chunks).toString());
    if (options.sampling && message.id === 88 && !message.method) {
      samplingResponses++;
      res.writeHead(202);
      res.end();
      const pending = pendingSample;
      pendingSample = undefined;
      pending?.response.end(
        `data: ${JSON.stringify({
          jsonrpc: '2.0',
          id: pending.id,
          result: { content: [{ type: 'text', text: message.result.content.text }] },
        })}\n\n`,
      );
      return;
    }
    if (options.elicitation && message.id === 89 && !message.method) {
      elicitationResponses++;
      res.writeHead(202);
      res.end();
      const pending = pendingElicitation;
      pendingElicitation = undefined;
      if (message.error) {
        pending?.response.end(
          `data: ${JSON.stringify({
            jsonrpc: '2.0',
            id: pending.id,
            error: {
              code: -32000,
              message: message.error.message ?? 'Elicitation rejected by client',
            },
          })}\n\n`,
        );
        return;
      }
      pending?.response.end(
        `data: ${JSON.stringify({
          jsonrpc: '2.0',
          id: pending.id,
          result: {
            content: [{ type: 'text', text: message.result.content.projectName }],
          },
        })}\n\n`,
      );
      return;
    }
    if (message.id === undefined) {
      res.writeHead(202);
      res.end();
      return;
    }
    let result: unknown = {};
    if (message.method === 'initialize') {
      connections++;
      result = {
        protocolVersion: '2025-11-25',
        capabilities: { tools: {} },
        serverInfo: { name: 'fixture', version: '1' },
      };
    }
    if (message.method === 'tools/list')
      result = {
        tools: ['echo', 'unselected'].map((name) => ({
          name,
          description,
          inputSchema: {
            type: 'object',
            properties: { text: { type: 'string' } },
            required: ['text'],
            additionalProperties: false,
          },
          annotations: { readOnlyHint: true },
        })),
      };
    if (message.method === 'tools/call') {
      calls++;
      if (options.drop) {
        req.socket.destroy();
        return;
      }
      if (options.hold) return;
      if (options.sampling) {
        pendingSample = { id: message.id, response: res };
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        res.write(
          `data: ${JSON.stringify({
            jsonrpc: '2.0',
            id: 88,
            method: 'sampling/createMessage',
            params: {
              messages: [
                { role: 'user', content: { type: 'text', text: 'Summarize the fixture' } },
              ],
              maxTokens: 64,
              includeContext: 'none',
            },
          })}\n\n`,
        );
        return;
      }
      if (options.elicitation) {
        pendingElicitation = { id: message.id, response: res };
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        res.write(
          `data: ${JSON.stringify({
            jsonrpc: '2.0',
            id: 89,
            method: 'elicitation/create',
            params: {
              mode: 'form',
              message: 'Choose the project name',
              requestedSchema: {
                type: 'object',
                properties: options.secretElicitation
                  ? { apiToken: { type: 'string', title: 'API token' } }
                  : {
                      projectName: {
                        type: 'string',
                        title: 'Project name',
                        minLength: 1,
                        maxLength: 40,
                      },
                      public: { type: 'boolean', title: 'Public', default: false },
                    },
                required: [options.secretElicitation ? 'apiToken' : 'projectName'],
              },
            },
          })}\n\n`,
        );
        return;
      }
      result = { content: [{ type: 'text', text: message.params.arguments.text }] };
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
  });
  await new Promise<void>((resolve) => mcp.listen(0, '127.0.0.1', resolve));
  cleanup.push(
    () =>
      new Promise<void>((resolve) => {
        mcp.close(() => resolve());
        mcp.closeAllConnections();
      }),
  );
  const address = mcp.address();
  if (!address || typeof address === 'string') throw new Error('port');
  const dir = await mkdtemp(join(tmpdir(), 'lodex-mcp-api-'));
  cleanup.push(async () => {
    if (dirname(resolve(dir)) !== resolve(tmpdir())) throw new Error('unsafe');
    await rm(dir, { recursive: true, force: true });
  });
  const store = await Store.open(join(dir, 'state.sqlite'), resolve('apps/daemon/dist/worker.cjs'));
  const requests: InferenceRequest[] = [];
  const provider: InferenceProvider = {
    listModels: async () => [],
    capabilities: async () => ({ tools: true, streaming: true }),
    async *generate(request) {
      requests.push(structuredClone(request));
      const name = request.tools?.find((tool) => tool.function.name.startsWith('mcp_'))?.function
        .name;
      const hasToolResult = request.messages.some((message) => message.role === 'tool');
      if (name && !options.plain && !hasToolResult) {
        yield {
          type: 'tool_call_delta',
          index: 0,
          id: 'fixture-call',
          name,
          arguments: '{"text":"MCP result fixture"}',
        };
        yield { type: 'finished', reason: 'tool_calls' };
      } else if (options.goal && hasToolResult) {
        yield {
          type: 'tool_call_delta',
          index: 0,
          id: 'fixture-complete-goal',
          name: 'complete_goal',
          arguments: JSON.stringify({ evidence: 'The selected MCP read completed successfully.' }),
        };
        yield { type: 'finished', reason: 'tool_calls' };
      } else {
        yield { type: 'text_delta', text: 'Fixture complete' };
        yield { type: 'finished', reason: 'stop' };
      }
    },
  };
  const app = await startServer({
    store,
    token: 'f'.repeat(64),
    openrouterKey: 'unused-test-key',
    providerFactory: () => provider,
  });
  cleanup.push(() => app.close());
  const request = (path: string, body?: unknown) =>
    fetch(`http://127.0.0.1:${app.port}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: 'Bearer ' + 'f'.repeat(64), 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const config = {
    name: 'Fixture MCP',
    transport: 'http',
    url: `http://127.0.0.1:${address.port}/mcp`,
    protocol: 'legacy',
  };
  const unapproved = await request('/v1/mcp/register', { config, approved: false });
  expect(unapproved.status).toBe(400);
  expect(connections).toBe(0);
  const registered = await request('/v1/mcp/register', { config, approved: true });
  expect(registered.status).toBe(200);
  const server = (await registered.json()).server as McpRegistration;
  const tool = server.tools.find((tool) => tool.name === 'echo')!;
  const selections = [
    {
      serverId: server.id,
      serverRevision: server.revision,
      toolName: tool.name,
      toolRevision: tool.revision,
    },
  ];
  const created = await store.apply(
    makeCommand({
      type: 'create_session',
      sessionId: crypto.randomUUID(),
      title: 'MCP fixture',
      config: {
        ...defaultModelConfig(),
        provider: options.cloud ? 'openrouter' : 'llama-server',
        model: 'fixture',
        cloudConsent: !!options.cloud,
      },
    }),
  );
  let session = (
    await store.apply(
      makeCommand({
        type: 'configure_mcp',
        sessionId: created.session.id,
        expectedVersion: created.session.version,
        mcp: selections,
        mcpCloudConsent: !!options.cloud,
      }),
    )
  ).session;
  const send = (value: Session = session) =>
    request(
      '/v1/commands',
      makeCommand({
        type: 'send_message',
        sessionId: value.id,
        expectedVersion: value.version,
        content: 'Use the selected tool',
      }),
    );
  return {
    store,
    request,
    server,
    selections,
    session,
    send,
    requests,
    calls: () => calls,
    connections: () => connections,
    samplingResponses: () => samplingResponses,
    elicitationResponses: () => elicitationResponses,
    change: () => {
      description = 'Changed definition';
    },
  };
}
describe('MCP session integration', () => {
  it('runs approved MCP sampling with isolated context and shared model accounting', async () => {
    const f = await fixture({ sampling: true });
    const full = (
      await f.store.apply(
        makeCommand({
          type: 'set_permission_mode',
          sessionId: f.session.id,
          expectedVersion: f.session.version,
          mode: 'full',
        }),
      )
    ).session;
    expect((await f.send(full)).status).toBe(200);
    await expect.poll(async () => (await f.store.session(full.id)).run?.status).toBe('completed');
    expect(f.calls()).toBe(1);
    expect(f.samplingResponses()).toBe(1);
    expect(f.requests).toHaveLength(3);
    const sampling = f.requests[1]!;
    expect(sampling.tools).toBeUndefined();
    expect(sampling.messages[0]?.role).toBe('system');
    expect(sampling.messages[0]?.content).toContain('isolated MCP Sampling request');
    expect(JSON.stringify(sampling)).not.toContain('Use the selected tool');
    const session = await f.store.session(full.id);
    expect(
      session.messages.at(-1)?.activities?.find((activity) => activity.label === 'MCP 모델 요청'),
    ).toMatchObject({
      status: 'completed',
      text: 'Fixture complete',
      approval: { status: 'approved', decidedBy: 'full_access' },
    });
  });
  it('pauses an MCP sampling request for approval and resumes the same response immediately', async () => {
    const f = await fixture({ sampling: true });
    expect((await f.send()).status).toBe(200);
    await expect
      .poll(
        async () =>
          (await f.store.session(f.session.id)).messages
            .at(-1)
            ?.activities?.find((activity) => activity.label === 'MCP 모델 요청')?.approval?.status,
      )
      .toBe('pending');
    const waiting = await f.store.session(f.session.id);
    const activity = waiting.messages
      .at(-1)
      ?.activities?.find((activity) => activity.label === 'MCP 모델 요청');
    const approved = await f.request('/v1/approvals', {
      sessionId: waiting.id,
      expectedVersion: waiting.version,
      activityId: activity!.id,
      action: 'approve',
    });
    expect(approved.status).toBe(200);
    await expect
      .poll(async () => (await f.store.session(f.session.id)).run?.status)
      .toBe('completed');
    expect(f.samplingResponses()).toBe(1);
    expect(
      (await f.store.session(f.session.id)).messages
        .at(-1)
        ?.activities?.find((entry) => entry.id === activity!.id)?.approval,
    ).toMatchObject({ status: 'approved', decidedBy: 'user' });
  });
  it('pauses for MCP form elicitation, validates the answer and never persists its values', async () => {
    const f = await fixture({ elicitation: true });
    expect((await f.send()).status).toBe(200);
    await expect
      .poll(
        async () =>
          (await f.store.session(f.session.id)).messages
            .at(-1)
            ?.activities?.find((activity) => activity.elicitation)?.elicitation?.status,
      )
      .toBe('pending');
    const waiting = await f.store.session(f.session.id);
    const activity = waiting.messages.at(-1)?.activities?.find((entry) => entry.elicitation);
    expect(activity?.elicitation).toMatchObject({
      mode: 'form',
      message: 'Choose the project name',
      fields: [
        { name: 'projectName', type: 'string', required: true },
        { name: 'public', type: 'boolean', default: false },
      ],
    });
    const invalid = await f.request('/v1/mcp/elicitation', {
      sessionId: waiting.id,
      expectedVersion: waiting.version,
      activityId: activity!.id,
      action: 'accept',
      content: { projectName: '' },
    });
    expect(invalid.status).toBe(400);
    const accepted = await f.request('/v1/mcp/elicitation', {
      sessionId: waiting.id,
      expectedVersion: waiting.version,
      activityId: activity!.id,
      action: 'accept',
      content: { projectName: 'Private answer', public: false },
    });
    expect(accepted.status).toBe(200);
    await expect
      .poll(async () => (await f.store.session(f.session.id)).run?.status)
      .toBe('completed');
    expect(f.elicitationResponses()).toBe(1);
    const completed = await f.store.session(f.session.id);
    const serialized = JSON.stringify(
      completed.messages.at(-1)?.activities?.find((entry) => entry.id === activity!.id),
    );
    expect(serialized).not.toContain('Private answer');
    expect(JSON.parse(serialized).elicitation.status).toBe('accepted');
  });
  it('rejects MCP forms that request secrets before exposing an input field', async () => {
    const f = await fixture({ elicitation: true, secretElicitation: true });
    expect((await f.send()).status).toBe(200);
    await expect.poll(async () => (await f.store.session(f.session.id)).run?.status).toBe('failed');
    expect(f.elicitationResponses()).toBe(1);
    const completed = await f.store.session(f.session.id);
    expect(completed.messages.at(-1)?.error).toContain('자동으로 반복하지 마세요');
    expect(completed.messages.at(-1)?.activities?.some((entry) => entry.elicitation)).toBe(false);
  });
  it('settles the audit if cancellation arrives while persisting call intent', async () => {
    const f = await fixture();
    const record = f.store.recordMcpCall.bind(f.store);
    vi.spyOn(f.store, 'recordMcpCall').mockImplementation(async (sessionId, activityId, audit) => {
      const session = await record(sessionId, activityId, audit);
      if (audit.status === 'running')
        await f.request(
          '/v1/commands',
          makeCommand({ type: 'cancel_run', sessionId, runId: session.run!.id }),
        );
      return session;
    });
    await f.send();
    await expect
      .poll(
        async () =>
          (await f.store.session(f.session.id)).messages.at(-1)?.activities?.find((a) => a.mcpCall)
            ?.mcpCall?.finishedAt,
      )
      .toBeDefined();
    expect(
      (await f.store.session(f.session.id)).messages.at(-1)?.activities?.find((a) => a.mcpCall)
        ?.mcpCall?.status,
    ).toBe('unknown');
    expect(f.calls()).toBe(0);
  });
  it('uses only selected tools and persists the result, revisions and cloud-history marker', async () => {
    const f = await fixture();
    expect((await f.send()).status).toBe(200);
    await expect
      .poll(async () => (await f.store.session(f.session.id)).run?.status)
      .toBe('completed');
    expect(f.calls()).toBe(1);
    expect(
      f.requests[0]!.tools!.filter((tool) => tool.function.name.startsWith('mcp_')).map(
        (tool) => tool.function.name,
      ),
    ).toEqual([mcpToolName(f.server.id, 'echo')]);
    expect(JSON.stringify(f.requests[1])).toContain('MCP result fixture');
    const session = await f.store.session(f.session.id);
    expect(session.hasMcpHistory).toBe(true);
    expect(session.messages.at(-1)?.activities?.find((a) => a.mcpCall)?.mcpCall).toMatchObject({
      status: 'completed',
      ...f.selections[0],
    });
    await expect(
      f.store.apply(
        makeCommand({
          type: 'configure_mcp',
          sessionId: session.id,
          expectedVersion: session.version,
          mcp: [{ ...f.selections[0]!, toolRevision: '0'.repeat(64) }],
          mcpCloudConsent: false,
        }),
      ),
    ).rejects.toMatchObject({ code: 'MCP_CHANGED' });
  });
  it('runs selected read-only MCP tools during a goal and completes without replay', async () => {
    const f = await fixture({ goal: true });
    const response = await f.request(
      '/v1/commands',
      makeCommand({
        type: 'start_goal',
        sessionId: f.session.id,
        expectedVersion: f.session.version,
        goal: 'Read the selected MCP source and finish with evidence',
        limits: {},
      }),
    );
    expect(response.status).toBe(200);
    await expect
      .poll(async () => (await f.store.session(f.session.id)).run?.status)
      .toBe('completed');
    expect(f.calls()).toBe(1);
    const session = await f.store.session(f.session.id);
    expect(session.autopilot).toMatchObject({ status: 'completed', goalDriven: true });
    expect(session.messages.at(-1)?.activities?.find((a) => a.mcpCall)?.mcpCall?.status).toBe(
      'completed',
    );
  });
  it('does not start MCP in Plan even for readOnlyHint tools', async () => {
    const f = await fixture();
    const session = (
      await f.store.apply(
        makeCommand({
          type: 'set_mode',
          sessionId: f.session.id,
          expectedVersion: f.session.version,
          mode: 'plan',
        }),
      )
    ).session;
    expect((await f.send(session)).status).toBe(200);
    await expect
      .poll(async () => (await f.store.session(session.id)).run?.status)
      .toBe('completed');
    expect(f.connections()).toBe(1);
    expect(f.calls()).toBe(0);
    expect(f.requests[0]!.tools?.some((tool) => tool.function.name.startsWith('mcp_'))).toBe(false);
  });
  it('halts on unknown outcomes without another model call or tool replay', async () => {
    const f = await fixture({ drop: true });
    await f.send();
    await expect.poll(async () => (await f.store.session(f.session.id)).run?.status).toBe('failed');
    expect(f.calls()).toBe(1);
    expect(f.requests.length).toBe(1);
    expect(
      (await f.store.session(f.session.id)).messages.at(-1)?.activities?.find((a) => a.mcpCall)
        ?.mcpCall?.status,
    ).toBe('unknown');
  });
  it('keeps the uncertain call audit after cancellation and blocks registration changes while running', async () => {
    const f = await fixture({ hold: true });
    await f.send();
    await expect.poll(f.calls).toBe(1);
    expect(
      (await f.request('/v1/mcp/remove', { id: f.server.id, expectedRevision: f.server.revision }))
        .status,
    ).toBe(409);
    const session = await f.store.session(f.session.id);
    await f.request(
      '/v1/commands',
      makeCommand({ type: 'cancel_run', sessionId: session.id, runId: session.run!.id }),
    );
    await expect
      .poll(
        async () =>
          (await f.store.session(session.id)).messages.at(-1)?.activities?.find((a) => a.mcpCall)
            ?.mcpCall?.status,
      )
      .toBe('unknown');
    expect((await f.store.session(session.id)).run?.status).toBe('cancelled');
    expect(f.calls()).toBe(1);
  });
  it('rejects changed server schemas before sending tools/call', async () => {
    const f = await fixture();
    f.change();
    await f.send();
    await expect.poll(async () => (await f.store.session(f.session.id)).run?.status).toBe('failed');
    expect(f.calls()).toBe(0);
  });
  it('requires renewed cloud consent after deselection, including catalog-only history', async () => {
    const f = await fixture({ cloud: true, plain: true });
    await f.send();
    await expect
      .poll(async () => (await f.store.session(f.session.id)).run?.status)
      .toBe('completed');
    const session = await f.store.session(f.session.id);
    expect(session.hasMcpHistory).toBe(true);
    expect(f.calls()).toBe(0);
    const deselected = (
      await f.store.apply(
        makeCommand({
          type: 'configure_mcp',
          sessionId: session.id,
          expectedVersion: session.version,
          mcp: [],
          mcpCloudConsent: false,
        }),
      )
    ).session;
    const blocked = await f.send(deselected);
    expect(blocked.status).toBe(403);
    expect((await blocked.json()).error.code).toBe('MCP_CLOUD_CONSENT');
    expect(f.requests.length).toBe(1);
  });
});
