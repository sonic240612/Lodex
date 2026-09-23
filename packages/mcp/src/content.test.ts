import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { McpConnection, validateConfig } from './index';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
interface Request {
  id?: number;
  method: string;
  params?: { uri?: string; name?: string; arguments?: Record<string, string> };
}
async function fixture(modern = false) {
  const state = {
    capabilities: { resources: {}, prompts: {} } as Record<string, object>,
    resources: [
      {
        uri: 'fixture://guide',
        name: 'Guide',
        mimeType: 'text/markdown',
        description: 'Reference',
      },
    ],
    resourceTemplates: [{ uriTemplate: 'fixture://guide/{name}', name: 'Dynamic guide' }],
    prompts: [
      {
        name: 'review',
        description: 'Review selected code',
        arguments: [{ name: 'code', required: true }],
      },
    ],
    contents: [
      { uri: 'fixture://guide', text: '# A guide\nUse a small patch.', mimeType: 'text/markdown' },
    ] as object[],
    messages: [
      { role: 'user', content: { type: 'text', text: 'Review this code.' } },
      { role: 'assistant', content: { type: 'text', text: 'Check behavior and tests.' } },
    ] as object[],
    pause: '',
    inputRequired: false,
    notify: '',
    tools: [] as object[],
  };
  const requests: Request[] = [];
  const server = createServer(async (req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405);
      res.end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const message = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Request;
    requests.push(message);
    if (message.id === undefined) {
      res.writeHead(202);
      res.end();
      return;
    }
    if (state.pause === message.method) return;
    let result: Record<string, unknown> | undefined;
    if (message.method === 'initialize')
      result = {
        protocolVersion: '2025-11-25',
        capabilities: state.capabilities,
        serverInfo: { name: 'content fixture', version: '1' },
      };
    if (message.method === 'server/discover' && modern)
      result = {
        supportedVersions: ['2026-07-28'],
        capabilities: state.capabilities,
        _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'content fixture', version: '1' } },
      };
    if (message.method === 'tools/list') result = { tools: state.tools };
    if (message.method === 'resources/list') result = { resources: state.resources };
    if (message.method === 'resources/templates/list')
      result = { resourceTemplates: state.resourceTemplates };
    if (message.method === 'prompts/list') result = { prompts: state.prompts };
    if (message.method === 'resources/read')
      result = {
        contents:
          message.params?.uri === 'fixture://guide'
            ? state.contents
            : [
                {
                  uri: message.params?.uri,
                  text: `# Dynamic guide\nSelected ${message.params?.uri}`,
                  mimeType: 'text/markdown',
                },
              ],
      };
    if (message.method === 'prompts/get') result = { messages: state.messages };
    if (result && modern) {
      result.resultType = 'complete';
      if (message.method.endsWith('/list') || message.method === 'resources/read')
        Object.assign(result, { ttlMs: 0, cacheScope: 'private' });
      if (state.inputRequired && message.method === 'resources/read')
        result = { resultType: 'input_required', inputRequests: [] };
    }
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: message.id,
      ...(result ? { result } : { error: { code: -32601, message: 'Unknown method' } }),
    });
    if (state.notify && ['resources/read', 'prompts/get'].includes(message.method)) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(
        `data: ${JSON.stringify({ jsonrpc: '2.0', method: state.notify })}\n\ndata: ${body}\n\n`,
      );
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(body);
    }
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  cleanups.push(
    () =>
      new Promise<void>((done) => {
        server.close(() => done());
        server.closeAllConnections();
      }),
  );
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No fixture port');
  const config = validateConfig({
    name: 'Content fixture',
    transport: 'http',
    protocol: 'auto',
    url: `http://127.0.0.1:${address.port}/mcp`,
  });
  async function connect(options: Partial<Parameters<typeof McpConnection.connect>[0]> = {}) {
    const connection = await McpConnection.connect({
      config,
      supervisorPath: resolve('apps/daemon/dist/mcp-supervisor.cjs'),
      signal: AbortSignal.timeout(10000),
      resolveSecret: async () => null,
      ...options,
    });
    cleanups.push(() => connection.close());
    return connection;
  }
  return { state, requests, connect, config };
}
function resourceOptions(connection: McpConnection) {
  const selected = connection.registration.resources![0]!;
  return {
    serverRevision: connection.registration.revision,
    uri: selected.uri,
    revision: selected.revision,
    signal: AbortSignal.timeout(2000),
  };
}
function promptOptions(connection: McpConnection) {
  const selected = connection.registration.prompts![0]!;
  return {
    serverRevision: connection.registration.revision,
    name: selected.name,
    revision: selected.revision,
    arguments: { code: 'x()' },
    signal: AbortSignal.timeout(2000),
  };
}
function templateOptions(connection: McpConnection) {
  const selected = connection.registration.resourceTemplates![0]!;
  return {
    serverRevision: connection.registration.revision,
    uriTemplate: selected.uriTemplate,
    revision: selected.revision,
    arguments: { name: 'setup notes' },
    signal: AbortSignal.timeout(2000),
  };
}
describe('MCP explicit content reads', () => {
  it.each([false, true])(
    'inspects and reads pinned text resources/prompts with modern=%s',
    async (modern) => {
      const server = await fixture(modern),
        connection = await server.connect();
      expect(connection.registration.tools).toEqual([]);
      expect(connection.registration.resources?.[0]).toMatchObject({
        uri: 'fixture://guide',
        supported: true,
      });
      expect(connection.registration.prompts?.[0]).toMatchObject({
        name: 'review',
        supported: true,
      });
      expect(connection.registration.resourceTemplates?.[0]).toMatchObject({
        uriTemplate: 'fixture://guide/{name}',
        variables: ['name'],
        supported: true,
      });
      expect(
        server.requests.some((req) => ['resources/read', 'prompts/get'].includes(req.method)),
      ).toBe(false);
      const resource = await connection.readResource(resourceOptions(connection));
      expect(resource.text).toBe('# A guide\nUse a small patch.');
      expect(resource.provenance).toMatchObject({
        serverId: connection.registration.id,
        serverRevision: connection.registration.revision,
        entryKey: 'fixture://guide',
        entryRevision: connection.registration.resources![0]!.revision,
        bytes: Buffer.byteLength(resource.text),
        sha256: createHash('sha256').update(resource.text).digest('hex'),
      });
      expect(Number.isFinite(Date.parse(resource.provenance.readAt))).toBe(true);
      const prompt = await connection.getPrompt(promptOptions(connection));
      expect(prompt.text).toBe(
        '[user]\nReview this code.\n\n[assistant]\nCheck behavior and tests.',
      );
      expect(prompt.messages).toEqual([
        { role: 'user', text: 'Review this code.' },
        { role: 'assistant', text: 'Check behavior and tests.' },
      ]);
      const dynamic = await connection.readResourceTemplate(templateOptions(connection));
      expect(dynamic).toMatchObject({
        kind: 'resource_template',
        provenance: {
          entryKey: 'fixture://guide/{name}',
          resolvedUri: 'fixture://guide/setup%20notes',
        },
      });
      expect(dynamic.text).toContain('fixture://guide/setup%20notes');
      expect(
        server.requests
          .filter((req) => req.method === 'resources/read')
          .map((req) => req.params?.uri),
      ).toEqual(['fixture://guide', 'fixture://guide/setup%20notes']);
      expect(
        server.requests
          .filter((req) => req.method === 'prompts/get')
          .map((req) => req.params?.arguments),
      ).toEqual([{ code: 'x()' }]);
      expect(
        server.requests.every(
          (req) => !/sampling|elicitation|subscribe|completion/.test(req.method),
        ),
      ).toBe(true);
    },
  );
  it('keeps old tool-only registrations stable until explicit reinspection', async () => {
    const server = await fixture();
    server.state.capabilities = { tools: {} };
    const original = await server.connect();
    expect(original.registration.resources).toBeUndefined();
    expect(original.registration.prompts).toBeUndefined();
    server.state.capabilities = { tools: {}, resources: {}, prompts: {} };
    const restored = await server.connect({ expected: original.registration });
    expect(restored.registration.revision).toBe(original.registration.revision);
    expect(restored.registration.resources).toBeUndefined();
    expect(server.requests.some((req) => req.method === 'resources/list')).toBe(false);
    const inspected = await server.connect();
    expect(inspected.registration.revision).not.toBe(original.registration.revision);
    expect(inspected.registration.resources).toHaveLength(1);
  });
  it('includes empty declared catalogs in a fresh registration revision', async () => {
    const server = await fixture();
    server.state.resources = [];
    server.state.resourceTemplates = [];
    server.state.prompts = [];
    const content = await server.connect();
    server.state.capabilities = {};
    const empty = await server.connect();
    expect(content.registration.resources).toEqual([]);
    expect(content.registration.prompts).toEqual([]);
    expect(content.registration.revision).not.toBe(empty.registration.revision);
  });
  it('rejects stale server/entry revisions and invalid prompt arguments before requests', async () => {
    const server = await fixture(),
      connection = await server.connect(),
      before = server.requests.length;
    await expect(
      connection.readResource({ ...resourceOptions(connection), serverRevision: 'stale' }),
    ).rejects.toMatchObject({ code: 'MCP_CATALOG_CHANGED' });
    await expect(
      connection.readResource({ ...resourceOptions(connection), revision: 'stale' }),
    ).rejects.toMatchObject({ code: 'MCP_RESOURCE' });
    await expect(
      connection.readResource({ ...resourceOptions(connection), uri: 'file:///etc/passwd' }),
    ).rejects.toMatchObject({ code: 'MCP_RESOURCE' });
    await expect(
      connection.getPrompt({ ...promptOptions(connection), arguments: {} }),
    ).rejects.toMatchObject({ code: 'MCP_ARGUMENTS' });
    await expect(
      connection.getPrompt({
        ...promptOptions(connection),
        arguments: { code: 'a', unknown: 'b' },
      }),
    ).rejects.toMatchObject({ code: 'MCP_ARGUMENTS' });
    expect(server.requests).toHaveLength(before);
  });
  it.each(['resource', 'prompt'] as const)(
    'rejects silent %s catalog changes before reading contents',
    async (kind) => {
      const server = await fixture(),
        connection = await server.connect();
      if (kind === 'resource') server.state.resources[0]!.description = 'Changed';
      else server.state.prompts[0]!.description = 'Changed';
      await expect(
        kind === 'resource'
          ? connection.readResource(resourceOptions(connection))
          : connection.getPrompt(promptOptions(connection)),
      ).rejects.toMatchObject({ code: 'MCP_CATALOG_CHANGED' });
      expect(
        server.requests.some((req) => ['resources/read', 'prompts/get'].includes(req.method)),
      ).toBe(false);
    },
  );
  it.each(['resource', 'prompt'] as const)(
    'discards %s contents when a list-change notification arrives during the read',
    async (kind) => {
      const server = await fixture(),
        connection = await server.connect();
      server.state.notify =
        kind === 'resource'
          ? 'notifications/resources/list_changed'
          : 'notifications/prompts/list_changed';
      await expect(
        kind === 'resource'
          ? connection.readResource(resourceOptions(connection))
          : connection.getPrompt(promptOptions(connection)),
      ).rejects.toMatchObject({ code: 'MCP_CATALOG_CHANGED' });
    },
  );
  it.each([
    { uri: 'fixture://guide', blob: 'YWJj', mimeType: 'application/octet-stream' },
    { uri: 'https://external.example/linked', text: 'Do not follow me' },
    { uri: 'fixture://guide', text: 'binary-looking', mimeType: 'image/png' },
  ])('rejects binary or unselected resource contents %#', async (content) => {
    const server = await fixture(),
      connection = await server.connect();
    server.state.contents = [content];
    await expect(connection.readResource(resourceOptions(connection))).rejects.toMatchObject({
      code: 'MCP_CONTENT',
    });
    expect(server.requests.filter((req) => req.method === 'resources/read')).toHaveLength(1);
  });
  it.each([
    { type: 'image', data: 'YWJj', mimeType: 'image/png' },
    {
      type: 'resource',
      resource: { uri: 'https://external.example/linked', text: 'embedded text' },
    },
    { type: 'resource_link', uri: 'https://external.example/linked', name: 'link' },
  ])('does not attach or follow non-text prompt blocks %#', async (content) => {
    const server = await fixture(),
      connection = await server.connect();
    server.state.messages = [{ role: 'user', content }];
    await expect(connection.getPrompt(promptOptions(connection))).rejects.toThrow();
    expect(server.requests.filter((req) => req.method === 'prompts/get')).toHaveLength(1);
    expect(server.requests.some((req) => req.method === 'resources/read')).toBe(false);
  });
  it('marks binary resource metadata and duplicate prompt arguments unsupported', async () => {
    const server = await fixture();
    server.state.resources[0]!.mimeType = 'application/pdf';
    server.state.prompts[0]!.arguments.push({ name: 'code', required: false });
    const connection = await server.connect();
    expect(connection.registration.resources![0]!.supported).toBe(false);
    expect(connection.registration.prompts![0]!.supported).toBe(false);
    const count = server.requests.length;
    await expect(connection.readResource(resourceOptions(connection))).rejects.toMatchObject({
      code: 'MCP_RESOURCE',
    });
    await expect(connection.getPrompt(promptOptions(connection))).rejects.toMatchObject({
      code: 'MCP_PROMPT',
    });
    expect(server.requests).toHaveLength(count);
  });
  it('redacts configured secrets before hashing and measuring attachments', async () => {
    const server = await fixture(),
      secret = 'fixture-secret-value';
    server.state.contents = [{ uri: 'fixture://guide', text: `token=${secret}` }];
    server.state.messages = [{ role: 'user', content: { type: 'text', text: `token=${secret}` } }];
    const connection = await server.connect({
      config: validateConfig({
        ...server.config,
        headers: { Authorization: { secretRef: 'LODEX_MCP_FIXTURE', prefix: 'Bearer ' } },
      }),
      resolveSecret: async () => secret,
    });
    const resource = await connection.readResource(resourceOptions(connection)),
      prompt = await connection.getPrompt(promptOptions(connection));
    expect(resource.text).toBe('token=[redacted]');
    expect(resource.provenance.bytes).toBe(Buffer.byteLength(resource.text));
    expect(
      JSON.stringify({ resource, prompt, registration: connection.registration }),
    ).not.toContain(secret);
  });
  it('bounds content without truncation and validates caller limits', async () => {
    const server = await fixture(),
      connection = await server.connect();
    server.state.contents = [{ uri: 'fixture://guide', text: '가'.repeat(10000) }];
    await expect(connection.readResource(resourceOptions(connection))).rejects.toMatchObject({
      code: 'MCP_SIZE',
    });
    await expect(
      connection.getPrompt({ ...promptOptions(connection), maxBytes: 5 }),
    ).rejects.toMatchObject({ code: 'MCP_SIZE' });
    const count = server.requests.length;
    await expect(
      connection.getPrompt({ ...promptOptions(connection), maxBytes: Infinity }),
    ).rejects.toMatchObject({ code: 'MCP_SIZE' });
    expect(server.requests).toHaveLength(count);
  });
  it('cancels a pending read without retrying or returning partial contents', async () => {
    const server = await fixture(),
      connection = await server.connect(),
      abort = new AbortController();
    server.state.pause = 'resources/read';
    const pending = connection.readResource({
      ...resourceOptions(connection),
      signal: abort.signal,
    });
    const assertion = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await expect
      .poll(() => server.requests.some((req) => req.method === 'resources/read'))
      .toBe(true);
    abort.abort();
    await assertion;
    expect(server.requests.filter((req) => req.method === 'resources/read')).toHaveLength(1);
  });
  it('does not fulfill additional input requests or automatically retry content requests', async () => {
    const server = await fixture(true),
      connection = await server.connect();
    server.state.inputRequired = true;
    await expect(connection.readResource(resourceOptions(connection))).rejects.toThrow();
    expect(server.requests.filter((req) => req.method === 'resources/read')).toHaveLength(1);
  });
  it('rejects oversized catalogs during inspection', async () => {
    const server = await fixture();
    server.state.resources = Array.from({ length: 129 }, (_, index) => ({
      ...server.state.resources[0]!,
      uri: `fixture://${index}`,
    }));
    await expect(server.connect()).rejects.toMatchObject({ code: 'MCP_CATALOG' });
  });
});
