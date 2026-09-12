import { open, lstat, rename, unlink, type FileHandle } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { AppError } from '@lodex/contracts';
import { oauthTokenKey, validateOAuthTokenRecord, type OAuthTokenRecord } from '@lodex/mcp';

const variableName = /^LODEX_MCP_OAUTH_[A-F0-9]{64}$/;
const maxBytes = 65536;
function regularFile(info: Stats) {
  return info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && info.size <= maxBytes;
}
function sameFile(left: Stats, right: Stats) {
  return left.dev === right.dev && left.ino === right.ino;
}
function sameSnapshot(left: Stats, right: Stats) {
  return (
    sameFile(left, right) &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs &&
    left.nlink === right.nlink &&
    left.mode === right.mode
  );
}
function recordForKey(key: string, value: unknown): OAuthTokenRecord {
  if (!value || typeof value !== 'object') throw new Error('Invalid OAuth record');
  const candidate = value as OAuthTokenRecord;
  const selected = { resourceUrl: candidate.resourceUrl, clientId: candidate.clientId };
  const record = validateOAuthTokenRecord(value, selected);
  if (oauthTokenKey(selected) !== key) throw new Error('Invalid OAuth binding');
  return record;
}
function decodeRecord(key: string, value: string): OAuthTokenRecord {
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.toString('base64url') !== value) throw new Error('Invalid OAuth encoding');
  return recordForKey(key, JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
}
/** Dedicated .env.mcp contains only OAuth records; user .env content is never rewritten. */
export class OAuthEnvStore {
  readonly path: string;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(envPath: string) {
    if (!isAbsolute(envPath)) throw new AppError('ENV_PATH', '.env 파일의 절대 경로가 필요합니다.');
    this.path = join(dirname(envPath), '.env.mcp');
  }
  private async read(): Promise<{ values: Record<string, string>; identity: string | null }> {
    let before: Stats;
    try {
      before = await lstat(this.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { values: {}, identity: null };
      throw new AppError('OAUTH_ENV_FILE', '.env.mcp 파일 경로·내용·권한을 확인하세요.');
    }
    try {
      if (!regularFile(before)) throw new Error('Invalid OAuth file');
      const handle = await open(this.path, 'r');
      try {
        const opened = await handle.stat();
        if (!regularFile(opened) || !sameSnapshot(before, opened))
          throw new Error('Changed OAuth file');
        const bytes = Buffer.alloc(maxBytes + 1);
        let length = 0;
        while (length < bytes.length) {
          const chunk = await handle.read(bytes, length, bytes.length - length, length);
          if (!chunk.bytesRead) break;
          length += chunk.bytesRead;
        }
        if (length > maxBytes || length !== opened.size) throw new Error('Invalid OAuth file size');
        const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length));
        const values: Record<string, string> = Object.create(null) as Record<string, string>;
        for (const line of source.split(/\r?\n/)) {
          if (!line.trim() || line.startsWith('#')) continue;
          const match = /^(LODEX_MCP_OAUTH_[A-F0-9]{64})=([A-Za-z0-9_-]+)$/.exec(line);
          if (!match || Object.hasOwn(values, match[1]!))
            throw new Error('Invalid OAuth environment');
          decodeRecord(match[1]!, match[2]!);
          values[match[1]!] = match[2]!;
        }
        const after = await handle.stat(),
          current = await lstat(this.path);
        if (
          !regularFile(after) ||
          !regularFile(current) ||
          !sameSnapshot(opened, after) ||
          !sameSnapshot(opened, current)
        )
          throw new Error('Changed OAuth file');
        return {
          values,
          identity: [
            opened.dev,
            opened.ino,
            createHash('sha256').update(source).digest('hex'),
          ].join(':'),
        };
      } finally {
        await handle.close();
      }
    } catch {
      throw new AppError(
        'OAUTH_ENV_FILE',
        '.env.mcp는 OAuth 전용 일반 파일이어야 합니다. 파일 경로·내용·권한을 확인하세요.',
      );
    }
  }
  async load(key: string): Promise<OAuthTokenRecord | null> {
    if (!variableName.test(key)) throw new AppError('OAUTH_ENV_KEY', '잘못된 OAuth 저장 키입니다.');
    await this.queue;
    const value = (await this.read()).values[key];
    return value ? decodeRecord(key, value) : null;
  }
  save(key: string, record: OAuthTokenRecord) {
    return this.change(key, record);
  }
  remove(key: string) {
    return this.change(key, null);
  }
  private change(key: string, record: OAuthTokenRecord | null): Promise<void> {
    const next = this.queue.then(async () => {
      if (!variableName.test(key))
        throw new AppError('OAUTH_ENV_KEY', '잘못된 OAuth 저장 키입니다.');
      let lock: FileHandle;
      try {
        lock = await open(this.path + '.lock', 'wx', 0o600);
      } catch {
        throw new AppError(
          'OAUTH_ENV_LOCK',
          '.env.mcp를 다른 작업이 수정하고 있습니다. 앱이 모두 종료된 뒤에도 계속되면 .env.mcp.lock 파일을 확인하세요.',
        );
      }
      let lockIdentity: Stats;
      try {
        lockIdentity = await lock.stat();
      } catch {
        await lock.close().catch(() => undefined);
        throw new AppError(
          'OAUTH_ENV_LOCK',
          'OAuth 저장 잠금 파일을 확인하지 못했습니다. .env.mcp.lock 파일의 상태를 확인하세요.',
        );
      }
      const temporary = this.path + '.' + randomUUID() + '.tmp';
      let temporaryIdentity: Stats | undefined;
      try {
        const previous = await this.read(),
          values = { ...previous.values };
        if (record)
          values[key] = Buffer.from(JSON.stringify(recordForKey(key, record))).toString(
            'base64url',
          );
        else delete values[key];
        const content =
          '# Lodex MCP OAuth tokens. Private; do not commit or share.\n' +
          Object.entries(values)
            .map(([name, value]) => name + '=' + value + '\n')
            .join('');
        if (Buffer.byteLength(content) > maxBytes)
          throw new AppError(
            'OAUTH_ENV_LIMIT',
            'OAuth 저장 파일의 64 KiB 한도를 초과했습니다. 사용하지 않는 연결을 해제하세요.',
          );
        const file = await open(temporary, 'wx', 0o600);
        try {
          temporaryIdentity = await file.stat();
          await file.writeFile(content, 'utf8');
          await file.sync();
          temporaryIdentity = await file.stat();
        } finally {
          await file.close();
        }
        if ((await this.read()).identity !== previous.identity)
          throw new AppError(
            'OAUTH_ENV_CONFLICT',
            'OAuth 저장 파일이 변경되었습니다. 다시 로그인하세요.',
          );
        const candidate = await lstat(temporary),
          heldLock = await lstat(this.path + '.lock');
        if (
          !regularFile(candidate) ||
          !sameSnapshot(candidate, temporaryIdentity) ||
          !regularFile(heldLock) ||
          !sameSnapshot(heldLock, lockIdentity)
        )
          throw new AppError(
            'OAUTH_ENV_CONFLICT',
            'OAuth 저장 파일이 변경되었습니다. 다시 로그인하세요.',
          );
        await rename(temporary, this.path);
        temporaryIdentity = undefined;
      } catch (error) {
        if (error instanceof AppError) throw error;
        throw new AppError(
          'OAUTH_ENV_WRITE',
          'OAuth 인증 정보를 .env.mcp에 저장하지 못했습니다. 경로·권한을 확인하세요.',
        );
      } finally {
        if (temporaryIdentity) await this.removeOwned(temporary, temporaryIdentity);
        await lock.close().catch(() => undefined);
        await this.removeOwned(this.path + '.lock', lockIdentity, true);
      }
    });
    this.queue = next.catch(() => undefined);
    return next;
  }
  private async removeOwned(path: string, identity: Stats, unchanged = false) {
    try {
      const current = await lstat(path);
      if (
        current.isFile() &&
        !current.isSymbolicLink() &&
        sameFile(current, identity) &&
        (!unchanged || sameSnapshot(current, identity))
      )
        await unlink(path);
    } catch {
      /* A replaced path belongs to its new writer; leave it alone. */
    }
  }
}
