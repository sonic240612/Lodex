import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  mkdtemp,
  readFile,
  writeFile,
  rm,
  rmdir,
  readdir,
  lstat,
  link,
  symlink,
  rename,
  unlink,
  mkdir,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { oauthTokenKey, type OAuthTokenRecord } from '@lodex/mcp';
import { OAuthEnvStore } from './oauth-store';

const hooks = vi.hoisted(() => ({
  afterRead: undefined as ((path: string) => Promise<void>) | undefined,
  afterWrite: undefined as ((path: string) => Promise<void>) | undefined,
}));
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args),
        path = String(args[0]);
      return new Proxy(handle, {
        get(target, property) {
          const value = Reflect.get(target, property, target) as unknown;
          if (typeof value !== 'function') return value;
          if (property === 'read' || property === 'writeFile')
            return async (...input: unknown[]) => {
              const result: unknown = await Reflect.apply(value, target, input);
              if (property === 'read') await hooks.afterRead?.(path);
              if (property === 'writeFile' && path.endsWith('.tmp')) await hooks.afterWrite?.(path);
              return result;
            };
          return value.bind(target);
        },
      });
    },
  };
});
const directories: string[] = [];
afterEach(async () => {
  hooks.afterRead = undefined;
  hooks.afterWrite = undefined;
  for (const path of directories.splice(0)) {
    if (dirname(resolve(path)) !== resolve(tmpdir())) throw new Error('Unsafe fixture path');
    await rm(path, { recursive: true, force: true });
  }
});
async function fixture() {
  const path = await mkdtemp(join(tmpdir(), 'lodex-oauth-store-'));
  directories.push(path);
  return { path, store: new OAuthEnvStore(join(path, '.env')), env: join(path, '.env') };
}
function record(id = 'first'): OAuthTokenRecord {
  return {
    version: 1,
    resourceUrl: `https://${id}.example/mcp`,
    clientId: 'lodex-fixture',
    issuer: 'https://issuer.example/',
    tokenEndpoint: 'https://issuer.example/token',
    accessToken: `access-${id}-fixture`,
    refreshToken: `refresh-${id}-fixture`,
    expiresAt: 2000000000000,
    scopes: ['read'],
  };
}
function line(value: OAuthTokenRecord, key = oauthTokenKey(value)) {
  return `${key}=${Buffer.from(JSON.stringify(value)).toString('base64url')}\n`;
}
describe('OAuth private environment store', () => {
  it('keeps user .env byte-for-byte unchanged while persisting and reopening OAuth records', async () => {
    const { path, store, env } = await fixture(),
      userContent = Buffer.from(
        '# User notes\r\nOPENROUTER_API_KEY=fixture-user-key\r\nCUSTOM="retain this"\r\n',
      );
    await writeFile(env, userContent);
    const value = record(),
      key = oauthTokenKey(value);
    await store.save(key, value);
    expect(store.path).toBe(join(path, '.env.mcp'));
    expect(await store.load(key)).toEqual(value);
    expect(await new OAuthEnvStore(env).load(key)).toEqual(value);
    expect(await readFile(env)).toEqual(userContent);
    if (process.platform !== 'win32') expect((await lstat(store.path)).mode & 0o777).toBe(0o600);
    expect((await readdir(path)).sort()).toEqual(['.env', '.env.mcp']);
  });
  it('returns null for a missing record without creating or reading user .env', async () => {
    const { store, path, env } = await fixture();
    await writeFile(env, Buffer.from([0xff, 0xfe, 0xfd]));
    expect(await store.load(oauthTokenKey(record()))).toBeNull();
    expect(await readdir(path)).toEqual(['.env']);
  });
  it('serializes queued saves and removes only the selected binding', async () => {
    const { store } = await fixture(),
      first = record(),
      second = record('second');
    const initial = store.save(oauthTokenKey(first), first);
    const next = store.save(oauthTokenKey(second), second);
    await Promise.all([initial, next, store.remove(oauthTokenKey(first))]);
    expect(await store.load(oauthTokenKey(first))).toBeNull();
    expect(await store.load(oauthTokenKey(second))).toEqual(second);
  });
  it('does not poison the queue after an invalid save', async () => {
    const { store } = await fixture(),
      value = record();
    await expect(store.save('wrong', value)).rejects.toMatchObject({ code: 'OAUTH_ENV_KEY' });
    await expect(store.save(oauthTokenKey(record('different')), value)).rejects.toMatchObject({
      code: 'OAUTH_ENV_WRITE',
    });
    await store.save(oauthTokenKey(value), value);
    expect(await store.load(oauthTokenKey(value))).toEqual(value);
  });
  it.each([
    (value: OAuthTokenRecord) => line(value) + line(value),
    (value: OAuthTokenRecord) => line(value) + 'not an environment assignment\n',
    (value: OAuthTokenRecord) => line(value) + 'UNRELATED=fixture-key\n',
    (value: OAuthTokenRecord) => line(value) + `${oauthTokenKey(record('other'))}=e30\n`,
    (value: OAuthTokenRecord) => line(value, oauthTokenKey(record('other'))),
    (value: OAuthTokenRecord) =>
      `${oauthTokenKey(value)}='${Buffer.from(JSON.stringify(value)).toString('base64url')}'\n`,
  ])('fails closed on malformed or mismatched own-file contents %#', async (makeContent) => {
    const { store } = await fixture(),
      value = record(),
      content = makeContent(value);
    await writeFile(store.path, content);
    await expect(store.load(oauthTokenKey(value))).rejects.toMatchObject({
      code: 'OAUTH_ENV_FILE',
    });
    await expect(store.remove(oauthTokenKey(value))).rejects.toMatchObject({
      code: 'OAUTH_ENV_FILE',
    });
    expect(await readFile(store.path, 'utf8')).toBe(content);
  });
  it.each([Buffer.from([0xff, 0xfe, 0xfd]), Buffer.alloc(65537, 32)])(
    'rejects invalid UTF-8 and oversized token files %#',
    async (content) => {
      const { store } = await fixture();
      await writeFile(store.path, content);
      await expect(store.load(oauthTokenKey(record()))).rejects.toMatchObject({
        code: 'OAUTH_ENV_FILE',
      });
    },
  );
  it('rejects directories and hard-linked token files without modifying targets', async () => {
    const { store, path } = await fixture(),
      target = join(path, 'target');
    await mkdir(store.path);
    await expect(store.save(oauthTokenKey(record()), record())).rejects.toMatchObject({
      code: 'OAUTH_ENV_FILE',
    });
    await rmdir(store.path);
    await writeFile(target, line(record()));
    await link(target, store.path);
    await expect(store.load(oauthTokenKey(record()))).rejects.toMatchObject({
      code: 'OAUTH_ENV_FILE',
    });
    await expect(store.remove(oauthTokenKey(record()))).rejects.toMatchObject({
      code: 'OAUTH_ENV_FILE',
    });
    expect(await readFile(target, 'utf8')).toBe(line(record()));
  });
  it('rejects symbolic links without opening their targets', async (context) => {
    const { store, path } = await fixture(),
      target = join(path, 'target');
    await writeFile(target, line(record()));
    try {
      await symlink(target, store.path, 'file');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') {
        context.skip();
        return;
      }
      throw error;
    }
    await expect(store.load(oauthTokenKey(record()))).rejects.toMatchObject({
      code: 'OAUTH_ENV_FILE',
    });
    expect(await readFile(target, 'utf8')).toBe(line(record()));
  });
  it('fails when the file changes while reading a previously opened handle', async () => {
    const { store, path } = await fixture(),
      value = record(),
      replacement = join(path, 'replacement');
    await writeFile(store.path, line(value));
    await writeFile(replacement, line(record('second')));
    hooks.afterRead = async (opened) => {
      if (opened !== store.path) return;
      hooks.afterRead = undefined;
      if (process.platform === 'win32') await writeFile(store.path, line(record('second')));
      else await rename(replacement, store.path);
    };
    await expect(store.load(oauthTokenKey(value))).rejects.toMatchObject({
      code: 'OAUTH_ENV_FILE',
    });
    expect(await store.load(oauthTokenKey(record('second')))).toEqual(record('second'));
  });
  it('does not treat a file deleted during an opened read as a missing token', async () => {
    const { store } = await fixture(),
      value = record();
    await writeFile(store.path, line(value));
    hooks.afterRead = async (opened) => {
      if (opened !== store.path) return;
      hooks.afterRead = undefined;
      await unlink(store.path);
    };
    await expect(store.load(oauthTokenKey(value))).rejects.toMatchObject({
      code: 'OAUTH_ENV_FILE',
    });
  });
  it('rejects conflicting writers and leaves the external update intact', async () => {
    const { store, path } = await fixture(),
      value = record(),
      external = record('external');
    await store.save(oauthTokenKey(value), value);
    hooks.afterWrite = async () => {
      hooks.afterWrite = undefined;
      await writeFile(store.path, line(external));
    };
    await expect(
      store.save(oauthTokenKey(value), { ...value, accessToken: 'updated-fixture' }),
    ).rejects.toMatchObject({ code: 'OAUTH_ENV_CONFLICT' });
    expect(await readFile(store.path, 'utf8')).toBe(line(external));
    expect(await readdir(path)).toEqual(['.env.mcp']);
  });
  it('preserves an existing lock and refuses a second cooperating writer', async () => {
    const { store } = await fixture(),
      value = record(),
      lock = store.path + '.lock';
    await writeFile(lock, 'owned by another writer');
    await expect(store.save(oauthTokenKey(value), value)).rejects.toMatchObject({
      code: 'OAUTH_ENV_LOCK',
    });
    expect(await readFile(lock, 'utf8')).toBe('owned by another writer');
    expect(await store.load(oauthTokenKey(value))).toBeNull();
  });
  it('does not delete a replacement lock owned by an external writer', async () => {
    const { store, path } = await fixture(),
      value = record(),
      replacement = join(path, 'next-lock');
    await writeFile(replacement, 'next writer');
    hooks.afterWrite = async () => {
      hooks.afterWrite = undefined;
      if (process.platform === 'win32') await writeFile(store.path + '.lock', 'next writer');
      else await rename(replacement, store.path + '.lock');
    };
    await expect(store.save(oauthTokenKey(value), value)).rejects.toMatchObject({
      code: 'OAUTH_ENV_CONFLICT',
    });
    expect(await readFile(store.path + '.lock', 'utf8')).toBe('next writer');
  });
  it('keeps previous records and removes temporary files when a write fails without leaking error text', async () => {
    const { store, path } = await fixture(),
      value = record(),
      secret = 'fixture-sensitive-error';
    await store.save(oauthTokenKey(value), value);
    const previous = await readFile(store.path);
    hooks.afterWrite = async () => {
      hooks.afterWrite = undefined;
      throw new Error(secret);
    };
    const error = await store
      .save(oauthTokenKey(value), { ...value, accessToken: 'updated' })
      .catch((error: unknown) => error);
    expect(error).toMatchObject({ code: 'OAUTH_ENV_WRITE' });
    expect(String(error)).not.toContain(secret);
    expect(await readFile(store.path)).toEqual(previous);
    expect(await readdir(path)).toEqual(['.env.mcp']);
  });
  it('retains the last valid file when a save would exceed its byte limit', async () => {
    const { store } = await fixture();
    for (let index = 0; index < 5; index++) {
      const value = { ...record(`large${index}`), accessToken: 'a'.repeat(8192) };
      await store.save(oauthTokenKey(value), value);
    }
    const previous = await readFile(store.path),
      next = { ...record('overflow'), accessToken: 'a'.repeat(8192) };
    await expect(store.save(oauthTokenKey(next), next)).rejects.toMatchObject({
      code: 'OAUTH_ENV_LIMIT',
    });
    expect(await readFile(store.path)).toEqual(previous);
  });
});
