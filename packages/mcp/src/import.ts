import { isAbsolute, resolve } from 'node:path';
import { parse as parseJsonc, type ParseError } from 'jsonc-parser';
import { parse as parseToml } from 'smol-toml';
import { AppError } from '@lodex/contracts';
import { validateConfig, type McpConfig } from './config';

export interface McpImport {
  name: string;
  config: McpConfig | null;
  issues: string[];
  warnings: string[];
}

const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

function parseSource(text: string): Record<string, unknown> {
  if (/\0/.test(text))
    throw new AppError('MCP_IMPORT_JSON', 'MCP 설정에 NUL 문자를 사용할 수 없습니다.');
  const trimmed = text.trimStart();
  try {
    if (trimmed.startsWith('{')) {
      const errors: ParseError[] = [];
      const value: unknown = parseJsonc(text, errors, {
        allowTrailingComma: true,
        disallowComments: false,
        allowEmptyContent: false,
      });
      if (errors.length) throw new Error('Invalid JSONC');
      return object(value);
    }
    return object(parseToml(text));
  } catch {
    throw new AppError(
      'MCP_IMPORT_JSON',
      'MCP 설정이 올바른 JSON, JSONC 또는 TOML 형식이 아닙니다.',
    );
  }
}

function serverEntries(raw: Record<string, unknown>) {
  const mcp = object(raw.mcp);
  const servers =
    raw.mcpServers ??
    raw.mcp_servers ??
    raw.servers ??
    (Object.keys(mcp).length ? (mcp.servers ?? mcp) : undefined);
  return servers === undefined
    ? ([[typeof raw.name === 'string' ? raw.name : 'MCP server', raw]] as const)
    : Object.entries(object(servers));
}

function reference(
  key: string,
  value: unknown,
  issues: string[],
): { secretRef: string; prefix: string } | null {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) return value as never;
  const match =
    typeof value === 'string'
      ? /^(.*?)(?:\$\{(?:ENV:)?(LODEX_MCP_[A-Z][A-Z0-9_]{0,99})\}|\{env:(LODEX_MCP_[A-Z][A-Z0-9_]{0,99})\})$/.exec(
          value,
        )
      : null;
  if (match)
    return {
      secretRef: (match[2] ?? match[3])!,
      prefix: match[1]!,
    };
  issues.push(`${key}: 값을 .env의 LODEX_MCP_ 변수로 옮기고 secretRef로 지정하세요.`);
  return null;
}

function references(values: unknown, issues: string[]) {
  return Object.fromEntries(
    Object.entries(object(values)).flatMap(([key, value]) => {
      const parsed = reference(key, value, issues);
      return parsed ? [[key, parsed]] : [];
    }),
  );
}

function namedReferences(values: unknown, issues: string[]) {
  return Object.fromEntries(
    Object.entries(object(values)).flatMap(([key, value]) => {
      if (typeof value !== 'string' || !/^LODEX_MCP_[A-Z][A-Z0-9_]{0,99}$/.test(value)) {
        issues.push(`${key}: 환경 변수 이름을 LODEX_MCP_ 접두사로 바꿔야 합니다.`);
        return [];
      }
      return [[key, { secretRef: value, prefix: '' }]];
    }),
  );
}

function listedReferences(values: unknown, issues: string[]) {
  if (values === undefined) return {};
  if (!Array.isArray(values)) {
    issues.push('env_vars: 환경 변수 이름 목록이어야 합니다.');
    return {};
  }
  return Object.fromEntries(
    values.flatMap((value) => {
      if (typeof value !== 'string' || !/^LODEX_MCP_[A-Z][A-Z0-9_]{0,99}$/.test(value)) {
        issues.push('env_vars: LODEX_MCP_ 접두사가 붙은 변수만 가져올 수 있습니다.');
        return [];
      }
      return [[value, { secretRef: value, prefix: '' }]];
    }),
  );
}

function localCommand(value: Record<string, unknown>, issues: string[]) {
  const command = value.executable ?? value.command;
  if (Array.isArray(command)) {
    if (!command.length || !command.every((entry) => typeof entry === 'string')) {
      issues.push('command: 실행 파일과 인자로 이루어진 문자열 목록이어야 합니다.');
      return { executable: undefined, args: [] };
    }
    if (value.args !== undefined)
      issues.push('command 배열과 별도의 args를 동시에 사용할 수 없습니다.');
    return { executable: command[0], args: command.slice(1) };
  }
  return { executable: command, args: value.args ?? [] };
}

