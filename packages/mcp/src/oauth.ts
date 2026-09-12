import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { AppError } from '@lodex/contracts';
import { privateServerFetch } from '@lodex/providers';

export interface OAuthBinding {
  resourceUrl: string;
  clientId: string;
}
export interface OAuthTokenRecord extends OAuthBinding {
  version: 1;
  issuer: string;
  tokenEndpoint: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt: number | null;
  scopes: string[];
}
/** Store only in the application's private .env/keychain, never in session storage. */
export interface OAuthTokenStore {
  load(key: string): Promise<unknown>;
  save(key: string, record: OAuthTokenRecord): Promise<void>;
  remove(key: string): Promise<void>;
}
export interface OAuthPreparation extends OAuthBinding {
  id: string;
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  origins: string[];
  scopes: string[];
  expiresAt: number;
}
export interface OAuthStatus {
  id: string;
  status: 'pending' | 'completed' | 'failed' | 'cancelled' | 'expired';
  expiresAt: number;
  error?: string;
}
interface Preparation extends OAuthPreparation {
  issuerRequired: boolean;
}
interface Flow {
  preview: Preparation;
  status: OAuthStatus;
  state: string;
  verifier: string;
  redirectUri: string;
  server: Server;
  controller: AbortController;
  consumed: boolean;
  timer: ReturnType<typeof setTimeout>;
}
const MAX_BYTES = 65536;
const callbackPath = '/oauth/callback';
function fail(code: string, message: string): never {
  throw new AppError(`MCP_OAUTH_${code}`, message);
}
function safeError(error: unknown): AppError {
  return error instanceof AppError && error.code.startsWith('MCP_OAUTH_')
    ? error
    : new AppError('MCP_OAUTH_FAILED', 'OAuth 연결을 완료하지 못했습니다. 다시 로그인하세요.');
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    fail('FORMAT', 'OAuth 응답 형식을 확인할 수 없습니다.');
  return value as Record<string, unknown>;
}
function text(value: unknown, max = 4096): string {
  if (typeof value !== 'string' || !value || value.length > max || /[\x00-\x20\x7f]/.test(value))
    fail('FORMAT', 'OAuth 설정 또는 응답 형식이 올바르지 않습니다.');
  return value;
}
/** HTTP is permitted only on literal loopback addresses; LAN credentials need TLS. */
function endpoint(value: unknown): URL {
  const input = text(value);
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return fail('URL', 'OAuth endpoint는 HTTPS 또는 loopback HTTP 주소여야 합니다.');
  }
  if (
    url.username ||
    url.password ||
    url.hash ||
    url.search ||
    !(
      url.protocol === 'https:' ||
      (url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname))
    )
  )
    fail('URL', 'OAuth endpoint는 인증 정보·쿼리가 없는 HTTPS 또는 loopback HTTP 주소여야 합니다.');
  return url;
}
function binding(value: OAuthBinding): OAuthBinding {
  return { resourceUrl: endpoint(value.resourceUrl).href, clientId: text(value.clientId, 1000) };
}
function scopes(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 64)
    fail('SCOPE', 'OAuth scope 형식이 올바르지 않습니다.');
  const result = value.map((entry) => {
    const scope = text(entry, 256);
    if (!/^[\x21\x23-\x5b\x5d-\x7e]+$/.test(scope))
      fail('SCOPE', 'OAuth scope 형식이 올바르지 않습니다.');
    return scope;
  });
  return [...new Set(result)];
}
export function oauthTokenKey(value: OAuthBinding): string {
  const selected = binding(value);
  return (
    'LODEX_MCP_OAUTH_' +
    createHash('sha256')
      .update(JSON.stringify([selected.resourceUrl, selected.clientId]))
      .digest('hex')
      .toUpperCase()
  );
}
export function validateOAuthTokenRecord(value: unknown, expected: OAuthBinding): OAuthTokenRecord {
  const record = object(value),
    selected = binding(expected);
  if (
    record.version !== 1 ||
    record.resourceUrl !== selected.resourceUrl ||
    record.clientId !== selected.clientId
  )
    fail('BINDING', 'OAuth 토큰이 선택한 MCP 서버 및 client ID와 일치하지 않습니다.');
  endpoint(record.issuer);
  const tokenEndpoint = endpoint(record.tokenEndpoint).href;
  if (
    record.expiresAt !== null &&
    (typeof record.expiresAt !== 'number' ||
      !Number.isSafeInteger(record.expiresAt) ||
      record.expiresAt <= 0)
  )
    fail('TOKEN', '저장된 OAuth 토큰 형식이 올바르지 않습니다.');
  return {
    version: 1,
    ...selected,
    issuer: text(record.issuer),
    tokenEndpoint,
    accessToken: text(record.accessToken, 8192),
    ...(record.refreshToken === undefined ? {} : { refreshToken: text(record.refreshToken, 8192) }),
    expiresAt: record.expiresAt as number | null,
    scopes: scopes(record.scopes),
  };
}
function equalSecret(left: string, right: string): boolean {
  const a = Buffer.from(left),
    b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
function wellKnown(issuer: URL, name: string): string {
  return `${issuer.origin}/.well-known/${name}${issuer.pathname === '/' ? '' : issuer.pathname}`;
}
function bearerChallenge(header: string): Record<string, string> {
  const parts: string[] = [];
  let start = 0,
    quoted = false,
    escaped = false;
  for (let index = 0; index < header.length; index++) {
    const character = header[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quoted && character === '\\') {
      escaped = true;
      continue;
    }
    if (character === '"') quoted = !quoted;
    if (!quoted && character === ',') {
      parts.push(header.slice(start, index).trim());
      start = index + 1;
    }
  }
  if (quoted || escaped) fail('CHALLENGE', 'OAuth 인증 안내 형식이 올바르지 않습니다.');
  parts.push(header.slice(start).trim());
  let active = false,
    found = false;
  const result: Record<string, string> = {};
  for (let part of parts) {
    const scheme = /^([A-Za-z][A-Za-z0-9_-]*)\s+(?!\s*=)/.exec(part);
    if (scheme) {
      active = scheme[1]?.toLowerCase() === 'bearer';
      if (active && found) fail('CHALLENGE', 'OAuth Bearer 인증 안내가 중복되었습니다.');
      if (active) found = true;
      part = part.slice(scheme[0].length);
    }
    if (!active) continue;
    const parameter = /^([A-Za-z][A-Za-z0-9_-]*)\s*=\s*("(?:[^"\\]|\\[\x20-\x7e])*"|[^\s,]+)$/.exec(
      part,
    );
    if (!parameter?.[1] || !parameter[2])
      fail('CHALLENGE', 'OAuth 인증 안내 형식이 올바르지 않습니다.');
    const name = parameter[1].toLowerCase(),
      value = parameter[2];
    if (Object.hasOwn(result, name) || Object.keys(result).length >= 16)
      fail('CHALLENGE', 'OAuth 인증 안내 항목이 중복되거나 너무 많습니다.');
    result[name] = value.startsWith('"')
      ? value.slice(1, -1).replace(/\\([\x20-\x7e])/g, '$1')
      : value;
  }
  return result;
}

