import { createHash, randomUUID } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import {
  Client,
  StreamableHTTPClientTransport,
  UriTemplate,
  type Tool,
  type Resource,
  type ResourceTemplateType as ResourceTemplate,
  type Prompt,
  type Root,
  type CreateMessageRequestParams,
  type CreateMessageResult,
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
export type { Root } from '@modelcontextprotocol/client';
export type { CreateMessageRequestParams, CreateMessageResult } from '@modelcontextprotocol/client';
export { importMcpConfigurations, type McpImport } from './import';
export * from './oauth';

export interface McpTool {
  name: string;
  revision: string;
  definition: Tool;
  supported: boolean;
  issue?: string;
}
export interface McpResource {
  uri: string;
  name: string;
  revision: string;
  definition: Resource;
  supported: boolean;
  issue?: string;
}
export interface McpPrompt {
  name: string;
  revision: string;
  definition: Prompt;
  supported: boolean;
  issue?: string;
}
export interface McpResourceTemplate {
  uriTemplate: string;
  name: string;
  revision: string;
  definition: ResourceTemplate;
  variables: string[];
  supported: boolean;
  issue?: string;
}
export interface McpContent {
  kind: 'resource' | 'resource_template' | 'prompt';
  text: string;
  messages?: { role: 'user' | 'assistant'; text: string }[];
  provenance: {
    serverId: string;
    serverRevision: string;
    kind: 'resource' | 'resource_template' | 'prompt';
    entryKey: string;
    entryRevision: string;
    resolvedUri?: string;
    sha256: string;
    bytes: number;
    readAt: string;
  };
}
export interface McpRegistration {
  id: string;
  revision: string;
  config: McpConfig;
  executableIdentity?: string;
  server: { name: string; version: string } | null;
  protocol: string | null;
  tools: McpTool[];
  resources?: McpResource[];
  prompts?: McpPrompt[];
  resourceTemplates?: McpResourceTemplate[];
  supportsCompletions?: true;
  inspectedAt: string;
}
export interface McpCompletion {
  values: string[];
  total?: number;
  hasMore?: boolean;
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
function checkCatalog<T>(entries: T[], key: (entry: T) => string) {
  boundedShape(entries, 131072);
  if (entries.length > 128 || new Set(entries.map(key)).size !== entries.length)
    throw new AppError('MCP_CATALOG', 'MCP 목록 개수 제한 또는 중복 식별자를 확인하세요.');
}
function textMimeType(value?: string) {
  if (!value) return true;
  const mime = value.split(';', 1)[0]!.trim().toLowerCase();
  return (
    mime.startsWith('text/') ||
    [
      'application/json',
      'application/xml',
      'application/yaml',
      'application/x-yaml',
      'application/javascript',
      'application/sql',
    ].includes(mime) ||
    /^application\/[a-z0-9.+-]+\+(?:json|xml)$/.test(mime)
  );
}
function catalogKey(value: string) {
  return value.length > 0 && value.length <= 4096 && !/[\u0000-\u001f\u007f]/.test(value);
}
function safeRoots(input?: Root[]): Root[] {
  if (!input?.length) return [];
  boundedShape(input, 16384);
  if (input.length > 8)
    throw new AppError('MCP_ROOTS', 'MCP root는 최대 8개까지 제공할 수 있습니다.');
  const roots = input.map((root) => {
    let url: URL;
    try {
      url = new URL(root.uri);
    } catch {
      throw new AppError('MCP_ROOTS', 'MCP root 경로가 올바르지 않습니다.');
    }
    if (
      url.protocol !== 'file:' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (root.name !== undefined &&
        (root.name.length < 1 || root.name.length > 256 || /[\u0000-\u001f\u007f]/.test(root.name)))
    )
      throw new AppError('MCP_ROOTS', '로컬 파일 경로만 MCP root로 제공할 수 있습니다.');
    return { uri: url.href, ...(root.name ? { name: root.name } : {}) };
  });
  if (new Set(roots.map((root) => root.uri)).size !== roots.length)
    throw new AppError('MCP_ROOTS', '중복된 MCP root 경로입니다.');
  return roots;
}
function resourceCatalog(listed: Resource[], secrets: string[]): McpResource[] {
  checkCatalog(listed, (item) => item.uri);
  return listed.map((definition) => {
    const clean = redact(definition, secrets);
    const issue =
      !catalogKey(definition.uri) || clean.uri !== definition.uri
        ? '리소스 URI를 안전하게 사용할 수 없습니다.'
        : !textMimeType(definition.mimeType)
          ? '텍스트 리소스만 읽을 수 있습니다.'
          : undefined;
    return {
      uri: clean.uri,
      name: clean.name,
      revision: hash(definition),
      definition: clean,
      supported: !issue,
      ...(issue ? { issue } : {}),
    };
  });
}
function promptCatalog(listed: Prompt[], secrets: string[]): McpPrompt[] {
  checkCatalog(listed, (item) => item.name);
  return listed.map((definition) => {
    const clean = redact(definition, secrets),
      args = definition.arguments ?? [];
    const issue =
      !catalogKey(definition.name) ||
      clean.name !== definition.name ||
      args.length > 32 ||
      new Set(args.map((arg) => arg.name)).size !== args.length ||
      args.some((arg) => !catalogKey(arg.name) || arg.name.length > 128) ||
      hash(clean.arguments ?? []) !== hash(definition.arguments ?? [])
        ? '프롬프트 이름 또는 인자 정의를 안전하게 사용할 수 없습니다.'
        : undefined;
    return {
      name: clean.name,
      revision: hash(definition),
      definition: clean,
      supported: !issue,
      ...(issue ? { issue } : {}),
    };
  });
}
function templateCatalog(listed: ResourceTemplate[], secrets: string[]): McpResourceTemplate[] {
  checkCatalog(listed, (item) => item.uriTemplate);
  return listed.map((definition) => {
    const clean = redact(definition, secrets);
    let variables: string[] = [],
      issue: string | undefined;
    try {
      const parsed = new UriTemplate(definition.uriTemplate);
      variables = parsed.variableNames;
      if (
        !catalogKey(definition.uriTemplate) ||
        clean.uriTemplate !== definition.uriTemplate ||
        variables.length < 1 ||
        variables.length > 32 ||
        new Set(variables).size !== variables.length ||
        variables.some((name) => !catalogKey(name) || name.length > 128) ||
        !textMimeType(definition.mimeType)
      )
        issue = '리소스 템플릿 URI·매개변수 또는 MIME 형식을 안전하게 사용할 수 없습니다.';
    } catch {
      issue = '리소스 템플릿 URI 형식이 올바르지 않습니다.';
    }
    return {
      uriTemplate: clean.uriTemplate,
      name: clean.name,
      revision: hash(definition),
      definition: clean,
      variables,
      supported: !issue,
      ...(issue ? { issue } : {}),
    };
  });
}
function contentLimit(requested?: number) {
  if (
    requested !== undefined &&
    (!Number.isInteger(requested) || requested < 1 || requested > 24576)
  )
    throw new AppError('MCP_SIZE', 'MCP 텍스트 제한은 1~24576바이트여야 합니다.');
  return requested ?? 24576;
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
  private contentInvalidated = false;
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
    client.setNotificationHandler('notifications/resources/list_changed', () => {
      this.contentInvalidated = true;
    });
    client.setNotificationHandler('notifications/prompts/list_changed', () => {
      this.contentInvalidated = true;
    });
  }
  static async connect(options: {
    config: McpConfig;
    supervisorPath: string;
    resolveSecret: SecretResolver;
    signal: AbortSignal;
    expected?: McpRegistration;
    oauthToken?: string | undefined;
    roots?: Root[];
    sampling?: (
      params: CreateMessageRequestParams,
      signal: AbortSignal,
    ) => Promise<CreateMessageResult>;
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
    if (config.transport === 'http' && 'oauth' in config && config.oauth) {
      const token = options.oauthToken;
      if (!token || token.length > 8192 || /[\u0000\r\n]/.test(token))
        throw new AppError('MCP_AUTH', 'MCP 서버에 로그인한 뒤 다시 연결하세요.');
      values.Authorization = 'Bearer ' + token;
      secrets.push(token);
    }
    options.signal.throwIfAborted();
    const roots = safeRoots(options.roots);
    const clientCapabilities = {
      ...(roots.length ? { roots: { listChanged: false } } : {}),
      ...(options.sampling ? { sampling: {} } : {}),
    };
    const client = new Client(
      { name: 'lodex', version: '0.1.0' },
      {
        capabilities: clientCapabilities,
        enforceStrictCapabilities: true,
        listMaxPages: 8,
        inputRequired: {
          autoFulfill: roots.length > 0 || !!options.sampling,
          maxRounds: 3,
        },
        jsonSchemaValidator: validators(),
        versionNegotiation: {
          mode: config.protocol === '2026-07-28' ? { pin: '2026-07-28' } : config.protocol,
          probe: { maxRetries: 0, timeoutMs: 10000 },
        },
      },
    );
    if (roots.length) client.setRequestHandler('roots/list', async () => ({ roots }));
    if (options.sampling)
      client.setRequestHandler('sampling/createMessage', async (request, context) => {
        boundedShape(request.params, 131072);
        const result = await options.sampling!(
          request.params,
          AbortSignal.any([options.signal, context.mcpReq.signal]),
        );
        boundedShape(result, 131072);
        return result;
      });
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
      const capabilities = client.getServerCapabilities();
      const listOptions = { signal: options.signal, timeout: 15000, cacheMode: 'bypass' as const };
      // Old registrations remain tool-only until the user explicitly inspects them again.
      const resources =
        capabilities?.resources && (!options.expected || options.expected.resources !== undefined)
          ? resourceCatalog((await client.listResources(undefined, listOptions)).resources, secrets)
          : undefined;
      const resourceTemplates =
        capabilities?.resources &&
        (!options.expected || options.expected.resourceTemplates !== undefined)
          ? templateCatalog(
              (await client.listResourceTemplates(undefined, listOptions)).resourceTemplates,
              secrets,
            )
          : undefined;
      const prompts =
        capabilities?.prompts && (!options.expected || options.expected.prompts !== undefined)
          ? promptCatalog((await client.listPrompts(undefined, listOptions)).prompts, secrets)
          : undefined;
      const supportsCompletions =
        capabilities?.completions &&
        (!options.expected || options.expected.supportsCompletions !== undefined)
          ? true
          : undefined;
      const catalogRevisions = {
        ...(resources !== undefined
          ? { resources: resources.map((item) => [item.uri, item.revision]) }
          : {}),
        ...(resourceTemplates !== undefined
          ? {
              resourceTemplates: resourceTemplates.map((item) => [item.uriTemplate, item.revision]),
            }
          : {}),
        ...(prompts !== undefined
          ? { prompts: prompts.map((item) => [item.name, item.revision]) }
          : {}),
      };
      const registration: McpRegistration = {
        id: options.expected?.id ?? randomUUID(),
        config,
        revision: hash({
          config,
          identity,
          tools: tools.map((tool) => [tool.name, tool.revision]),
          ...(supportsCompletions ? { supportsCompletions } : {}),
          ...catalogRevisions,
        }),
        ...(identity ? { executableIdentity: identity } : {}),
        server: redact(client.getServerVersion() ?? null, secrets),
        protocol: client.getNegotiatedProtocolVersion() ?? null,
        tools,
        ...(resources !== undefined ? { resources } : {}),
        ...(resourceTemplates !== undefined ? { resourceTemplates } : {}),
        ...(prompts !== undefined ? { prompts } : {}),
        ...(supportsCompletions ? { supportsCompletions } : {}),
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
  private checkContent(serverRevision: string, signal: AbortSignal) {
    signal.throwIfAborted();
    if (
      this.closed ||
      this.invalidated ||
      this.contentInvalidated ||
      serverRevision !== this.registration.revision
    )
      throw new AppError(
        'MCP_CATALOG_CHANGED',
        'MCP 서버 또는 자료 목록이 변경되었습니다. 다시 연결 검사하세요.',
      );
  }
  private content(
    kind: McpContent['kind'],
    entryKey: string,
    entryRevision: string,
    text: string,
    maxBytes: number,
    messages?: McpContent['messages'],
    resolvedUri?: string,
  ): McpContent {
    const bytes = Buffer.byteLength(text);
    if (bytes > maxBytes)
      throw new AppError('MCP_SIZE', 'MCP 텍스트가 선택한 크기 제한을 초과했습니다.');
    return {
      kind,
      text,
      ...(messages ? { messages } : {}),
      provenance: {
        serverId: this.registration.id,
        serverRevision: this.registration.revision,
        kind,
        entryKey,
        entryRevision,
        ...(resolvedUri ? { resolvedUri } : {}),
        sha256: createHash('sha256').update(text).digest('hex'),
        bytes,
        readAt: new Date().toISOString(),
      },
    };
  }
  async complete(options: {
    serverRevision: string;
    kind: 'resource_template' | 'prompt';
    entryKey: string;
    revision: string;
    argumentName: string;
    value: string;
    arguments?: Record<string, string>;
    signal: AbortSignal;
  }): Promise<McpCompletion> {
    this.checkContent(options.serverRevision, options.signal);
    if (!this.registration.supportsCompletions)
      throw new AppError('MCP_COMPLETION', '이 MCP 서버는 인자 자동 완성을 지원하지 않습니다.');
    const chosen =
      options.kind === 'prompt'
        ? this.registration.prompts?.find(
            (item) => item.name === options.entryKey && item.revision === options.revision,
          )
        : this.registration.resourceTemplates?.find(
            (item) => item.uriTemplate === options.entryKey && item.revision === options.revision,
          );
    if (!chosen?.supported)
      throw new AppError('MCP_COMPLETION', '검토한 MCP 자료와 버전이 아닙니다.');
    const names =
      options.kind === 'prompt'
        ? ((chosen as McpPrompt).definition.arguments ?? []).map((argument) => argument.name)
        : (chosen as McpResourceTemplate).variables;
    const context = options.arguments ?? {};
    boundedShape(context, 16384);
    if (
      !names.includes(options.argumentName) ||
      options.value.length > 4096 ||
      Object.keys(context).length > 32 ||
      Object.entries(context).some(
        ([name, value]) =>
          !names.includes(name) || typeof value !== 'string' || value.length > 4096,
      )
    )
      throw new AppError('MCP_ARGUMENTS', '자동 완성할 인자와 현재 입력값을 확인하세요.');
    try {
      const result = await this.client.complete(
        {
          ref:
            options.kind === 'prompt'
              ? { type: 'ref/prompt', name: options.entryKey }
              : { type: 'ref/resource', uri: options.entryKey },
          argument: { name: options.argumentName, value: options.value },
          ...(Object.keys(context).length ? { context: { arguments: context } } : {}),
        },
        { signal: options.signal, timeout: 15000 },
      );
      this.checkContent(options.serverRevision, options.signal);
      boundedShape(result, 131072);
      const clean = redact(result.completion, this.secrets);
      if (
        !Array.isArray(clean.values) ||
        clean.values.length > 100 ||
        new Set(clean.values).size !== clean.values.length ||
        clean.values.some((value) => typeof value !== 'string' || value.length > 4096) ||
        (clean.total !== undefined &&
          (!Number.isInteger(clean.total) ||
            clean.total < clean.values.length ||
            clean.total > 1_000_000_000)) ||
        (clean.hasMore !== undefined && typeof clean.hasMore !== 'boolean')
      )
        throw new AppError('MCP_COMPLETION', 'MCP 서버가 잘못된 자동 완성 결과를 반환했습니다.');
      return {
        values: clean.values,
        ...(clean.total !== undefined ? { total: clean.total } : {}),
        ...(clean.hasMore !== undefined ? { hasMore: clean.hasMore } : {}),
      };
    } catch (error) {
      if (options.signal.aborted) options.signal.throwIfAborted();
      if (error instanceof AppError) throw error;
      throw new AppError(
        'MCP_COMPLETION_FAILED',
        'MCP 인자 추천을 가져오지 못했습니다. 자동으로 다시 요청하지 않습니다.',
      );
    }
  }
  async readResource(options: {
    serverRevision: string;
    uri: string;
    revision: string;
    signal: AbortSignal;
    maxBytes?: number;
  }): Promise<McpContent> {
    this.checkContent(options.serverRevision, options.signal);
    const limit = contentLimit(options.maxBytes);
    const chosen = this.registration.resources?.find(
      (item) => item.uri === options.uri && item.revision === options.revision,
    );
    if (!chosen?.supported)
      throw new AppError('MCP_RESOURCE', '검토한 텍스트 리소스와 버전이 아닙니다.');
    try {
      const current = resourceCatalog(
        (
          await this.client.listResources(undefined, {
            signal: options.signal,
            timeout: 15000,
            cacheMode: 'bypass',
          })
        ).resources,
        this.secrets,
      );
      if (
        hash(current.map((item) => [item.uri, item.revision])) !==
        hash(this.registration.resources!.map((item) => [item.uri, item.revision]))
      ) {
        this.contentInvalidated = true;
        throw new AppError(
          'MCP_CATALOG_CHANGED',
          'MCP 리소스 목록이 변경되었습니다. 다시 검토하세요.',
        );
      }
      this.checkContent(options.serverRevision, options.signal);
      const result = await this.client.readResource(
        { uri: chosen.uri },
        {
          signal: options.signal,
          timeout: 30000,
          cacheMode: 'bypass',
        },
      );
      this.checkContent(options.serverRevision, options.signal);
      boundedShape(result, 131072);
      if (
        !Array.isArray(result.contents) ||
        result.contents.length < 1 ||
        result.contents.length > 64 ||
        result.contents.some(
          (item) =>
            item.uri !== chosen.uri ||
            !('text' in item) ||
            typeof item.text !== 'string' ||
            'blob' in item ||
            !textMimeType(item.mimeType),
        )
      )
        throw new AppError(
          'MCP_CONTENT',
          '선택한 URI의 텍스트만 읽을 수 있습니다. 바이너리와 다른 URI의 자료는 첨부하지 않습니다.',
        );
      const clean = redact(result.contents, this.secrets);
      return this.content(
        'resource',
        chosen.uri,
        chosen.revision,
        clean.map((item) => ('text' in item ? item.text : '')).join('\n\n'),
        limit,
      );
    } catch (error) {
      if (options.signal.aborted) options.signal.throwIfAborted();
      if (error instanceof AppError) throw error;
      throw new AppError(
        'MCP_CONTENT_FAILED',
        'MCP 리소스를 읽지 못했습니다. 자동으로 다시 요청하지 않습니다.',
      );
    }
  }
  async readResourceTemplate(options: {
    serverRevision: string;
    uriTemplate: string;
    revision: string;
    arguments: Record<string, string>;
    signal: AbortSignal;
    maxBytes?: number;
  }): Promise<McpContent> {
    this.checkContent(options.serverRevision, options.signal);
    const limit = contentLimit(options.maxBytes);
    const chosen = this.registration.resourceTemplates?.find(
      (item) => item.uriTemplate === options.uriTemplate && item.revision === options.revision,
    );
    if (!chosen?.supported)
      throw new AppError('MCP_RESOURCE_TEMPLATE', '검토한 리소스 템플릿과 버전이 아닙니다.');
    boundedShape(options.arguments, 16384);
    if (
      Object.keys(options.arguments).length !== chosen.variables.length ||
      chosen.variables.some(
        (name) =>
          !Object.hasOwn(options.arguments, name) ||
          typeof options.arguments[name] !== 'string' ||
          options.arguments[name]!.length > 4096,
      ) ||
      Object.keys(options.arguments).some((name) => !chosen.variables.includes(name))
    )
      throw new AppError(
        'MCP_ARGUMENTS',
        '리소스 템플릿에 표시된 모든 매개변수만 문자열로 입력하세요.',
      );
    let resolvedUri: string;
    try {
      resolvedUri = new UriTemplate(chosen.uriTemplate).expand(options.arguments);
    } catch {
      throw new AppError('MCP_ARGUMENTS', '리소스 템플릿 URI를 만들 수 없습니다.');
    }
    if (!catalogKey(resolvedUri) || UriTemplate.isTemplate(resolvedUri))
      throw new AppError('MCP_ARGUMENTS', '완성된 리소스 URI를 안전하게 사용할 수 없습니다.');
    try {
      const current = templateCatalog(
        (
          await this.client.listResourceTemplates(undefined, {
            signal: options.signal,
            timeout: 15000,
            cacheMode: 'bypass',
          })
        ).resourceTemplates,
        this.secrets,
      );
      if (
        hash(current.map((item) => [item.uriTemplate, item.revision])) !==
        hash(this.registration.resourceTemplates!.map((item) => [item.uriTemplate, item.revision]))
      ) {
        this.contentInvalidated = true;
        throw new AppError(
          'MCP_CATALOG_CHANGED',
          'MCP 리소스 템플릿 목록이 변경되었습니다. 다시 검토하세요.',
        );
      }
      this.checkContent(options.serverRevision, options.signal);
      const result = await this.client.readResource(
        { uri: resolvedUri },
        {
          signal: options.signal,
          timeout: 30000,
          cacheMode: 'bypass',
        },
      );
      this.checkContent(options.serverRevision, options.signal);
      boundedShape(result, 131072);
      if (
        !Array.isArray(result.contents) ||
        result.contents.length < 1 ||
        result.contents.length > 64 ||
        result.contents.some(
          (item) =>
            item.uri !== resolvedUri ||
            !('text' in item) ||
            typeof item.text !== 'string' ||
            'blob' in item ||
            !textMimeType(item.mimeType),
        )
      )
        throw new AppError('MCP_CONTENT', '완성된 템플릿 URI의 텍스트만 읽을 수 있습니다.');
      const clean = redact(result.contents, this.secrets);
      return this.content(
        'resource_template',
        chosen.uriTemplate,
        chosen.revision,
        clean.map((item) => ('text' in item ? item.text : '')).join('\n\n'),
        limit,
        undefined,
        resolvedUri,
      );
    } catch (error) {
      if (options.signal.aborted) options.signal.throwIfAborted();
      if (error instanceof AppError) throw error;
      throw new AppError(
        'MCP_CONTENT_FAILED',
        'MCP 리소스 템플릿을 읽지 못했습니다. 자동으로 다시 요청하지 않습니다.',
      );
    }
  }
  async getPrompt(options: {
    serverRevision: string;
    name: string;
    revision: string;
    arguments?: Record<string, string>;
    signal: AbortSignal;
    maxBytes?: number;
  }): Promise<McpContent> {
    this.checkContent(options.serverRevision, options.signal);
    const limit = contentLimit(options.maxBytes);
    const chosen = this.registration.prompts?.find(
      (item) => item.name === options.name && item.revision === options.revision,
    );
    if (!chosen?.supported) throw new AppError('MCP_PROMPT', '검토한 프롬프트와 버전이 아닙니다.');
    const args = options.arguments ?? {},
      definitions = chosen.definition.arguments ?? [];
    boundedShape(args, 8192);
    if (
      !args ||
      typeof args !== 'object' ||
      Array.isArray(args) ||
      Object.entries(args).some(
        ([name, value]) =>
          typeof value !== 'string' || !definitions.some((arg) => arg.name === name),
      ) ||
      definitions.some((arg) => arg.required && !Object.hasOwn(args, arg.name))
    )
      throw new AppError('MCP_ARGUMENTS', '프롬프트 인자의 이름과 필수 항목을 확인하세요.');
    try {
      const current = promptCatalog(
        (
          await this.client.listPrompts(undefined, {
            signal: options.signal,
            timeout: 15000,
            cacheMode: 'bypass',
          })
        ).prompts,
        this.secrets,
      );
      if (
        hash(current.map((item) => [item.name, item.revision])) !==
        hash(this.registration.prompts!.map((item) => [item.name, item.revision]))
      ) {
        this.contentInvalidated = true;
        throw new AppError(
          'MCP_CATALOG_CHANGED',
          'MCP 프롬프트 목록이 변경되었습니다. 다시 검토하세요.',
        );
      }
      this.checkContent(options.serverRevision, options.signal);
      const result = await this.client.getPrompt(
        { name: chosen.name, arguments: args },
        {
          signal: options.signal,
          timeout: 30000,
        },
      );
      this.checkContent(options.serverRevision, options.signal);
      boundedShape(result, 131072);
      if (
        !Array.isArray(result.messages) ||
        result.messages.length < 1 ||
        result.messages.length > 64 ||
        result.messages.some(
          (message) =>
            !['user', 'assistant'].includes(message.role) ||
            message.content.type !== 'text' ||
            typeof message.content.text !== 'string',
        )
      )
        throw new AppError(
          'MCP_CONTENT',
          '텍스트 프롬프트만 첨부할 수 있습니다. 이미지·오디오·리소스 링크는 지원하지 않습니다.',
        );
      const clean = redact(result.messages, this.secrets);
      const messages = clean.map((message) => ({
        role: message.role,
        text: message.content.type === 'text' ? message.content.text : '',
      }));
      return this.content(
        'prompt',
        chosen.name,
        chosen.revision,
        messages.map((message) => `[${message.role}]\n${message.text}`).join('\n\n'),
        limit,
        messages,
      );
    } catch (error) {
      if (options.signal.aborted) options.signal.throwIfAborted();
      if (error instanceof AppError) throw error;
      throw new AppError(
        'MCP_CONTENT_FAILED',
        'MCP 프롬프트를 가져오지 못했습니다. 자동으로 다시 요청하지 않습니다.',
      );
    }
  }
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
