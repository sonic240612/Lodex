import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parseEnv } from 'node:util';
import {
  defaultModelConfig,
  makeCommand,
  type InferenceProvider,
  type InferenceRequest,
} from '@lodex/contracts';
import {
  oauthTokenKey,
  type McpRegistration,
  type OAuthPreparation,
  type OAuthStatus,
} from '@lodex/mcp';
import { Store } from '@lodex/storage';
import { startServer } from './server';

const cleanups: (() => Promise<void>)[] = [];
const accessToken = 'oauth-integration-access-fixture';
const refreshToken = 'oauth-integration-refresh-fixture';
const originalEnv = '# User-managed fixture settings\nLODEX_MCP_OTHER=leave-this-fixture-alone\n';
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

interface Login {
  id: string;
  authorizationUrl: string;
  redirectUri: string;
  expiresAt: number;
}
interface Rpc {
  id?: number;
  method: string;
  params?: { arguments?: { text?: string } };
}
async function fixture() {
  let base = '';
  let holdTools = false;
  const requests: { path: string; authorization: string | undefined; body: string }[] = [];
  const rpc: Rpc[] = [];
  const authority = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString('utf8'),
      path = request.url ?? '';
    requests.push({ path, authorization: request.headers.authorization, body });
    const json = (value: unknown) => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(value));
    };
    if (path === '/mcp') {
      if (request.headers.authorization !== 'Bearer ' + accessToken) {
        response
          .writeHead(401, {
            'WWW-Authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp", scope="read"`,
          })
          .end();
        return;
      }
      if (request.method !== 'POST') {
        response.writeHead(405).end();
        return;
      }
      const message = JSON.parse(body) as Rpc;
      rpc.push(message);
      if (message.id === undefined) {
        response.writeHead(202).end();
        return;
      }
      if (holdTools && message.method === 'tools/call') return;
      let result: unknown;
      if (message.method === 'initialize')
        result = {
          protocolVersion: '2025-11-25',
          capabilities: { tools: {}, resources: {} },
          serverInfo: { name: 'Protected fixture', version: '1' },
        };
      if (message.method === 'tools/list')
        result = {
          tools: [
            {
              name: 'echo',
              description: 'Protected echo',
              inputSchema: {
                type: 'object',
                properties: { text: { type: 'string' } },
                required: ['text'],
                additionalProperties: false,
              },
            },
          ],
        };
      if (message.method === 'tools/call')
        result = {
          content: [
            {
              type: 'text',
              text: `Protected result: ${message.params?.arguments?.text} ${accessToken}`,
            },
          ],
        };
      if (message.method === 'resources/list')
        result = {
          resources: [
            { uri: 'fixture://private', name: 'Protected reference', mimeType: 'text/plain' },
          ],
        };
      if (message.method === 'resources/templates/list') result = { resourceTemplates: [] };
      if (message.method === 'resources/read')
        result = {
          contents: [
            {
              uri: 'fixture://private',
              mimeType: 'text/plain',
              text: `Protected reference: ${accessToken}`,
            },
          ],
        };
      json({
        jsonrpc: '2.0',
        id: message.id,
        ...(result
          ? { result }
          : { error: { code: -32601, message: 'Unexpected fixture method' } }),
      });
    } else if (path === '/.well-known/oauth-protected-resource/mcp')
      json({ resource: `${base}/mcp`, authorization_servers: [`${base}/issuer`] });
    else if (path === '/.well-known/oauth-authorization-server/issuer')
      json({
        issuer: `${base}/issuer`,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        token_endpoint_auth_methods_supported: ['none'],
        code_challenge_methods_supported: ['S256'],
        authorization_response_iss_parameter_supported: true,
      });
    else if (path === '/token')
      json({
        token_type: 'Bearer',
        access_token: accessToken,
        refresh_token: refreshToken,
        expires_in: 3600,
        scope: 'read',
        resource: `${base}/mcp`,
        iss: `${base}/issuer`,
      });
    else response.writeHead(404).end();
  });
  await new Promise<void>((done) => authority.listen(0, '127.0.0.1', done));
  const address = authority.address();
  if (!address || typeof address === 'string') throw new Error('No OAuth fixture port');
  base = `http://127.0.0.1:${address.port}`;
  cleanups.push(
    () =>
      new Promise<void>((done) => {
        authority.closeAllConnections();
        authority.close(() => done());
      }),
  );
  const directory = await mkdtemp(join(tmpdir(), 'lodex-oauth-api-'));
  cleanups.push(async () => {
    if (dirname(resolve(directory)) !== resolve(tmpdir()))
      throw new Error('Unsafe fixture cleanup');
    await rm(directory, { recursive: true, force: true });
  });
  const envFilePath = join(directory, '.env'),
    privateEnvPath = join(directory, '.env.mcp');
  await writeFile(envFilePath, originalEnv, 'utf8');
  const modelRequests: InferenceRequest[] = [];
  const provider: InferenceProvider = {
    listModels: async () => [],
    capabilities: async () => ({ tools: true, streaming: true }),
    async *generate(request) {
      modelRequests.push(structuredClone(request));
      const selected = request.tools?.find((tool) => tool.function.name.startsWith('mcp_'));
      if (selected && request.messages.at(-1)?.role !== 'tool') {
        yield {
          type: 'tool_call_delta',
          index: 0,
          id: crypto.randomUUID(),
          name: selected.function.name,
          arguments: '{"text":"selected work"}',
        };
        yield { type: 'finished', reason: 'tool_calls' };
      } else {
        yield { type: 'text_delta', text: 'Protected fixture complete' };
        yield { type: 'finished', reason: 'stop' };
      }
    },
  };
  const open = async () => {
    const store = await Store.open(
      join(directory, 'state.sqlite'),
      resolve('apps/daemon/dist/worker.cjs'),
    );
    const app = await startServer({
      store,
      token: 'a'.repeat(64),
      envFilePath,
      providerFactory: () => provider,
    });
    return { store, app };
  };
  let current = await open();
  cleanups.push(() => current.app.close());
  const request = (path: string, body?: unknown) =>
    fetch(`http://127.0.0.1:${current.app.port}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: 'Bearer ' + 'a'.repeat(64), 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const binding = { resourceUrl: `${base}/mcp`, clientId: 'fixture-public-client' };
  const config = {
    name: 'OAuth fixture',
    transport: 'http',
    url: binding.resourceUrl,
    protocol: 'legacy',
    headers: {},
    oauth: { clientId: binding.clientId },
  };
  const prepare = async () => {
    const response = await request('/v1/mcp/oauth/prepare', binding);
    expect(response.status).toBe(200);
    return (await response.json()) as OAuthPreparation;
  };
  const begin = async (preview: OAuthPreparation) => {
    const response = await request('/v1/mcp/oauth/begin', {
      preparationId: preview.id,
      approvedOrigins: preview.origins,
    });
    expect(response.status).toBe(200);
    return (await response.json()) as Login;
  };
  const complete = async () => {
    const preview = await prepare(),
      login = await begin(preview),
      authorization = new URL(login.authorizationUrl);
    const callback = new URL(login.redirectUri);
    callback.search = new URLSearchParams({
      state: authorization.searchParams.get('state')!,
      iss: preview.issuer,
      code: 'fixture-authorization-code',
    }).toString();
    expect((await fetch(callback)).status).toBe(200);
    const status = await request('/v1/mcp/oauth/status', { id: login.id });
    expect(status.status).toBe(200);
    expect((await status.json()).status).toBe('completed');
    return { preview, login, authorization };
  };
  return {
    base,
    requests,
    rpc,
    binding,
    config,
    request,
    prepare,
    begin,
    complete,
    envFilePath,
    privateEnvPath,
    modelRequests,
    get store() {
      return current.store;
    },
    holdTools() {
      holdTools = true;
    },
    async restart() {
      await current.app.close();
      current = await open();
    },
  };
}

describe('MCP OAuth daemon integration', () => {
  it('persists PKCE login only in private env storage and reconnects after restart without exposing tokens', async () => {
    const f = await fixture();
    const { preview, login, authorization } = await f.complete();
    expect(authorization.searchParams.get('resource')).toBe(f.binding.resourceUrl);
    expect(authorization.searchParams.get('code_challenge_method')).toBe('S256');
    const tokenExchange = new URLSearchParams(
      f.requests.find((request) => request.path === '/token')!.body,
    );
    expect(tokenExchange.get('client_id')).toBe(f.binding.clientId);
    expect(tokenExchange.get('redirect_uri')).toBe(login.redirectUri);
    expect(tokenExchange.get('resource')).toBe(f.binding.resourceUrl);
    expect(
      createHash('sha256').update(tokenExchange.get('code_verifier')!).digest('base64url'),
    ).toBe(authorization.searchParams.get('code_challenge'));
    const privateFile = parseEnv(await readFile(f.privateEnvPath, 'utf8'));
    const key = oauthTokenKey(f.binding),
      encoded = privateFile[key]!;
    expect(Object.keys(privateFile)).toEqual([key]);
    expect(JSON.parse(Buffer.from(encoded, 'base64url').toString())).toMatchObject({
      ...f.binding,
      accessToken,
      refreshToken,
      issuer: preview.issuer,
    });
    expect(await readFile(f.envFilePath, 'utf8')).toBe(originalEnv);
    const registered = await f.request('/v1/mcp/register', { config: f.config, approved: true });
    expect(registered.status).toBe(200);
    const registration = (await registered.json()).server as McpRegistration;
    const read = await f.request('/v1/mcp/content', {
      serverId: registration.id,
      serverRevision: registration.revision,
      kind: 'resource',
      entryKey: registration.resources![0]!.uri,
      entryRevision: registration.resources![0]!.revision,
    });
    expect(read.status).toBe(200);
    expect((await read.json()).text).toBe('Protected reference: [redacted]');
    const status = await f.request('/v1/mcp/oauth/status', { id: login.id });
    const visible = JSON.stringify([
      preview,
      await status.json(),
      await (await f.request('/v1/state')).json(),
      await (await f.request('/v1/mcp')).json(),
      await f.store.registeredMcp(),
    ]);
    for (const secret of [
      accessToken,
      refreshToken,
      encoded,
      'fixture-authorization-code',
      tokenExchange.get('code_verifier')!,
    ])
      expect(visible).not.toContain(secret);
    expect(
      f.requests
        .filter((request) => request.authorization)
        .every(
          (request) => request.path === '/mcp' && request.authorization === 'Bearer ' + accessToken,
        ),
    ).toBe(true);
    await f.restart();
    const restored = await f.request('/v1/mcp/register', {
      config: f.config,
      approved: true,
      id: registration.id,
      expectedRevision: registration.revision,
    });
    expect(restored.status).toBe(200);
    expect(f.requests.filter((request) => request.path === '/token')).toHaveLength(1);
    expect(JSON.stringify(await f.store.registeredMcp())).not.toContain(accessToken);
  });

  it('uses the bound token for selected tools and blocks new MCP connections after disconnect', async () => {
    const f = await fixture();
    const { login } = await f.complete();
    const response = await f.request('/v1/mcp/register', { config: f.config, approved: true });
    expect(response.status).toBe(200);
    const registration = (await response.json()).server as McpRegistration,
      tool = registration.tools[0]!;
    const created = (
      await f.store.apply(
        makeCommand({
          type: 'create_session',
          sessionId: crypto.randomUUID(),
          title: 'OAuth tool fixture',
          config: { ...defaultModelConfig(), provider: 'llama-server', model: 'fixture' },
        }),
      )
    ).session;
    await f.store.apply(
      makeCommand({
        type: 'configure_mcp',
        sessionId: created.id,
        expectedVersion: created.version,
        mcpCloudConsent: false,
        mcp: [
          {
            serverId: registration.id,
            serverRevision: registration.revision,
            toolName: tool.name,
            toolRevision: tool.revision,
          },
        ],
      }),
    );
    const send = async () => {
      const session = await f.store.session(created.id);
      return f.request(
        '/v1/commands',
        makeCommand({
          type: 'send_message',
          sessionId: created.id,
          expectedVersion: session.version,
          content: 'Use the selected tool.',
        }),
      );
    };
    expect((await send()).status).toBe(200);
    await expect
      .poll(async () => (await f.store.session(created.id)).run?.status)
      .toBe('completed');
    expect(f.rpc.filter((request) => request.method === 'tools/call')).toHaveLength(1);
    expect(JSON.stringify(f.modelRequests)).toContain('[redacted]');
    expect(JSON.stringify(f.modelRequests)).not.toContain(accessToken);
    expect(JSON.stringify(await f.store.snapshot())).not.toContain(accessToken);
    f.holdTools();
    expect((await send()).status).toBe(200);
    await expect
      .poll(() => f.rpc.filter((request) => request.method === 'tools/call').length)
      .toBe(2);
    const disconnected = await f.request('/v1/mcp/oauth/disconnect', f.binding);
    expect(disconnected.status).toBe(200);
    expect(await disconnected.json()).toEqual({ disconnected: true });
    const stopped = await f.store.session(created.id);
    expect(stopped.run?.status).toBe('cancelled');
    expect(
      stopped.messages.at(-1)?.activities?.find((activity) => activity.mcpCall)?.mcpCall?.status,
    ).toBe('unknown');
    expect(
      parseEnv(await readFile(f.privateEnvPath, 'utf8'))[oauthTokenKey(f.binding)],
    ).toBeUndefined();
    const rpcCount = f.rpc.length;
    const deniedRegistration = await f.request('/v1/mcp/register', {
      config: f.config,
      approved: true,
    });
    expect(deniedRegistration.status).toBe(401);
    expect((await deniedRegistration.json()).error.code).toBe('MCP_OAUTH_REQUIRED');
    expect((await send()).status).toBe(200);
    await expect.poll(async () => (await f.store.session(created.id)).run?.status).toBe('failed');
    expect(f.rpc.length).toBe(rpcCount);
    expect(f.rpc.filter((request) => request.method === 'tools/call')).toHaveLength(2);
    const status = await f.request('/v1/mcp/oauth/status', { id: login.id });
    const safe = JSON.stringify(await status.json());
    expect(safe).not.toContain(accessToken);
    expect(safe).not.toContain(refreshToken);
  });

  it('requires the reviewed origins and cancels pending login without exchanging or persisting credentials', async () => {
    const f = await fixture(),
      preview = await f.prepare();
    expect(f.requests.every((request) => !request.authorization)).toBe(true);
    const empty = await f.request('/v1/mcp/oauth/begin', {
      preparationId: preview.id,
      approvedOrigins: [],
    });
    expect(empty.status).toBe(400);
    const wrong = await f.request('/v1/mcp/oauth/begin', {
      preparationId: preview.id,
      approvedOrigins: ['https://wrong.invalid'],
    });
    expect(wrong.status).toBe(400);
    expect((await wrong.json()).error.code).toBe('MCP_OAUTH_APPROVAL');
    expect(f.requests.filter((request) => request.path === '/token')).toHaveLength(0);
    const login = await f.begin(preview);
    const pending = await f.request('/v1/mcp/oauth/status', { id: login.id });
    expect((await pending.json()).status).toBe('pending');
    const cancelled = await f.request('/v1/mcp/oauth/cancel', { id: login.id });
    expect(cancelled.status).toBe(200);
    const status = (await cancelled.json()) as OAuthStatus;
    expect(status.status).toBe('cancelled');
    expect(status).not.toHaveProperty('authorizationUrl');
    await expect(fetch(login.redirectUri, { signal: AbortSignal.timeout(2000) })).rejects.toThrow();
    expect(f.requests.filter((request) => request.path === '/token')).toHaveLength(0);
    await expect(readFile(f.privateEnvPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(f.envFilePath, 'utf8')).toBe(originalEnv);
    expect((await f.request('/v1/mcp/register', { config: f.config, approved: true })).status).toBe(
      401,
    );
    expect(await f.store.registeredMcp()).toEqual([]);
  });
});