function localPath(value: unknown, defaultCwd?: string) {
  if (typeof value !== 'string' || !value) return value;
  if (isAbsolute(value) || !defaultCwd || !isAbsolute(defaultCwd)) return value;
  return resolve(defaultCwd, value);
}

/** Passive conversion only. Importing never launches a process, connects to a server, or expands secrets. */
export function importMcpConfigurations(text: string, defaultCwd?: string): McpImport[] {
  if (Buffer.byteLength(text) > 131072)
    throw new AppError('MCP_IMPORT_SIZE', 'MCP 설정은 128 KiB 이하여야 합니다.');
  const raw = parseSource(text);
  const entries = serverEntries(raw);
  if (!entries.length || entries.length > 32)
    throw new AppError('MCP_IMPORT_COUNT', '한 번에 1~32개 서버 설정을 가져올 수 있습니다.');
  return entries.map(([name, source]) => {
    const value = object(source),
      issues: string[] = [],
      warnings: string[] = [];
    const rawType = value.transport ?? value.type;
    const transport =
      rawType === 'local' || rawType === 'stdio'
        ? 'stdio'
        : rawType === 'remote' ||
            rawType === 'http' ||
            rawType === 'sse' ||
            rawType === 'streamable_http'
          ? 'http'
          : value.url
            ? 'http'
            : 'stdio';
    const allowed = new Set([
      'name',
      'transport',
      'type',
      'protocol',
      'command',
      'executable',
      'args',
      'cwd',
      'env',
      'env_vars',
      'environment',
      'url',
      'headers',
      'http_headers',
      'env_http_headers',
      'bearer_token_env_var',
      'disabled',
      'enabled',
      'oauth',
      'startup_timeout_sec',
      'tool_timeout_sec',
      'timeout',
      'enabled_tools',
      'disabled_tools',
      'codemode',
    ]);
    if (Object.keys(value).some((key) => !allowed.has(key)))
      issues.push('지원하지 않는 설정 필드가 있습니다. 가져오기를 생략했습니다.');
    if (
      rawType !== undefined &&
      !['local', 'stdio', 'remote', 'http', 'streamable_http'].includes(String(rawType))
    )
      issues.push(
        rawType === 'sse'
          ? '기존 SSE 전송은 지원하지 않습니다. Streamable HTTP endpoint를 사용하세요.'
          : '지원하지 않는 MCP 전송 형식입니다.',
      );
    if (value.disabled === true || value.enabled === false)
      issues.push('원본 설정에서 비활성화한 서버입니다.');
    for (const key of [
      'startup_timeout_sec',
      'tool_timeout_sec',
      'timeout',
      'enabled_tools',
      'disabled_tools',
      'codemode',
    ])
      if (value[key] !== undefined)
        warnings.push(`${key}: Lodex의 공통 실행 제한과 대화별 도구 선택을 사용합니다.`);

    let config: unknown;
    if (transport === 'stdio') {
      const command = localCommand(value, issues);
      const env = {
        ...references(value.env ?? value.environment, issues),
        ...listedReferences(value.env_vars, issues),
      };
      config = {
        name,
        transport,
        executable: localPath(command.executable, defaultCwd),
        args: command.args,
        cwd: localPath(value.cwd ?? defaultCwd, defaultCwd),
        env,
        protocol: value.protocol ?? 'legacy',
      };
    } else {
      const headers = {
        ...references(value.headers ?? value.http_headers, issues),
        ...namedReferences(value.env_http_headers, issues),
      };
      if (value.bearer_token_env_var !== undefined) {
        const token = value.bearer_token_env_var;
        if (typeof token === 'string' && /^LODEX_MCP_[A-Z][A-Z0-9_]{0,99}$/.test(token))
          headers.Authorization = { secretRef: token, prefix: 'Bearer ' };
        else
          issues.push('bearer_token_env_var: LODEX_MCP_ 접두사가 붙은 변수만 가져올 수 있습니다.');
      }
      config = {
        name,
        transport,
        url: value.url,
        headers,
        ...(value.oauth ? { oauth: value.oauth } : {}),
        protocol: value.protocol ?? 'auto',
      };
    }
    try {
      const parsed = validateConfig(config);
      return { name, config: issues.length ? null : parsed, issues, warnings };
    } catch (error) {
      issues.push(error instanceof AppError ? error.message : '설정 형식을 확인하세요.');
      return { name, config: null, issues, warnings };
    }
  });
}
