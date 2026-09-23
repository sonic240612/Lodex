import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { AppError, localUrlSchema } from '@lodex/contracts';

const text = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => !/[\0\r\n]/.test(value));
export const secretReferenceSchema = z.strictObject({
  secretRef: z.string().regex(/^LODEX_MCP_[A-Z][A-Z0-9_]{0,99}$/),
  prefix: z
    .string()
    .max(64)
    .refine((value) => !/[\0\r\n]/.test(value))
    .default(''),
});
const references = z
  .record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_-]{0,99}$/), secretReferenceSchema)
  .refine((value) => Object.keys(value).length <= 16);
const common = {
  name: z.string().trim().min(1).max(120),
  protocol: z.enum(['legacy', '2026-07-28', 'auto']).default('legacy'),
};
export const mcpConfigSchema = z.discriminatedUnion('transport', [
  z.strictObject({
    ...common,
    transport: z.literal('stdio'),
    executable: text.refine(isAbsolute, '실행 파일의 절대 경로가 필요합니다.'),
    args: z
      .array(
        z
          .string()
          .max(8000)
          .refine((v) => !/[\0\r\n]/.test(v)),
      )
      .max(100)
      .default([]),
    cwd: text.refine(isAbsolute, '작업 폴더의 절대 경로가 필요합니다.'),
    env: references.default({}),
  }),
  z.strictObject({
    ...common,
    transport: z.literal('http'),
    url: text.refine((value) => {
      try {
        const url = new URL(value);
        return (
          !url.username &&
          !url.password &&
          !url.search &&
          !url.hash &&
          (url.protocol === 'https:' || localUrlSchema.safeParse(value).success)
        );
      } catch {
        return false;
      }
    }, 'HTTPS 또는 사설 HTTP endpoint가 필요합니다. URL에 인증 정보·쿼리를 넣지 마세요.'),
    headers: references.default({}),
    oauth: z
      .strictObject({
        clientId: z
          .string()
          .min(1)
          .max(512)
          .refine((value) => !/[\0\r\n]/.test(value)),
      })
      .optional(),
  }),
  z.strictObject({
    ...common,
    transport: z.literal('sse'),
    url: text.refine((value) => {
      try {
        const url = new URL(value);
        return (
          !url.username &&
          !url.password &&
          !url.search &&
          !url.hash &&
          (url.protocol === 'https:' || localUrlSchema.safeParse(value).success)
        );
      } catch {
        return false;
      }
    }, 'HTTPS 또는 사설 HTTP SSE endpoint가 필요합니다. URL에 인증 정보·쿼리를 넣지 마세요.'),
    headers: references.default({}),
    oauth: z
      .strictObject({
        clientId: z
          .string()
          .min(1)
          .max(512)
          .refine((value) => !/[\0\r\n]/.test(value)),
      })
      .optional(),
  }),
]);
export type McpConfig = z.infer<typeof mcpConfigSchema>;
export type SecretResolver = (name: string) => Promise<string | null>;

const deniedEnvironment =
  /^(?:NODE_|LD_|DYLD_|PYTHON|RUBY|PERL|BASH_ENV$|ENV$|COMSPEC$|PATH$|PATHEXT$|SYSTEMROOT$|WINDIR$)/i;
const deniedHeaders =
  /^(?:host|origin|cookie|connection|content-length|content-type|accept|mcp-|last-event-id)/i;
export function validateConfig(value: unknown): McpConfig {
  const parsed = mcpConfigSchema.safeParse(value);
  if (!parsed.success) throw new AppError('MCP_CONFIG', 'MCP 연결 설정 형식과 경로를 확인하세요.');
  const config = parsed.data;
  if (config.transport === 'stdio') {
    if (/\.(?:cmd|bat|ps1)$/i.test(config.executable))
      throw new AppError(
        'MCP_EXECUTABLE',
        '셸 스크립트 대신 node·python 등의 실행 파일과 인자를 지정하세요.',
      );
    if (config.protocol === 'auto')
      throw new AppError('MCP_PROTOCOL', 'stdio는 legacy 또는 2026-07-28 버전을 직접 선택하세요.');
    if (Object.keys(config.env).some((key) => deniedEnvironment.test(key)))
      throw new AppError('MCP_ENV', '실행기 동작을 바꾸는 환경 변수는 전달할 수 없습니다.');
  } else if (
    config.oauth &&
    Object.keys(config.headers).some((key) => key.toLowerCase() === 'authorization')
  )
    throw new AppError(
      'MCP_AUTH_CONFIG',
      'OAuth와 Authorization 헤더를 동시에 설정할 수 없습니다.',
    );
  else if (Object.keys(config.headers).some((key) => deniedHeaders.test(key)))
    throw new AppError('MCP_HEADERS', '전송 프로토콜이 관리하는 헤더는 지정할 수 없습니다.');
  return config;
}
export async function resolveReferences(config: McpConfig, resolve: SecretResolver) {
  const fields = config.transport === 'stdio' ? config.env : config.headers;
  const values: Record<string, string> = {},
    secrets: string[] = [];
  for (const [key, reference] of Object.entries(fields)) {
    const value = await resolve(reference.secretRef);
    if (!value || value.length > 8192 || /[\0\r\n]/.test(value))
      throw new AppError(
        'MCP_SECRET',
        `환경 변수 ${reference.secretRef}를 .env에 설정하고 다시 시도하세요.`,
      );
    secrets.push(value);
    values[key] = reference.prefix + value;
  }
  return { values, secrets };
}
export function processEnvironment(): Record<string, string> {
  const allowed = new Set(['path', 'pathext', 'systemroot', 'windir', 'temp', 'tmp', 'tmpdir']);
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        allowed.has(entry[0].toLowerCase()) && typeof entry[1] === 'string',
    ),
  );
}
