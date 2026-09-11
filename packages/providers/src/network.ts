import { lookup, type LookupAllOptions, type LookupAddress } from 'node:dns';
import type { LookupFunction } from 'node:net';
import { Agent, fetch as undiciFetch, type RequestInit as UndiciRequestInit } from 'undici';
import { AppError, isPrivateServerAddress } from '@lodex/contracts';

type Resolver = (
  host: string,
  options: LookupAllOptions,
  callback: (error: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void,
) => void;
export function createPrivateLookup(resolve: Resolver = lookup): LookupFunction {
  return (host, options, callback) => {
    resolve(host, { ...options, all: true }, (error, addresses) => {
      if (error) {
        callback(error, '', 0);
        return;
      }
      if (!addresses.length || addresses.some((item) => !isPrivateServerAddress(item.address))) {
        callback(
          new AppError(
            'SERVER_ADDRESS_DENIED',
            '서버 이름이 localhost·사설·Tailscale IP로 해석되지 않습니다.',
          ),
          '',
          0,
        );
        return;
      }
      if (options.all) callback(null, addresses, 0);
      else callback(null, addresses[0]!.address, addresses[0]!.family);
    });
  };
}
// Supplying this dispatcher bypasses environment proxies for private servers.
// DNS validation happens in the socket lookup itself, so there is no second
// unchecked lookup between validation and connection. TLS still uses the name.
export function createPrivateDispatcher(resolve?: Resolver): Agent {
  return new Agent({
    connect: { lookup: createPrivateLookup(resolve), timeout: 10000 },
    autoSelectFamily: true,
    keepAliveTimeout: 1000,
  });
}
const dispatcher = createPrivateDispatcher();
export function createPrivateFetch(agent: Agent) {
  return async (input: string, init: RequestInit): Promise<Response> => {
    // Keep fetch and dispatcher from the same version. Node's bundled Undici
    // can use a different dispatcher protocol. Both expose standard Web bodies.
    return (await undiciFetch(input, {
      ...init,
      dispatcher: agent,
    } as UndiciRequestInit)) as unknown as Response;
  };
}
export const privateServerFetch = createPrivateFetch(dispatcher);

export function connectionError(error: unknown, endpoint: string): AppError {
  const codes = new Set<string>();
  function visit(value: unknown, depth = 0): void {
    if (!value || typeof value !== 'object' || depth > 5) return;
    const item = value as { code?: unknown; name?: unknown; cause?: unknown; errors?: unknown[] };
    if (typeof item.code === 'string') codes.add(item.code);
    if (typeof item.name === 'string') codes.add(item.name);
    visit(item.cause, depth + 1);
    if (Array.isArray(item.errors)) for (const cause of item.errors) visit(cause, depth + 1);
  }
  visit(error);
  const any = (...values: string[]) => values.some((value) => codes.has(value));
  const origin = new URL(endpoint).origin;
  if (any('SERVER_ADDRESS_DENIED'))
    return new AppError(
      'SERVER_ADDRESS_DENIED',
      origin + ': DNS가 허용된 사설/Tailscale IP를 반환하지 않았습니다.',
      400,
    );
  if (any('ENOTFOUND', 'EAI_AGAIN'))
    return new AppError(
      'SERVER_DNS',
      origin +
        ': 서버 이름을 찾지 못했습니다. Tailscale 연결·MagicDNS를 확인하거나 서버의 Tailscale IP를 입력하세요.',
      502,
    );
  if (any('ECONNREFUSED'))
    return new AppError(
      'SERVER_REFUSED',
      origin + ': 연결이 거부되었습니다. llama-server가 이 주소와 포트에서 실행 중인지 확인하세요.',
      502,
    );
  if (any('EHOSTUNREACH', 'ENETUNREACH', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'TimeoutError'))
    return new AppError(
      'SERVER_UNREACHABLE',
      origin +
        ': 연결 시간이 초과되었거나 서버에 도달할 수 없습니다. Tailscale 연결·접근 규칙·방화벽·포트를 확인하세요.',
      502,
    );
  if ([...codes].some((code) => /CERT|TLS|SELF_SIGNED/.test(code)))
    return new AppError(
      'SERVER_TLS',
      origin +
        ': HTTPS 인증서를 검증하지 못했습니다. 인증서의 호스트 이름과 신뢰 설정을 확인하세요.',
      502,
    );
  return new AppError(
    'SERVER_CONNECTION',
    origin + ': 서버에 연결하지 못했습니다. 주소·포트·서버 실행 상태를 확인하세요.',
    502,
  );
}
