import { open, lstat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { parseEnv } from 'node:util';
import { AppError, type SecretSource } from '@lodex/contracts';

export interface SecretConfig {
  openrouterKey: string | null;
  openrouterKeySource: SecretSource;
  envFilePath: string;
}
function key(value: string | null | undefined): string | null {
  if (!value?.trim()) return null;
  const trimmed = value.trim();
  if (trimmed.length > 1000 || /[\x00-\x20\x7f]/.test(trimmed))
    throw new AppError(
      'ENV_KEY_FORMAT',
      'OpenRouter 키 형식이 올바르지 않습니다. 값은 로그에 표시하지 않습니다.',
    );
  return trimmed;
}
async function readEnvFile(options: {
  envFilePath: string;
  requiredFile?: boolean;
}): Promise<Record<string, string | undefined>> {
  if (!isAbsolute(options.envFilePath))
    throw new AppError('ENV_PATH', '.env 파일은 절대 경로로 지정해야 합니다.');
  let values: Record<string, string | undefined> = {};
  try {
    const info = await lstat(options.envFilePath);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 65536)
      throw new AppError('ENV_FILE', '.env는 64 KiB 이하의 일반 파일이어야 합니다.');
    const handle = await open(options.envFilePath, 'r');
    try {
      const opened = await handle.stat();
      if (opened.ino !== info.ino || opened.dev !== info.dev || opened.size > 65536)
        throw new AppError('ENV_FILE', '.env 파일이 읽는 중 변경되었습니다.');
      const bytes = Buffer.alloc(65537);
      let total = 0;
      while (total < bytes.length) {
        const result = await handle.read(bytes, total, bytes.length - total, total);
        if (!result.bytesRead) break;
        total += result.bytesRead;
      }
      if (total > 65536) throw new AppError('ENV_FILE', '.env 파일 크기 제한을 초과했습니다.');
      values = parseEnv(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, total)));
    } finally {
      await handle.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || options.requiredFile) {
      if (error instanceof AppError) throw error;
      throw new AppError(
        'ENV_FILE',
        '.env 파일을 읽을 수 없습니다. 경로·권한·UTF-8 형식을 확인하세요.',
      );
    }
  }
  return values;
}
export async function loadMcpSecret(
  name: string,
  options: { envFilePath?: string; environment?: NodeJS.ProcessEnv },
): Promise<string | undefined> {
  if (!/^LODEX_MCP_[A-Z][A-Z0-9_]{0,99}$/.test(name))
    throw new AppError('MCP_SECRET_REF', 'MCP 비밀 변수 이름이 올바르지 않습니다.');
  const value = (options.environment ?? process.env)[name];
  if (value) return value;
  return options.envFilePath
    ? (await readEnvFile({ envFilePath: options.envFilePath }))[name]
    : undefined;
}
export async function loadTelegramToken(options: {
  envFilePath?: string;
  environment?: NodeJS.ProcessEnv;
}): Promise<string | null> {
  const value =
    (options.environment ?? process.env).TELEGRAM_BOT_TOKEN ||
    (options.envFilePath
      ? (await readEnvFile({ envFilePath: options.envFilePath })).TELEGRAM_BOT_TOKEN
      : undefined);
  if (!value?.trim()) return null;
  if (!/^\d{5,20}:[A-Za-z0-9_-]{20,150}$/.test(value.trim()))
    throw new AppError('TELEGRAM_TOKEN', 'TELEGRAM_BOT_TOKEN 형식을 확인하세요.');
  return value.trim();
}
export async function loadSecrets(options: {
  envFilePath: string;
  requiredFile?: boolean;
  environment?: Pick<NodeJS.ProcessEnv, 'OPENROUTER_API_KEY'>;
  keychainKey?: string | null;
}): Promise<SecretConfig> {
  const values = await readEnvFile(options);
  // Only the allowlisted key is used. Never mutate process.env, expand variables,
  // execute shell substitutions, or forward arbitrary file entries to children.
  const candidates: [SecretSource, string | null | undefined][] = [
    ['environment', options.environment?.OPENROUTER_API_KEY],
    ['env_file', values.OPENROUTER_API_KEY],
    ['os_keychain', options.keychainKey],
  ];
  for (const [source, value] of candidates) {
    const selected = key(value);
    if (selected)
      return {
        openrouterKey: selected,
        openrouterKeySource: source,
        envFilePath: options.envFilePath,
      };
  }
  return { openrouterKey: null, openrouterKeySource: 'none', envFilePath: options.envFilePath };
}
