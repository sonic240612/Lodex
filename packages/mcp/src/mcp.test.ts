import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type ServerResponse } from 'node:http';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { McpConnection, definitionForModel, validateConfig, type McpConfig } from './index';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
const tool = {
  name: 'read_file',
  description: 'Fixture echo',
  inputSchema: {
    type: 'object' as const,
    properties: { text: { type: 'string' } },
    required: ['text'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true },
};
const supervisorPath = resolve('apps/daemon/dist/mcp-supervisor.cjs');
async function connect(
  config: McpConfig,
  more: Partial<Parameters<typeof McpConnection.connect>[0]> = {},
) {
  const connection = await McpConnection.connect({
    config,
    supervisorPath,
    resolveSecret: async () => null,
    signal: AbortSignal.timeout(10000),
    ...more,
  });
  cleanup.push(() => connection.close());
  return connection;
}
async function directory() {
  const dir = await mkdtemp(join(tmpdir(), 'lodex-mcp 한글-'));
  cleanup.push(async () => {
    if (dirname(resolve(dir)) !== resolve(tmpdir())) throw new Error('Unsafe fixture path');
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}
function answer(
  request: {
    method: string;
    params?: {
      arguments?: { text?: string };
      inputResponses?: Record<string, unknown>;
      requestState?: string;
    };
  },
  modern: boolean,
) {
  if (request.method === 'initialize')
    return {
      protocolVersion: '2025-11-25',
      capabilities: { tools: {} },
      serverInfo: { name: 'fixture', version: '1' },
    };
  if (request.method === 'server/discover')
    return modern
      ? {
          supportedVersions: ['2026-07-28'],
          capabilities: { tools: {} },
          _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'fixture', version: '1' } },
        }
      : undefined;
  if (request.method === 'tools/list') return { tools: [tool] };
  if (request.method === 'tools/call')
    return { content: [{ type: 'text', text: request.params?.arguments?.text ?? '' }] };
  return {};
}
async function httpFixture(
  options: {
    modern?: boolean;
    sse?: boolean;
    drop?: boolean;
    redirect?: string;
    requireKey?: string;
    changed?: boolean;
    inputRequiredSampling?: boolean;
    inputRequiredElicitation?: boolean;
  } = {},
) {
  const requests: {
    method: string;
    params?: {
      arguments?: { text?: string };
      inputResponses?: Record<string, unknown>;
      requestState?: string;
    };
  }[] = [];
  const server = createServer(async (req, res) => {
    if (options.requireKey && req.headers.authorization !== 'Bearer ' + options.requireKey) {
      res.writeHead(401);
      res.end();
      return;
    }
    if (options.redirect) {
      res.writeHead(307, { Location: options.redirect });
      res.end();
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405);
      res.end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const message = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    requests.push(message);
    if (message.id === undefined) {
      res.writeHead(202);
      res.end();
      return;
    }
    if (options.drop && message.method === 'tools/call') {
      req.socket.destroy();
      return;
    }
    let result: Record<string, unknown> | undefined = answer(message, !!options.modern);
    if (options.modern && options.inputRequiredSampling && message.method === 'tools/call') {
      const sampled = message.params?.inputResponses?.sample as
        { content?: { type?: string; text?: string } } | undefined;
      result = sampled
        ? { content: [{ type: 'text', text: sampled.content?.text ?? '' }] }
        : {
            resultType: 'input_required',
            inputRequests: {
              sample: {
                method: 'sampling/createMessage',
                params: {
                  messages: [
                    { role: 'user', content: { type: 'text', text: 'Modern sampling fixture' } },
                  ],
                  maxTokens: 24,
                  includeContext: 'none',
                },
              },
            },
            requestState: 'opaque-fixture-state',
          };
    }
    if (options.modern && options.inputRequiredElicitation && message.method === 'tools/call') {
      const elicited = message.params?.inputResponses?.form as
        { action?: string; content?: Record<string, unknown> } | undefined;
      result = elicited
        ? { content: [{ type: 'text', text: String(elicited.content?.name ?? '') }] }
        : {
            resultType: 'input_required',
            inputRequests: {
              form: {
                method: 'elicitation/create',
                params: {
                  mode: 'form',
                  message: 'Choose a fixture name',
                  requestedSchema: {
                    type: 'object',
                    properties: { name: { type: 'string', title: 'Name' } },
                    required: ['name'],
                  },
                },
              },
            },
            requestState: 'opaque-elicitation-state',
          };
    }
    if (options.changed && message.method === 'tools/list')
      result = { tools: [{ ...tool, description: 'changed' }] };
    if (options.modern && result && !('resultType' in result))
      Object.assign(result, { resultType: 'complete' });
    if (options.modern && message.method === 'tools/list' && result)
      Object.assign(result, { ttlMs: 0, cacheScope: 'private' });
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: message.id,
      ...(result === undefined
        ? { error: { code: -32601, message: 'Unknown method' } }
        : { result }),
    });
    res.writeHead(200, { 'Content-Type': options.sse ? 'text/event-stream' : 'application/json' });
    res.end(options.sse ? 'data: ' + body + '\n\n' : body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  );
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No port');
  return {
    requests,
    options,
    config: validateConfig({
      name: 'HTTP fixture',
      transport: 'http',
      url: 'http://127.0.0.1:' + address.port + '/mcp',
      protocol: 'auto',
    }),
  };
}

async function legacySseFixture() {
  const requests: {
      method: string;
      id?: string | number;
      params?: { arguments?: { text?: string } };
    }[] = [],
    streams = new Set<ServerResponse>();
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      streams.add(res);
      req.once('close', () => streams.delete(res));
      res.write('event: endpoint\ndata: /messages\n\n');
      return;
    }
    if (req.method !== 'POST' || url.pathname !== '/messages') {
      res.writeHead(404);
      res.end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const message = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    requests.push(message);
    res.writeHead(202);
    res.end();
    if (message.id === undefined) return;
    const result = answer(message, false);
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: message.id,
      ...(result === undefined
        ? { error: { code: -32601, message: 'Unknown method' } }
        : { result }),
    });
    for (const stream of streams) stream.write('data: ' + body + '\n\n');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(
    () =>
      new Promise<void>((resolve) => {
        for (const stream of streams) stream.end();
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  );
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No port');
  return {
    requests,
    config: validateConfig({
      name: 'Legacy SSE fixture',
      transport: 'sse',
      url: 'http://127.0.0.1:' + address.port + '/events',
      protocol: 'legacy',
    }),
  };
}
describe('MCP protocol boundary', () => {
  it('fulfills a legacy form elicitation without persisting or changing its values', async () => {
    const dir = await directory(),
      script = join(dir, 'elicitation-server.cjs'),
      received = join(dir, 'elicitation.json');
    await writeFile(
      script,
      `const readline=require('node:readline'),fs=require('node:fs');const tool=${JSON.stringify(tool)};let pending;
const lines=readline.createInterface({input:process.stdin});lines.on('line',line=>{const m=JSON.parse(line);
if(m.id===89&&!m.method){fs.writeFileSync(${JSON.stringify(received)},JSON.stringify(m.result));process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:pending.id,result:{content:[{type:'text',text:m.result.content.name}]}})+'\\n');return;}
if(m.id===undefined)return;
if(m.method==='initialize'){process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'elicitation fixture',version:'1'}}})+'\\n');return;}
if(m.method==='tools/list'){process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{tools:[tool]}})+'\\n');return;}
if(m.method==='tools/call'){pending=m;process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:89,method:'elicitation/create',params:{mode:'form',message:'Enter a name',requestedSchema:{type:'object',properties:{name:{type:'string',title:'Name'}},required:['name']}}})+'\\n');return;}
});`,
    );
    const connection = await connect(
      validateConfig({
        name: 'elicitation fixture',
        transport: 'stdio',
        executable: process.execPath,
        args: [script],
        cwd: dir,
        protocol: 'legacy',
      }),
      { elicitation: async () => ({ action: 'accept', content: { name: 'Lodex' } }) },
    );
    const selected = connection.registration.tools[0]!;
    await expect(
      connection.call({
        name: selected.name,
        revision: selected.revision,
        arguments: { text: 'run' },
        mode: 'build',
        signal: AbortSignal.timeout(3000),
      }),
    ).resolves.toMatchObject({ content: [{ type: 'text', text: 'Lodex' }] });
    await expect
      .poll(async () => JSON.parse(await readFile(received, 'utf8')))
      .toEqual({
        action: 'accept',
        content: { name: 'Lodex' },
      });
  });
  it('fulfills an isolated legacy sampling request during a tool call', async () => {
    const dir = await directory(),
      script = join(dir, 'sampling-server.cjs'),
      received = join(dir, 'sampling.json');
    await writeFile(
      script,
      `const readline=require('node:readline'),fs=require('node:fs');const tool=${JSON.stringify(tool)};let pending;
const lines=readline.createInterface({input:process.stdin});lines.on('line',line=>{const m=JSON.parse(line);
if(m.id===88&&!m.method){fs.writeFileSync(${JSON.stringify(received)},JSON.stringify(m.result));process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:pending.id,result:{content:[{type:'text',text:m.result.content.text}]}})+'\\n');return;}
if(m.id===undefined)return;
if(m.method==='initialize'){process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'sampling fixture',version:'1'}}})+'\\n');return;}
if(m.method==='tools/list'){process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{tools:[tool]}})+'\\n');return;}
if(m.method==='tools/call'){pending=m;process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:88,method:'sampling/createMessage',params:{messages:[{role:'user',content:{type:'text',text:'Summarize this fixture'}}],maxTokens:32,includeContext:'none'}})+'\\n');return;}
});`,
    );
    const seen: unknown[] = [];
    const connection = await connect(
      validateConfig({
        name: 'sampling fixture',
        transport: 'stdio',
        executable: process.execPath,
        args: [script],
        cwd: dir,
        protocol: 'legacy',
      }),
      {
        sampling: async (params) => {
          seen.push(params);
          return {
            model: 'fixture-model',
            role: 'assistant',
            content: { type: 'text', text: 'sampled safely' },
            stopReason: 'endTurn',
          };
        },
      },
    );
    const selected = connection.registration.tools[0]!;
    await expect(
      connection.call({
        name: selected.name,
        revision: selected.revision,
        arguments: { text: 'run' },
        mode: 'build',
        signal: AbortSignal.timeout(3000),
      }),
    ).resolves.toMatchObject({ content: [{ type: 'text', text: 'sampled safely' }] });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      messages: [{ role: 'user', content: { type: 'text', text: 'Summarize this fixture' } }],
      maxTokens: 32,
      includeContext: 'none',
    });
    await expect
      .poll(async () => JSON.parse(await readFile(received, 'utf8')))
      .toMatchObject({
        model: 'fixture-model',
        content: { type: 'text', text: 'sampled safely' },
      });
  });
  it('fulfills modern input_required sampling and retries with the exact response and state', async () => {
    const server = await httpFixture({ modern: true, sse: true, inputRequiredSampling: true });
    const connection = await connect(server.config, {
      sampling: async () => ({
        model: 'fixture-modern',
        role: 'assistant',
        content: { type: 'text', text: 'modern sampled safely' },
        stopReason: 'endTurn',
      }),
    });
    const selected = connection.registration.tools[0]!;
    await expect(
      connection.call({
        name: selected.name,
        revision: selected.revision,
        arguments: { text: 'run modern' },
        mode: 'build',
        signal: AbortSignal.timeout(3000),
      }),
    ).resolves.toMatchObject({
      content: [{ type: 'text', text: 'modern sampled safely' }],
    });
    const calls = server.requests.filter((request) => request.method === 'tools/call');
    expect(calls).toHaveLength(2);
    expect(calls[1]?.params).toMatchObject({
      requestState: 'opaque-fixture-state',
      inputResponses: {
        sample: {
          model: 'fixture-modern',
          content: { type: 'text', text: 'modern sampled safely' },
        },
      },
    });
  });
  it('fulfills modern input_required elicitation and preserves request state', async () => {
    const server = await httpFixture({ modern: true, sse: true, inputRequiredElicitation: true });
    const connection = await connect(server.config, {
      elicitation: async () => ({ action: 'accept', content: { name: 'Modern Lodex' } }),
    });
    const selected = connection.registration.tools[0]!;
    await expect(
      connection.call({
        name: selected.name,
        revision: selected.revision,
        arguments: { text: 'run modern' },
        mode: 'build',
        signal: AbortSignal.timeout(3000),
      }),
    ).resolves.toMatchObject({ content: [{ type: 'text', text: 'Modern Lodex' }] });
    const calls = server.requests.filter((request) => request.method === 'tools/call');
    expect(calls).toHaveLength(2);
    expect(calls[1]?.params).toMatchObject({
      requestState: 'opaque-elicitation-state',
      inputResponses: { form: { action: 'accept', content: { name: 'Modern Lodex' } } },
    });
  });
  it('advertises and returns only the explicitly selected project root', async () => {
    const dir = await directory(),
      script = join(dir, 'roots-server.cjs'),
      received = join(dir, 'roots.json');
    await writeFile(
      script,
      `const readline=require('node:readline'),fs=require('node:fs');const tool=${JSON.stringify(tool)};let pending;
const lines=readline.createInterface({input:process.stdin});lines.on('line',line=>{const m=JSON.parse(line);
if(m.id===77){fs.writeFileSync(${JSON.stringify(received)},JSON.stringify(m.result));process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:pending.id,result:{tools:[tool]}})+'\\n');return;}
if(m.id===undefined)return;
if(m.method==='initialize'){process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'roots fixture',version:'1'}}})+'\\n');return;}
if(m.method==='tools/list'){pending=m;process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:77,method:'roots/list',params:{}})+'\\n');return;}
});`,
    );
    const root = { uri: pathToFileURL(dir).href, name: 'Fixture project' };
    const connection = await connect(
      validateConfig({
        name: 'roots fixture',
        transport: 'stdio',
        executable: process.execPath,
        args: [script],
        cwd: dir,
        protocol: 'legacy',
      }),
      { roots: [root] },
    );
    expect(connection.registration.tools).toHaveLength(1);
    await expect
      .poll(async () => JSON.parse(await readFile(received, 'utf8')))
      .toEqual({ roots: [root] });
  });
  it('rejects non-file roots before opening an MCP transport', async () => {
    const server = await httpFixture();
    await expect(
      connect(server.config, { roots: [{ uri: 'https://example.com/project' }] }),
    ).rejects.toMatchObject({ code: 'MCP_ROOTS' });
    expect(server.requests).toEqual([]);
  });
  it.each([false, true])(
    'connects a real stdio child with modern=%s, pins schemas and blocks Plan calls',
    async (modern) => {
      const dir = await directory(),
        script = join(dir, 'server.cjs'),
        received = join(dir, 'received.jsonl');
      await writeFile(
        script,
        `const readline=require('node:readline'),fs=require('node:fs');const tool=${JSON.stringify(tool)};
const lines=readline.createInterface({input:process.stdin}); lines.on('line',line=>{const m=JSON.parse(line);fs.appendFileSync(${JSON.stringify(received)},line+'\\n');if(m.id===undefined)return;
let result=m.method==='initialize'?{protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}}:m.method==='server/discover'?{supportedVersions:['2026-07-28'],capabilities:{tools:{}}}:m.method==='tools/list'?{tools:[tool]}:{content:[{type:'text',text:m.params.arguments.text}]};
if(${modern}){result.resultType='complete';if(m.method==='tools/list'){result.ttlMs=0;result.cacheScope='private';}} process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');}); lines.on('close',()=>process.exit(0));`,
      );
      const connection = await connect(
        validateConfig({
          name: 'stdio fixture',
          transport: 'stdio',
          executable: process.execPath,
          args: [script],
          cwd: dir,
          protocol: modern ? '2026-07-28' : 'legacy',
        }),
      );
      expect(connection.registration.protocol).toBe(modern ? '2026-07-28' : '2025-11-25');
      const selected = connection.registration.tools[0]!;
      expect(definitionForModel(connection.registration, selected).function.name).not.toBe(
        tool.name,
      );
      await expect(
        connection.call({
          name: tool.name,
          revision: selected.revision,
          arguments: { text: 'hello' },
          mode: 'plan',
          signal: AbortSignal.timeout(2000),
        }),
      ).rejects.toMatchObject({ code: 'MCP_PLAN' });
      await expect(
        connection.call({
          name: tool.name,
          revision: selected.revision,
          arguments: { text: 2 },
          mode: 'build',
          signal: AbortSignal.timeout(2000),
        }),
      ).rejects.toMatchObject({ code: 'MCP_ARGUMENTS' });
      const result = await connection.call({
        name: tool.name,
        revision: selected.revision,
        arguments: { text: 'hello' },
        mode: 'build',
        signal: AbortSignal.timeout(2000),
      });
      expect(result.content).toEqual([{ type: 'text', text: 'hello' }]);
      await connection.close();
      expect(
        (await readFile(received, 'utf8'))
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line))
          .filter((r) => r.method === 'tools/call'),
      ).toHaveLength(1);
    },
  );
  it.each([
    { modern: false, sse: false },
    { modern: true, sse: true },
  ])('negotiates HTTP $modern with SSE=$sse and checks pinned definitions', async (options) => {
    const server = await httpFixture(options),
      connection = await connect(server.config);
    const chosen = connection.registration.tools[0]!;
    expect(
      (
        await connection.call({
          name: chosen.name,
          revision: chosen.revision,
          arguments: { text: 'over HTTP' },
          mode: 'build',
          signal: AbortSignal.timeout(2000),
        })
      ).content,
    ).toEqual([{ type: 'text', text: 'over HTTP' }]);
    server.options.changed = true;
    await expect(
      connect(server.config, { expected: connection.registration }),
    ).rejects.toMatchObject({ code: 'MCP_CATALOG_CHANGED' });
  });
  it('connects to legacy SSE servers and uses only their same-origin message endpoint', async () => {
    const server = await legacySseFixture(),
      connection = await connect(server.config),
      chosen = connection.registration.tools[0]!;
    expect(connection.registration.protocol).toBe('2025-11-25');
    expect(
      (
        await connection.call({
          name: chosen.name,
          revision: chosen.revision,
          arguments: { text: 'over legacy SSE' },
          mode: 'build',
          signal: AbortSignal.timeout(2000),
        })
      ).content,
    ).toEqual([{ type: 'text', text: 'over legacy SSE' }]);
    expect(server.requests.filter((request) => request.method === 'tools/call')).toHaveLength(1);
  });
  it('resolves only explicit secret references and never follows redirects with credentials', async () => {
    const secret = 'fixture-only-secret',
      target = await httpFixture();
    const server = await httpFixture({ requireKey: secret });
    const config = validateConfig({
      ...server.config,
      headers: { Authorization: { secretRef: 'LODEX_MCP_FIXTURE', prefix: 'Bearer ' } },
    });
    const names: string[] = [];
    const connection = await connect(config, {
      resolveSecret: async (name) => {
        names.push(name);
        return secret;
      },
    });
    expect(names).toEqual(['LODEX_MCP_FIXTURE']);
    expect(JSON.stringify(connection.registration)).not.toContain(secret);
    const chosen = connection.registration.tools[0]!;
    expect(
      JSON.stringify(
        await connection.call({
          name: chosen.name,
          revision: chosen.revision,
          arguments: { text: secret },
          mode: 'build',
          signal: AbortSignal.timeout(2000),
        }),
      ),
    ).not.toContain(secret);
    server.options.redirect = target.config.transport === 'http' ? target.config.url : '';
    await expect(connect(config, { resolveSecret: async () => secret })).rejects.toThrow();
    expect(target.requests).toHaveLength(0);
  });
  it('does not connect when cancelled while resolving a credential', async () => {
    const server = await httpFixture(),
      controller = new AbortController();
    const config = validateConfig({
      ...server.config,
      headers: { Authorization: { secretRef: 'LODEX_MCP_FIXTURE' } },
    });
    await expect(
      connect(config, {
        signal: controller.signal,
        resolveSecret: async () => {
          controller.abort();
          return 'fixture-secret';
        },
      }),
    ).rejects.toThrow();
    expect(server.requests).toHaveLength(0);
  });
  it('treats a disconnected tool result as unknown and does not retry the call', async () => {
    const server = await httpFixture({ drop: true }),
      connection = await connect(server.config),
      chosen = connection.registration.tools[0]!;
    await expect(
      connection.call({
        name: chosen.name,
        revision: chosen.revision,
        arguments: { text: 'once' },
        mode: 'build',
        signal: AbortSignal.timeout(2000),
      }),
    ).rejects.toMatchObject({ code: 'MCP_OUTCOME_UNKNOWN' });
    expect(server.requests.filter((request) => request.method === 'tools/call')).toHaveLength(1);
  });
  it('rejects inline credentials, launcher injection variables and ambiguous stdio probing', () => {
    expect(() =>
      validateConfig({
        name: 'bad',
        transport: 'http',
        url: 'https://user:secret@example.com/mcp',
      }),
    ).toThrow();
    expect(() =>
      validateConfig({
        name: 'bad',
        transport: 'http',
        url: 'https://example.com/mcp',
        headers: { Authorization: 'Bearer inline-key' },
      }),
    ).toThrow();
    expect(() =>
      validateConfig({
        name: 'bad',
        transport: 'stdio',
        executable: process.execPath,
        args: [],
        cwd: process.cwd(),
        env: { NODE_OPTIONS: { secretRef: 'LODEX_MCP_INJECTION' } },
      }),
    ).toThrow();
    expect(() =>
      validateConfig({
        name: 'bad',
        transport: 'stdio',
        executable: process.execPath,
        args: [],
        cwd: process.cwd(),
        protocol: 'auto',
      }),
    ).toThrow();
  });
});
