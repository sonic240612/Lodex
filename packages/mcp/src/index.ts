import { createHash, randomUUID } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import {
  Client,
  StreamableHTTPClientTransport,
  type Tool,
  type Transport,
  type JsonSchemaType,
  type jsonSchemaValidator,
} from '@modelcontextprotocol/client';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/client/validators/ajv';
import { AppError, localUrlSchema, type ToolDefinition } from '@lodex/contracts';
import { privateServerFetch } from '@lodex/providers';
import { OwnedStdioTransport } from './stdio';
import { validateConfig, resolveReferences, type McpConfig, type SecretResolver } from './config';
export { validateConfig, mcpConfigSchema } from './config';
export type { McpConfig, SecretResolver } from './config';
export { importMcpConfigurations, type McpImport } from './import';

export interface McpTool {
  name: string;
  revision: string;
  definition: Tool;
  supported: boolean;
  issue?: string;
}
export interface McpRegistration {
  id: string;
  revision: string;
  config: McpConfig;
  executableIdentity?: string;
  server: { name: string; version: string } | null;
  protocol: string | null;
  tools: McpTool[];
  inspectedAt: string;
}
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const mcpToolName = (id: string, name: string) => 'mcp_' + hash([id, name]).slice(0, 40);
export function definitionForModel(registration: McpRegistration, tool: McpTool): ToolDefinition {
  if (!tool.supported)
    throw new AppError('MCP_SCHEMA', tool.issue ?? '지원하지 않는 MCP 스키마입니다.');
  return {
    type: 'function',
    function: {
      name: mcpToolName(registration.id, tool.name),
      description: `[MCP: ${registration.config.name}] ${tool.definition.description ?? tool.name}`,
      parameters: tool.definition.inputSchema as Record<string, unknown>,
    },
  };
}
function boundedShape(value: unknown, byteLimit: number) {
  if (Buffer.byteLength(JSON.stringify(value)) > byteLimit)
    throw new AppError('MCP_SIZE', 'MCP 데이터 크기 제한을 초과했습니다.');
  let count = 0;
  const walk = (value: unknown, depth: number) => {
    if (++count > 4096 || depth > 24)
      throw new AppError('MCP_COMPLEXITY', 'MCP 데이터 구조 제한을 초과했습니다.');
    if (value && typeof value === 'object')
      for (const entry of Object.values(value)) walk(entry, depth + 1);
  };
  walk(value, 0);
}
function schemaSafety(schema: JsonSchemaType) {
  boundedShape(schema, 32768);
  const walk = (value: unknown) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    const node = value as Record<string, unknown>;
    if (
      ['$ref', '$dynamicRef', 'pattern', 'patternProperties', 'format'].some((key) => key in node)
    )
      throw new AppError(
        'MCP_SCHEMA',
        '참조·정규식·format 검증이 필요한 스키마는 아직 지원하지 않습니다.',
      );
    for (const [key, child] of Object.entries(node)) {
      if (
        ['properties', '$defs', 'definitions', 'dependentSchemas'].includes(key) &&
        child &&
        typeof child === 'object'
      )
        Object.values(child).forEach(walk);
      else if (['allOf', 'anyOf', 'oneOf', 'prefixItems'].includes(key) && Array.isArray(child))
        child.forEach(walk);
      else if (
        [
          'items',
          'additionalProperties',
          'contains',
          'not',
          'if',
          'then',
          'else',
          'propertyNames',
          'unevaluatedProperties',
          'unevaluatedItems',
        ].includes(key)
      )
        walk(child);
    }
  };
  walk(schema);
}
function validators(): jsonSchemaValidator {
  const ajv = new AjvJsonSchemaValidator();
  return {
    getValidator<T>(schema: JsonSchemaType) {
      schemaSafety(schema);
      return ajv.getValidator<T>(schema);
    },
  };
}
async function executableIdentity(config: McpConfig): Promise<string | undefined> {
  if (config.transport !== 'stdio') return undefined;
  const path = await realpath(config.executable),
    info = await lstat(path);
  if (!info.isFile()) throw new AppError('MCP_EXECUTABLE', 'MCP 실행 파일이 일반 파일이 아닙니다.');
  const cwd = await lstat(await realpath(config.cwd));
  if (!cwd.isDirectory()) throw new AppError('MCP_CWD', 'MCP 작업 폴더를 찾을 수 없습니다.');
  return `${path}:${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}`;
}
function redact<T>(value: T, secrets: string[]): T {
  let text = JSON.stringify(value);
  for (const secret of secrets)
    text = text.replaceAll(JSON.stringify(secret).slice(1, -1), '[redacted]');
  return JSON.parse(text) as T;
}
function endpointFetch(endpoint: string, signal: AbortSignal) {
  const expected = new URL(endpoint).href;
  const fetcher = localUrlSchema.safeParse(endpoint).success ? privateServerFetch : fetch;
  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (new URL(url).href !== expected)
      throw new AppError('MCP_ENDPOINT', '등록한 MCP endpoint 외부로는 요청하지 않습니다.');
    const response = await fetcher(url, {
      ...init,
      redirect: 'error',
      signal: AbortSignal.any([
        signal,
        ...(init?.signal ? [init.signal] : []),
        AbortSignal.timeout(30000),
      ]),
    });
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel();
      throw new AppError('MCP_AUTH', 'MCP 인증이 필요합니다. .env의 참조 값을 확인하세요.');
    }
    if (!response.body) return response;
    const reader = response.body.getReader();
    let bytes = 0;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const chunk = await reader.read();
          if (chunk.done) {
            controller.close();
            return;
          }
          bytes += chunk.value.byteLength;
          if (bytes > 1048576) {
            await reader.cancel();
            controller.error(new AppError('MCP_OUTPUT_LIMIT', 'MCP 응답이 1 MiB를 초과했습니다.'));
            return;
          }
          controller.enqueue(chunk.value);
        } catch (error) {
          controller.error(error);
        }
      },
      cancel: (reason) => reader.cancel(reason),
    });
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}
export class McpConnection {
  private closed = false;
  private invalidated = false;
  private validation = validators();
  private constructor(
    private client: Client,
    private transport: Transport,
    private secrets: string[],
    readonly registration: McpRegistration,
  ) {
    client.setNotificationHandler('notifications/tools/list_changed', () => {
      this.invalidated = true;
    });
  }
  static async connect(options: {
    config: McpConfig;
    supervisorPath: string;
    resolveSecret: SecretResolver;
    signal: AbortSignal;
    expected?: McpRegistration;
  }): Promise<McpConnection> {
    const config = validateConfig(options.config);
    options.signal.throwIfAborted();
    const identity = await executableIdentity(config);
    if (
      options.expected &&
      (hash(config) !== hash(options.expected.config) ||
        identity !== options.expected.executableIdentity)
    )
      throw new AppError(
        'MCP_CHANGED',
        'MCP 실행 설정 또는 파일이 등록 이후 변경되었습니다. 다시 연결 검사하세요.',
      );
    const { values, secrets } = await resolveReferences(config, options.resolveSecret);
    options.signal.throwIfAborted();
    const client = new Client(
      { name: 'lodex', version: '0.1.0' },
      {
        capabilities: {},
        enforceStrictCapabilities: true,
        listMaxPages: 8,
        inputRequired: { autoFulfill: false },
        jsonSchemaValidator: validators(),
        versionNegotiation: {
          mode: config.protocol === '2026-07-28' ? { pin: '2026-07-28' } : config.protocol,
          probe: { maxRetries: 0, timeoutMs: 10000 },
        },
      },
    );
    const transport: Transport =
      config.transport === 'stdio'
        ? new OwnedStdioTransport(config, values, options.supervisorPath)
        : new StreamableHTTPClientTransport(new URL(config.url), {
            fetch: endpointFetch(config.url, options.signal),
            requestInit: { headers: values },
            onInsufficientScope: 'throw',
            reconnectionOptions: {
              maxRetries: 0,
              initialReconnectionDelay: 1000,
              maxReconnectionDelay: 1000,
              reconnectionDelayGrowFactor: 1,
            },
          });
    const abort = () => {
      void transport.close().catch(() => undefined);
    };
    options.signal.addEventListener('abort', abort, { once: true });
    try {
      await client.connect(transport, { signal: options.signal, timeout: 15000 });
      const listed = client.getServerCapabilities()?.tools
        ? (
            await client.listTools(undefined, {
              signal: options.signal,
              timeout: 15000,
              cacheMode: 'bypass',
            })
          ).tools
        : [];
      boundedShape(listed, 131072);
      if (listed.length > 128 || new Set(listed.map((tool) => tool.name)).size !== listed.length)
        throw new AppError('MCP_CATALOG', 'MCP 도구 개수 제한 또는 중복 이름을 확인하세요.');
      const validator = validators();
      const tools: McpTool[] = listed.map((definition) => {
        let issue: string | undefined;
        try {
          validator.getValidator(definition.inputSchema as JsonSchemaType);
          if (definition.outputSchema)
            validator.getValidator(definition.outputSchema as JsonSchemaType);
        } catch {
          issue =
            '지원하지 않거나 잘못된 JSON Schema입니다. 참조·정규식·format 스키마는 아직 지원하지 않습니다.';
        }
        return {
          name: definition.name,
          definition: redact(definition, secrets),
          revision: hash(definition),
          supported: !issue,
          ...(issue ? { issue } : {}),
        };
      });
      const registration: McpRegistration = {
        id: options.expected?.id ?? randomUUID(),
        config,
        revision: hash({
          config,
          identity,
          tools: tools.map((tool) => [tool.name, tool.revision]),
        }),
        ...(identity ? { executableIdentity: identity } : {}),
        server: redact(client.getServerVersion() ?? null, secrets),
        protocol: client.getNegotiatedProtocolVersion() ?? null,
        tools,
        inspectedAt: new Date().toISOString(),
      };
      if (options.expected && registration.revision !== options.expected.revision)
        throw new AppError(
          'MCP_CATALOG_CHANGED',
          'MCP 도구 목록 또는 스키마가 변경되었습니다. 다시 검토하고 선택하세요.',
        );
      const connected = new McpConnection(client, transport, secrets, registration);
      connected.abortCleanup = () => options.signal.removeEventListener('abort', abort);
      return connected;
    } catch (error) {
      options.signal.removeEventListener('abort', abort);
      await transport.close();
      if (options.signal.aborted) options.signal.throwIfAborted();
      if (error instanceof AppError) throw error;
      throw new AppError(
        'MCP_CONNECTION',
        'MCP 서버 연결에 실패했습니다. 실행 설정·주소·프로토콜·인증을 확인하세요.',
      );
    }
  }
  private abortCleanup = () => {};
  async call(options: {
    name: string;
    revision: string;
    arguments: Record<string, unknown>;
    mode: 'plan' | 'build';
    signal: AbortSignal;
    maxBytes?: number;
  }) {
    if (options.mode !== 'build')
      throw new AppError('MCP_PLAN', 'Plan 모드에서는 MCP 도구를 실행하지 않습니다.', 403);
    if (this.closed || this.invalidated)
      throw new AppError('MCP_CATALOG_CHANGED', 'MCP 연결 또는 도구 목록이 변경되었습니다.');
    const tool = this.registration.tools.find(
      (tool) => tool.name === options.name && tool.revision === options.revision,
    );
    if (!tool?.supported)
      throw new AppError('MCP_TOOL', '등록 시 검토한 MCP 도구와 버전이 아닙니다.');
    boundedShape(options.arguments, 16384);
    if (
      !this.validation.getValidator(tool.definition.inputSchema as JsonSchemaType)(
        options.arguments,
      ).valid
    )
      throw new AppError('MCP_ARGUMENTS', 'MCP 도구 인자가 등록된 JSON Schema와 다릅니다.');
    options.signal.throwIfAborted();
    try {
      const result = await this.client.callTool(
        { name: tool.name, arguments: options.arguments },
        { signal: options.signal, timeout: 30000, toolDefinition: tool.definition },
      );
      const clean = redact(result, this.secrets);
      boundedShape(clean, options.maxBytes ?? 24576);
      return clean;
    } catch {
      // A request may already have changed external state. No transparent retry.
      throw new AppError(
        'MCP_OUTCOME_UNKNOWN',
        'MCP 호출 결과를 확인하지 못했습니다. 일부 작업이 실행됐을 수 있으므로 같은 호출을 자동으로 반복하지 마세요.',
      );
    }
  }
  async close() {
    this.closed = true;
    this.abortCleanup();
    await this.client.close();
    await this.transport.close();
  }
}
