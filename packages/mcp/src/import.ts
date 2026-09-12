import { AppError } from '@lodex/contracts';
import { validateConfig, type McpConfig } from './config';

export interface McpImport {
  name: string;
  config: McpConfig | null;
  issues: string[];
}
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
/** Pure, passive conversion. Inline environment/header values never leave this function. */
export function importMcpConfigurations(text: string, defaultCwd?: string): McpImport[] {
  if (Buffer.byteLength(text) > 131072)
    throw new AppError('MCP_IMPORT_SIZE', 'MCP 설정은 128 KiB 이하여야 합니다.');
  let raw: Record<string, unknown>;
  try {
    raw = object(JSON.parse(text));
  } catch {
    throw new AppError('MCP_IMPORT_JSON', 'MCP 설정이 올바른 JSON이 아닙니다.');
  }
  const servers = raw.mcpServers ?? raw.servers;
  const entries =
    servers === undefined
      ? [[typeof raw.name === 'string' ? raw.name : 'MCP server', raw] as const]
      : Object.entries(object(servers));
  if (!entries.length || entries.length > 32)
    throw new AppError('MCP_IMPORT_COUNT', '한 번에 1~32개 서버 설정을 가져올 수 있습니다.');
  return entries.map(([name, source]) => {
    const value = object(source),
      issues: string[] = [];
    const refs = (values: unknown) =>
      Object.fromEntries(
        Object.entries(object(values)).flatMap(([key, value]) => {
          if (typeof value === 'object' && value !== null) return [[key, value]];
          const match =
            typeof value === 'string'
              ? /^(.*?)\$\{(?:ENV:)?(LODEX_MCP_[A-Z][A-Z0-9_]{0,99})\}$/.exec(value)
              : null;
          if (match) return [[key, { secretRef: match[2], prefix: match[1] }]];
          issues.push(`${key}: 값을 .env의 LODEX_MCP_ 변수로 옮기고 secretRef로 지정하세요.`);
          return [];
        }),
      );
    const transport = value.transport ?? value.type ?? (value.url ? 'http' : 'stdio');
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
      'url',
      'headers',
      'disabled',
      'oauth',
    ]);
    if (Object.keys(value).some((key) => !allowed.has(key)))
      issues.push('지원하지 않는 설정 필드가 있습니다. 가져오기를 생략했습니다.');
    if (value.disabled === true) issues.push('원본 설정에서 비활성화한 서버입니다.');
    const config =
      transport === 'stdio'
        ? {
            name,
            transport,
            executable: value.executable ?? value.command,
            args: value.args ?? [],
            cwd: value.cwd ?? defaultCwd,
            env: refs(value.env),
            protocol: value.protocol ?? 'legacy',
          }
        : {
            name,
            transport,
            url: value.url,
            headers: refs(value.headers),
            ...(value.oauth ? { oauth: value.oauth } : {}),
            protocol: value.protocol ?? 'auto',
          };
    try {
      const parsed = validateConfig(config);
      return { name, config: issues.length ? null : parsed, issues };
    } catch (error) {
      issues.push(error instanceof AppError ? error.message : '설정 형식을 확인하세요.');
      return { name, config: null, issues };
    }
  });
}
