import { createHash } from 'node:crypto';
import { createServer, request as httpRequest } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  McpOAuthManager,
  oauthTokenKey,
  validateOAuthTokenRecord,
  type OAuthTokenRecord,
} from './oauth';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function fixture(
  options: {
    oidc?: boolean;
    missingPkce?: boolean;
    mismatchIssuer?: boolean;
    mismatchResource?: boolean;
    redirect?: string;
    omitIssSupport?: boolean;
    dropRefresh?: boolean;
    tokenDelay?: Promise<void>;
    challenge?: (base: string) => string;
  } = {},
) {
  const requests: { path: string; authorization: string | undefined; body: URLSearchParams }[] = [];
  let base = '';
  const server = createServer((req, res) => {
    let bytes = '';
    req.setEncoding('utf8');
    req.on('data', (part: string) => {
      bytes += part;
    });
    req.on('end', () => {
      const body = new URLSearchParams(bytes),
        path = req.url ?? '';
      requests.push({ path, authorization: req.headers.authorization, body });
      const json = (value: unknown) => {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(value));
      };
      if (path === '/mcp') {
        res.statusCode = 401;
        res.setHeader(
          'WWW-Authenticate',
          options.challenge?.(base) ??
            `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp", scope="read write"`,
        );
        res.end();
      } else if (path === '/.well-known/oauth-protected-resource/mcp') {
        if (options.redirect) {
          res.statusCode = 302;
          res.setHeader('Location', options.redirect);
          res.end();
          return;
        }
        json({
          resource: `${base}/${options.mismatchResource ? 'other' : 'mcp'}`,
          authorization_servers: [`${base}/issuer`],
          scopes_supported: ['ignored-default'],
        });
      } else if (path === '/.well-known/oauth-authorization-server/issuer' && options.oidc) {
        res.statusCode = 404;
        res.end();
      } else if (
        [
          '/.well-known/oauth-authorization-server/issuer',
          '/.well-known/openid-configuration/issuer',
        ].includes(path)
      ) {
        json({
          issuer: `${base}/${options.mismatchIssuer ? 'other' : 'issuer'}`,
          authorization_endpoint: `${base}/authorize`,
          token_endpoint: `${base}/token`,
          response_types_supported: ['code'],
          grant_types_supported: ['authorization_code', 'refresh_token'],
          token_endpoint_auth_methods_supported: ['none'],
          code_challenge_methods_supported: options.missingPkce ? ['plain'] : ['S256'],
          authorization_response_iss_parameter_supported: !options.omitIssSupport,
        });
      } else if (path === '/token') {
        if (options.dropRefresh && body.get('grant_type') === 'refresh_token') {
          req.socket.destroy();
          return;
        }
        void (options.tokenDelay ?? Promise.resolve()).then(() =>
          json({
            token_type: 'Bearer',
            access_token: body.get('grant_type') === 'refresh_token' ? 'access-2' : 'access-1',
            refresh_token: body.get('grant_type') === 'refresh_token' ? 'refresh-2' : 'refresh-1',
            expires_in: 3600,
            scope: 'read write',
            resource: `${base}/mcp`,
            iss: `${base}/issuer`,
          }),
        );
      } else {
        res.statusCode = 404;
        res.end();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fixture');
  base = `http://127.0.0.1:${address.port}`;
  cleanup.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  return { base, resourceUrl: `${base}/mcp`, issuer: `${base}/issuer`, requests };
}
function manager(options: { now?: () => number; ttlMs?: number } = {}) {
  const records = new Map<string, unknown>();
  const saved: OAuthTokenRecord[] = [];
  const instance = new McpOAuthManager({
    tokenStore: {
      load: async (key) => structuredClone(records.get(key)),
      save: async (key, record) => {
        saved.push(structuredClone(record));
        records.set(key, structuredClone(record));
      },
      remove: async (key) => {
        records.delete(key);
      },
    },
    ...options,
  });
  cleanup.push(() => instance.close());
  return { instance, records, saved };
}
async function start(instance: McpOAuthManager, resourceUrl: string) {
  const preview = await instance.prepare({ resourceUrl, clientId: 'public-client' });
  const login = await instance.begin({
    preparationId: preview.id,
    approvedOrigins: preview.origins,
  });
  const authorization = new URL(login.authorizationUrl);
  const callback = new URL(login.redirectUri);
  callback.searchParams.set('state', authorization.searchParams.get('state')!);
  callback.searchParams.set('iss', preview.issuer);
  callback.searchParams.set('code', 'fixture-code');
  return { preview, login, authorization, callback };
}
describe('MCP OAuth public-client PKCE', () => {
  it('parses only Bearer challenge fields across schemes, quoted commas and whitespace', async () => {
    const f = await fixture({
      challenge: (base) =>
        `Basic realm="other, auth", resource_metadata="https://attacker.invalid/meta", Bearer realm="MCP\\\" login", resource_metadata = "${base}/.well-known/oauth-protected-resource/mcp", scope = "read write"`,
    });
    const { instance } = manager();
    const preview = await instance.prepare({
      resourceUrl: f.resourceUrl,
      clientId: 'public-client',
    });
    expect(preview.scopes).toEqual(['read', 'write']);
    expect(preview.origins).toEqual([f.base]);
  });
  it('rejects ambiguous duplicate Bearer fields', async () => {
    const f = await fixture({
      challenge: (base) =>
        `Bearer resource_metadata="${base}/metadata", resource_metadata="${base}/other"`,
    });
    const { instance } = manager();
    await expect(
      instance.prepare({ resourceUrl: f.resourceUrl, clientId: 'public-client' }),
    ).rejects.toMatchObject({ code: 'MCP_OAUTH_CHALLENGE' });
    expect(f.requests).toHaveLength(1);
  });
  it('previews only metadata, enforces explicit origins, completes bound PKCE and refreshes once', async () => {
    const f = await fixture({ oidc: true });
    let now = Date.now();
    const { instance, records, saved } = manager({ now: () => now });
    const preview = await instance.prepare({
      resourceUrl: f.resourceUrl,
      clientId: 'public-client',
    });
    expect(preview.scopes).toEqual(['read', 'write']);
    expect(f.requests.every((req) => req.body.size === 0 && !req.authorization)).toBe(true);
    expect(records.size).toBe(0);
    await expect(
      instance.begin({ preparationId: preview.id, approvedOrigins: [] }),
    ).rejects.toMatchObject({ code: 'MCP_OAUTH_APPROVAL' });
    const login = await instance.begin({
      preparationId: preview.id,
      approvedOrigins: preview.origins,
    });
    const authorization = new URL(login.authorizationUrl),
      callback = new URL(login.redirectUri);
    expect(authorization.searchParams.get('resource')).toBe(f.resourceUrl);
    expect(authorization.searchParams.get('code_challenge_method')).toBe('S256');
    callback.search = new URLSearchParams({
      state: authorization.searchParams.get('state')!,
      iss: f.issuer,
      code: 'fixture-code',
    }).toString();
    expect((await fetch(callback)).status).toBe(200);
    expect(instance.status(login.id).status).toBe('completed');
    const exchange = f.requests.find((req) => req.path === '/token')!;
    expect(exchange.authorization).toBeUndefined();
    expect(exchange.body.get('resource')).toBe(f.resourceUrl);
    expect(exchange.body.get('redirect_uri')).toBe(login.redirectUri);
    expect(
      createHash('sha256').update(exchange.body.get('code_verifier')!).digest('base64url'),
    ).toBe(authorization.searchParams.get('code_challenge'));
    const selected = { resourceUrl: f.resourceUrl, clientId: 'public-client' };
    expect(await instance.accessToken(selected)).toBe('access-1');
    expect(JSON.stringify(instance.status(login.id))).not.toMatch(
      /access-1|refresh-1|fixture-code|authorizationUrl/,
    );
    now += 3600000;
    expect(
      await Promise.all([instance.accessToken(selected), instance.accessToken(selected)]),
    ).toEqual(['access-2', 'access-2']);
    expect(f.requests.filter((req) => req.path === '/token')).toHaveLength(2);
    expect(saved[1]?.refreshToken).toBe('refresh-2');
    expect(f.requests.at(-1)?.body.get('resource')).toBe(f.resourceUrl);
    expect(oauthTokenKey(selected)).toMatch(/^LODEX_MCP_OAUTH_[A-F0-9]{64}$/);
    await instance.disconnect(selected);
    expect(await instance.accessToken(selected)).toBeNull();
  });
  it('rejects callback Host, path, state and duplicate parameters before consuming the code', async () => {
    const f = await fixture(),
      { instance } = manager();
    const { login, callback } = await start(instance, f.resourceUrl);
    const wrong = new URL(callback);
    wrong.searchParams.set('state', 'wrong');
    expect((await fetch(wrong)).status).toBe(400);
    wrong.search = callback.search;
    wrong.pathname = '/not-callback';
    expect((await fetch(wrong)).status).toBe(400);
    wrong.pathname = callback.pathname;
    wrong.searchParams.append('code', 'duplicate');
    expect((await fetch(wrong)).status).toBe(400);
    const hostStatus = await new Promise<number | undefined>((resolve, reject) => {
      const request = httpRequest(callback, { headers: { Host: 'attacker.example' } }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      });
      request.on('error', reject);
      request.end();
    });
    expect(hostStatus).toBe(400);
    expect(f.requests.filter((req) => req.path === '/token')).toHaveLength(0);
    expect(instance.status(login.id).status).toBe('pending');
    expect((await fetch(callback)).status).toBe(200);
  });
  it.each(['wrong', 'missing', 'case-folded'])(
    'rejects %s callback issuer without sending the code',
    async (kind) => {
      const f = await fixture(),
        { instance, records } = manager();
      const { login, callback } = await start(instance, f.resourceUrl);
      if (kind === 'missing') callback.searchParams.delete('iss');
      else
        callback.searchParams.set(
          'iss',
          kind === 'wrong' ? `${f.base}/other` : f.issuer.replace('http:', 'HTTP:'),
        );
      expect((await fetch(callback)).status).toBe(400);
      expect(instance.status(login.id).status).toBe('failed');
      expect(f.requests.filter((req) => req.path === '/token')).toHaveLength(0);
      expect(records.size).toBe(0);
    },
  );
  it('checks a present issuer even if its metadata support flag is absent', async () => {
    const f = await fixture({ omitIssSupport: true }),
      { instance } = manager();
    const { login, callback } = await start(instance, f.resourceUrl);
    callback.searchParams.set('iss', `${f.base}/other`);
    expect((await fetch(callback)).status).toBe(400);
    expect(instance.status(login.id).status).toBe('failed');
  });
  it.each(['missingPkce', 'mismatchIssuer', 'mismatchResource'] as const)(
    'rejects metadata %s',
    async (flag) => {
      const f = await fixture({ [flag]: true }),
        { instance } = manager();
      await expect(
        instance.prepare({ resourceUrl: f.resourceUrl, clientId: 'public-client' }),
      ).rejects.toMatchObject({ code: expect.stringMatching(/^MCP_OAUTH_/) });
      expect(f.requests.filter((req) => req.path === '/token')).toHaveLength(0);
    },
  );
  it('does not follow metadata redirects or expose upstream exception details', async () => {
    const target = await fixture(),
      f = await fixture({ redirect: `${target.base}/secret` }),
      { instance } = manager();
    await expect(
      instance.prepare({ resourceUrl: f.resourceUrl, clientId: 'public-client' }),
    ).rejects.toMatchObject({ code: 'MCP_OAUTH_NETWORK' });
    expect(target.requests).toHaveLength(0);
    const hostile = new McpOAuthManager({
      tokenStore: { load: async () => null, save: async () => {}, remove: async () => {} },
      fetch: async () => {
        throw new Error('access-token-secret');
      },
    });
    cleanup.push(() => hostile.close());
    await expect(
      hostile.prepare({ resourceUrl: f.resourceUrl, clientId: 'public-client' }),
    ).rejects.not.toThrow('access-token-secret');
  });
  it('cancels pending exchanges, expires callbacks, and removes credentials on disconnect', async () => {
    let release!: () => void;
    const f = await fixture({
      tokenDelay: new Promise<void>((resolve) => {
        release = resolve;
      }),
    });
    const { instance, records } = manager();
    const { login, callback } = await start(instance, f.resourceUrl);
    const response = fetch(callback)
      .then((res) => res.text())
      .catch(() => 'closed');
    await expect.poll(() => f.requests.filter((req) => req.path === '/token').length).toBe(1);
    expect(instance.cancel(login.id).status).toBe('cancelled');
    release();
    await response;
    await instance.disconnect({ resourceUrl: f.resourceUrl, clientId: 'public-client' });
    expect(records.size).toBe(0);
    let now = Date.now();
    const expiring = manager({ now: () => now });
    const pending = await start(expiring.instance, f.resourceUrl);
    now += 300001;
    expect(expiring.instance.status(pending.login.id).status).toBe('expired');
    await expect(fetch(pending.callback)).rejects.toThrow();
  });
  it('does not replay a refresh token after an unknown token exchange outcome', async () => {
    const f = await fixture({ dropRefresh: true });
    let now = Date.now();
    const { instance, records } = manager({ now: () => now });
    const { callback } = await start(instance, f.resourceUrl);
    await fetch(callback);
    now += 3600000;
    const selected = { resourceUrl: f.resourceUrl, clientId: 'public-client' };
    await expect(instance.accessToken(selected)).rejects.toMatchObject({
      code: 'MCP_OAUTH_NETWORK',
    });
    expect(records.size).toBe(0);
    expect(await instance.accessToken(selected)).toBeNull();
    expect(f.requests.filter((req) => req.body.get('grant_type') === 'refresh_token')).toHaveLength(
      1,
    );
  });
  it('rejects LAN HTTP, URL credentials, and token records bound to another resource', async () => {
    const { instance } = manager();
    for (const resourceUrl of [
      'http://192.168.1.2/mcp',
      'https://name:password@example.com/mcp',
      'https://example.com/mcp?key=secret',
    ])
      await expect(
        instance.prepare({ resourceUrl, clientId: 'public-client' }),
      ).rejects.toMatchObject({ code: 'MCP_OAUTH_URL' });
    expect(() =>
      validateOAuthTokenRecord(
        { version: 1, resourceUrl: 'https://other.example/mcp', clientId: 'public-client' },
        { resourceUrl: 'https://example.com/mcp', clientId: 'public-client' },
      ),
    ).toThrow();
  });
});