/** Explicit, pre-registered public clients only. No client registration, OAuth UI, or tool replay. */
export class McpOAuthManager {
  private readonly preparations = new Map<string, Preparation>();
  private readonly flows = new Map<string, Flow>();
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly refreshControllers = new Map<string, AbortController>();
  private readonly beginning = new Map<string, string>();
  private readonly generations = new Map<string, number>();
  private readonly now: () => number;
  private readonly ttl: number;
  private closed = false;
  constructor(
    private readonly options: {
      tokenStore: OAuthTokenStore;
      fetch?: typeof fetch;
      now?: () => number;
      ttlMs?: number;
    },
  ) {
    this.now = options.now ?? Date.now;
    this.ttl = Math.min(600000, Math.max(1, options.ttlMs ?? 300000));
  }
  private assertOpen() {
    if (this.closed) fail('CLOSED', 'OAuth 연결 관리자가 종료되었습니다.');
  }
  private async request(url: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
    const target = endpoint(url);
    const fetcher =
      this.options.fetch ?? (target.protocol === 'http:' ? privateServerFetch : fetch);
    try {
      return await fetcher(target.href, {
        ...init,
        redirect: 'error',
        credentials: 'omit',
        signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(15000)]),
      });
    } catch {
      return fail('NETWORK', 'OAuth endpoint에 연결할 수 없습니다. 주소와 네트워크를 확인하세요.');
    }
  }
  private async json(
    url: string,
    init: RequestInit = {},
    signal?: AbortSignal,
  ): Promise<Record<string, unknown> | null> {
    const response = await this.request(url, init, signal);
    if (response.status === 404 && (!init.method || init.method === 'GET')) {
      await response.body?.cancel();
      return null;
    }
    if (!response.ok) {
      await response.body?.cancel();
      fail('RESPONSE', 'OAuth 서버가 요청을 거절했습니다. 등록 정보와 권한을 확인하세요.');
    }
    if (!response.body) fail('FORMAT', 'OAuth 서버 응답이 비어 있습니다.');
    const reader = response.body.getReader(),
      chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > MAX_BYTES) fail('SIZE', 'OAuth 응답 크기 제한을 초과했습니다.');
        chunks.push(part.value);
      }
      return object(
        JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))),
      );
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  }
  private trim() {
    for (const [id, preparation] of this.preparations)
      if (preparation.expiresAt <= this.now()) this.preparations.delete(id);
    for (const flow of this.flows.values())
      if (flow.status.status === 'pending' && flow.status.expiresAt <= this.now())
        this.finish(flow, 'expired');
    if (this.flows.size >= 32) {
      for (const [id, flow] of this.flows) {
        if (flow.status.status !== 'pending') this.flows.delete(id);
        if (this.flows.size < 32) break;
      }
    }
  }
  async prepare(
    input: OAuthBinding & {
      scopes?: string[] | undefined;
      authorizationServer?: string | undefined;
    },
    signal?: AbortSignal,
  ): Promise<OAuthPreparation> {
    try {
      this.assertOpen();
      this.trim();
      if (this.preparations.size >= 32)
        fail('LIMIT', 'OAuth 연결 미리보기가 너무 많습니다. 잠시 후 다시 시도하세요.');
      const selected = binding(input),
        resource = endpoint(selected.resourceUrl);
      const initial = await this.request(
        resource.href,
        { headers: { Accept: 'application/json' } },
        signal,
      );
      const challenge =
        initial.status === 401 ? (initial.headers.get('www-authenticate') ?? '') : '';
      await initial.body?.cancel();
      if (challenge.length > 8192) fail('SIZE', 'OAuth 인증 안내 크기 제한을 초과했습니다.');
      const challengeValues = bearerChallenge(challenge);
      const challengedMetadata = challengeValues.resource_metadata;
      const metadataUrls = challengedMetadata
        ? [endpoint(challengedMetadata).href]
        : [
            ...new Set([
              wellKnown(resource, 'oauth-protected-resource'),
              `${resource.origin}/.well-known/oauth-protected-resource`,
            ]),
          ];
      let protectedResource: Record<string, unknown> | null = null;
      for (const url of metadataUrls) {
        protectedResource = await this.json(url, {}, signal);
        if (protectedResource) break;
      }
      if (!protectedResource || endpoint(protectedResource.resource).href !== resource.href)
        fail('RESOURCE', 'OAuth metadata가 선택한 MCP resource와 일치하지 않습니다.');
      const issuers = protectedResource.authorization_servers;
      if (!Array.isArray(issuers) || !issuers.length || issuers.length > 8)
        fail('ISSUER', 'OAuth authorization server 목록을 확인할 수 없습니다.');
      issuers.forEach(endpoint);
      const issuer = input.authorizationServer ?? (issuers.length === 1 ? issuers[0] : undefined);
      if (typeof issuer !== 'string' || !issuers.includes(issuer))
        fail('ISSUER', 'metadata에 등록된 authorization server를 하나 지정하세요.');
      const issuerUrl = endpoint(issuer);
      const discovery = [
        ...new Set([
          wellKnown(issuerUrl, 'oauth-authorization-server'),
          wellKnown(issuerUrl, 'openid-configuration'),
          `${issuerUrl.origin}${issuerUrl.pathname.replace(/\/$/, '')}/.well-known/openid-configuration`,
        ]),
      ];
      let metadata: Record<string, unknown> | null = null;
      for (const url of discovery) {
        metadata = await this.json(url, {}, signal);
        if (metadata) break;
      }
      if (!metadata || metadata.issuer !== issuer)
        fail('ISSUER', 'OAuth metadata issuer가 요청한 issuer와 일치하지 않습니다.');
      const authorizationEndpoint = endpoint(metadata.authorization_endpoint).href;
      const tokenEndpoint = endpoint(metadata.token_endpoint).href;
      if (
        !Array.isArray(metadata.code_challenge_methods_supported) ||
        !metadata.code_challenge_methods_supported.includes('S256')
      )
        fail('PKCE', '이 OAuth 서버는 PKCE S256 지원을 명시하지 않았습니다.');
      if (
        !Array.isArray(metadata.response_types_supported) ||
        !metadata.response_types_supported.includes('code')
      )
        fail('GRANT', '이 OAuth 서버는 authorization code 방식을 지원하지 않습니다.');
      if (
        metadata.grant_types_supported !== undefined &&
        (!Array.isArray(metadata.grant_types_supported) ||
          !metadata.grant_types_supported.includes('authorization_code'))
      )
        fail('GRANT', '이 OAuth 서버는 authorization code 방식을 지원하지 않습니다.');
      if (
        !Array.isArray(metadata.token_endpoint_auth_methods_supported) ||
        !metadata.token_endpoint_auth_methods_supported.includes('none')
      )
        fail('CLIENT', 'client secret이 없는 사전 등록 public client가 필요합니다.');
      const challengeScope = challengeValues.scope;
      const requestedScopes = scopes(
        input.scopes ??
          (challengeScope === undefined
            ? protectedResource.scopes_supported
            : challengeScope
              ? challengeScope.split(' ')
              : []),
      );
      const preparation: Preparation = {
        ...selected,
        id: randomUUID(),
        issuer,
        authorizationEndpoint,
        tokenEndpoint,
        scopes: requestedScopes,
        expiresAt: this.now() + this.ttl,
        origins: [
          ...new Set([
            resource.origin,
            ...metadataUrls.map((url) => new URL(url).origin),
            issuerUrl.origin,
            new URL(authorizationEndpoint).origin,
            new URL(tokenEndpoint).origin,
          ]),
        ].sort(),
        issuerRequired: metadata.authorization_response_iss_parameter_supported === true,
      };
      signal?.throwIfAborted();
      this.assertOpen();
      this.preparations.set(preparation.id, preparation);
      const { issuerRequired: _, ...preview } = preparation;
      return structuredClone(preview);
    } catch (error) {
      throw safeError(error);
    }
  }
  async begin(input: {
    preparationId: string;
    approvedOrigins: string[];
  }): Promise<{ id: string; authorizationUrl: string; redirectUri: string; expiresAt: number }> {
    try {
      this.assertOpen();
      this.trim();
      const preparation = this.preparations.get(input.preparationId);
      if (!preparation)
        fail('EXPIRED', 'OAuth 미리보기가 만료되었습니다. 연결 정보를 다시 확인하세요.');
      if (
        !Array.isArray(input.approvedOrigins) ||
        JSON.stringify([...new Set(input.approvedOrigins)].sort()) !==
          JSON.stringify(preparation.origins)
      )
        fail('APPROVAL', '미리보기에 표시된 OAuth endpoint origin에 대한 승인이 필요합니다.');
      if ([...this.flows.values()].filter((flow) => flow.status.status === 'pending').length >= 8)
        fail('LIMIT', '진행 중인 OAuth 로그인이 너무 많습니다. 기존 로그인을 마치세요.');
      this.preparations.delete(preparation.id);
      const key = oauthTokenKey(preparation);
      this.beginning.set(key, preparation.id);
      for (const flow of this.flows.values())
        if (oauthTokenKey(flow.preview) === key && flow.status.status === 'pending')
          this.finish(flow, 'cancelled');
      const state = randomBytes(32).toString('base64url'),
        verifier = randomBytes(64).toString('base64url');
      const server = createServer({ maxHeaderSize: 8192 }, (req, res) => {
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
        res.setHeader('Referrer-Policy', 'no-referrer');
        const flow = this.flows.get(preparation.id);
        const reject = () => {
          res.statusCode = 400;
          res.end('Invalid OAuth callback.');
        };
        if (
          !flow ||
          flow.status.status !== 'pending' ||
          flow.consumed ||
          this.now() >= flow.status.expiresAt ||
          req.method !== 'GET' ||
          req.socket.remoteAddress !== '127.0.0.1' ||
          req.headers.host !== new URL(flow.redirectUri).host ||
          !req.url ||
          req.url.length > 8192 ||
          !req.url.startsWith('/')
        )
          return reject();
        let url: URL;
        try {
          url = new URL(req.url, flow.redirectUri);
        } catch {
          return reject();
        }
        if (
          url.pathname !== callbackPath ||
          url.origin !== new URL(flow.redirectUri).origin ||
          url.hash ||
          [...new Set(url.searchParams.keys())].some(
            (name) => url.searchParams.getAll(name).length !== 1,
          ) ||
          !equalSecret(url.searchParams.get('state') ?? '', flow.state)
        )
          return reject();
        flow.consumed = true;
        const issuer = url.searchParams.get('iss');
        if (
          (issuer !== null && issuer !== preparation.issuer) ||
          (preparation.issuerRequired && issuer === null)
        ) {
          reject();
          this.finish(flow, 'failed', 'OAuth 응답 issuer가 로그인 요청과 일치하지 않습니다.');
          return;
        }
        const code = url.searchParams.get('code');
        if (
          url.searchParams.has('error') ||
          !code ||
          code.length > 4096 ||
          /[\x00-\x20\x7f]/.test(code)
        ) {
          res.statusCode = 400;
          res.end('OAuth login was not completed.');
          this.finish(flow, 'failed', 'OAuth 로그인이 승인되지 않았습니다.');
          return;
        }
        void this.serial(key, async () => {
          flow.controller.signal.throwIfAborted();
          const record = await this.exchange(
            preparation,
            new URLSearchParams({
              grant_type: 'authorization_code',
              code,
              redirect_uri: flow.redirectUri,
              code_verifier: flow.verifier,
            }),
            flow.controller.signal,
          );
          flow.controller.signal.throwIfAborted();
          await this.options.tokenStore.save(key, record);
          if (flow.controller.signal.aborted) {
            await this.options.tokenStore.remove(key);
            return;
          }
          res.end('Login completed. You can close this window.');
          this.finish(flow, 'completed');
        }).catch((error: unknown) => {
          if (!res.writableEnded) {
            res.statusCode = 400;
            res.end('OAuth login could not be completed.');
          }
          if (flow.status.status === 'pending')
            this.finish(flow, 'failed', safeError(error).message);
        });
      });
      server.requestTimeout = 10000;
      server.headersTimeout = 10000;
      server.maxConnections = 16;
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
          server.removeListener('error', reject);
          resolve();
        });
      });
      server.on('error', () => {
        const flow = this.flows.get(preparation.id);
        if (flow?.status.status === 'pending')
          this.finish(flow, 'failed', 'OAuth callback 연결이 종료되었습니다.');
      });
      if (this.closed || this.beginning.get(key) !== preparation.id) {
        server.close();
        fail('CANCELLED', 'OAuth 로그인 시작이 취소되었습니다.');
      }
      this.beginning.delete(key);
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        fail('CALLBACK', 'OAuth callback 주소를 열 수 없습니다.');
      }
      const redirectUri = `http://127.0.0.1:${address.port}${callbackPath}`;
      const expiresAt = this.now() + this.ttl;
      const timer = setTimeout(() => {
        const flow = this.flows.get(preparation.id);
        if (flow?.status.status === 'pending') this.finish(flow, 'expired');
      }, this.ttl);
      timer.unref();
      const flow: Flow = {
        preview: preparation,
        status: { id: preparation.id, status: 'pending', expiresAt },
        state,
        verifier,
        redirectUri,
        server,
        timer,
        controller: new AbortController(),
        consumed: false,
      };
      this.flows.set(preparation.id, flow);
      const authorization = new URL(preparation.authorizationEndpoint);
      authorization.search = new URLSearchParams({
        response_type: 'code',
        client_id: preparation.clientId,
        redirect_uri: redirectUri,
        state,
        code_challenge: createHash('sha256').update(verifier).digest('base64url'),
        code_challenge_method: 'S256',
        resource: preparation.resourceUrl,
        ...(preparation.scopes.length ? { scope: preparation.scopes.join(' ') } : {}),
      }).toString();
      return { id: preparation.id, authorizationUrl: authorization.href, redirectUri, expiresAt };
    } catch (error) {
      throw safeError(error);
    }
  }
  private finish(flow: Flow, status: Exclude<OAuthStatus['status'], 'pending'>, error?: string) {
    if (flow.status.status !== 'pending') return;
    flow.status = { ...flow.status, status, ...(error ? { error } : {}) };
    flow.state = '';
    flow.verifier = '';
    clearTimeout(flow.timer);
    flow.controller.abort();
    flow.server.close();
    // Bound malformed clients retaining an open callback connection after completion.
    const timer = setTimeout(() => flow.server.closeAllConnections(), 250);
    timer.unref();
  }
  status(id: string): OAuthStatus {
    this.trim();
    const flow = this.flows.get(id);
    if (!flow) fail('NOT_FOUND', 'OAuth 로그인 요청을 찾을 수 없습니다.');
    return { ...flow.status };
  }
  cancel(id: string): OAuthStatus {
    const flow = this.flows.get(id);
    if (!flow) fail('NOT_FOUND', 'OAuth 로그인 요청을 찾을 수 없습니다.');
    this.finish(flow, 'cancelled');
    return this.status(id);
  }
  private serial<T>(key: string, action: () => Promise<T>): Promise<T> {
    const result = (this.queues.get(key) ?? Promise.resolve()).catch(() => undefined).then(action);
    this.queues.set(key, result);
    void result
      .finally(() => {
        if (this.queues.get(key) === result) this.queues.delete(key);
      })
      .catch(() => undefined);
    return result;
  }
  private async exchange(
    expected: OAuthBinding & { issuer: string; tokenEndpoint: string; scopes: string[] },
    params: URLSearchParams,
    signal: AbortSignal,
    previousRefresh?: string,
  ): Promise<OAuthTokenRecord> {
    params.set('client_id', expected.clientId);
    params.set('resource', expected.resourceUrl);
    const response = await this.json(
      expected.tokenEndpoint,
      {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: params.toString(),
      },
      signal,
    );
    if (
      !response ||
      typeof response.token_type !== 'string' ||
      response.token_type.toLowerCase() !== 'bearer'
    )
      fail('TOKEN', 'OAuth 서버가 Bearer 토큰을 반환하지 않았습니다.');
    if (response.iss !== undefined && response.iss !== expected.issuer)
      fail('ISSUER', 'OAuth 토큰 응답 issuer가 일치하지 않습니다.');
    if (response.resource !== undefined && response.resource !== expected.resourceUrl)
      fail('RESOURCE', 'OAuth 토큰 응답 resource가 일치하지 않습니다.');
    if (
      response.expires_in !== undefined &&
      (typeof response.expires_in !== 'number' ||
        !Number.isSafeInteger(response.expires_in) ||
        response.expires_in <= 0 ||
        response.expires_in > 31536000)
    )
      fail('TOKEN', 'OAuth 토큰의 유효 시간을 확인할 수 없습니다.');
    if (
      response.scope !== undefined &&
      (typeof response.scope !== 'string' || response.scope.length > 16384)
    )
      fail('SCOPE', 'OAuth scope 응답 형식이 올바르지 않습니다.');
    const grantedScopes =
      response.scope === undefined
        ? expected.scopes
        : scopes(response.scope ? (response.scope as string).split(' ') : []);
    if (grantedScopes.some((scope) => !expected.scopes.includes(scope)))
      fail('SCOPE', '승인한 범위를 벗어난 OAuth scope가 반환되었습니다.');
    const refreshToken = response.refresh_token ?? previousRefresh;
    return validateOAuthTokenRecord(
      {
        version: 1,
        resourceUrl: expected.resourceUrl,
        clientId: expected.clientId,
        issuer: expected.issuer,
        tokenEndpoint: expected.tokenEndpoint,
        accessToken: response.access_token,
        ...(refreshToken === undefined ? {} : { refreshToken }),
        scopes: grantedScopes,
        expiresAt:
          response.expires_in === undefined
            ? null
            : this.now() + (response.expires_in as number) * 1000,
      },
      expected,
    );
  }
  async accessToken(input: OAuthBinding, signal?: AbortSignal): Promise<string | null> {
    this.assertOpen();
    const selected = binding(input),
      key = oauthTokenKey(selected);
    const generation = this.generations.get(key) ?? 0;
    return this.serial(key, async () => {
      try {
        this.assertOpen();
        signal?.throwIfAborted();
        const saved = await this.options.tokenStore.load(key);
        if ((this.generations.get(key) ?? 0) !== generation)
          fail('CANCELLED', 'OAuth 연결이 해제되었습니다.');
        this.assertOpen();
        signal?.throwIfAborted();
        if (saved === undefined || saved === null) return null;
        const record = validateOAuthTokenRecord(saved, selected);
        if (record.expiresAt === null || record.expiresAt > this.now() + 30000)
          return record.accessToken;
        if (!record.refreshToken)
          fail('EXPIRED', 'OAuth 토큰이 만료되었습니다. 다시 로그인하세요.');
        const controller = new AbortController();
        this.refreshControllers.set(key, controller);
        try {
          const combined = AbortSignal.any([controller.signal, ...(signal ? [signal] : [])]);
          const refreshed = await this.exchange(
            record,
            new URLSearchParams({
              grant_type: 'refresh_token',
              refresh_token: record.refreshToken,
            }),
            combined,
            record.refreshToken,
          );
          combined.throwIfAborted();
          await this.options.tokenStore.save(key, refreshed);
          if (combined.aborted) {
            await this.options.tokenStore.remove(key);
            combined.throwIfAborted();
          }
          return refreshed.accessToken;
        } catch (error) {
          // A rotating refresh token may already have been consumed. Do not replay it.
          await this.options.tokenStore.remove(key);
          throw error;
        } finally {
          this.refreshControllers.delete(key);
        }
      } catch (error) {
        throw safeError(error);
      }
    });
  }
  async disconnect(input: OAuthBinding): Promise<void> {
    const selected = binding(input),
      key = oauthTokenKey(selected);
    this.generations.set(key, (this.generations.get(key) ?? 0) + 1);
    this.beginning.delete(key);
    for (const flow of this.flows.values())
      if (oauthTokenKey(flow.preview) === key) this.finish(flow, 'cancelled');
    for (const [id, preparation] of this.preparations)
      if (oauthTokenKey(preparation) === key) this.preparations.delete(id);
    this.refreshControllers.get(key)?.abort();
    try {
      await this.serial(key, () => this.options.tokenStore.remove(key));
    } catch (error) {
      throw safeError(error);
    }
  }
  async close(): Promise<void> {
    this.closed = true;
    this.preparations.clear();
    this.beginning.clear();
    for (const flow of this.flows.values()) this.finish(flow, 'cancelled');
    for (const controller of this.refreshControllers.values()) controller.abort();
    await Promise.allSettled([...this.queues.values()]);
  }
}
