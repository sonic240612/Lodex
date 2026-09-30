import { lookup, type LookupAddress, type LookupAllOptions } from 'node:dns';
import { isIP, type LookupFunction } from 'node:net';
import ipaddr from 'ipaddr.js';
import { Agent, fetch as undiciFetch, type RequestInit as UndiciRequestInit } from 'undici';
import { AppError } from '@lodex/contracts';

export type WebResolver = (
  host: string,
  options: LookupAllOptions,
  callback: (error: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void,
) => void;

export function isPublicWebAddress(address: string): boolean {
  if (!isIP(address)) return false;
  const parsed = ipaddr.parse(address);
  if (parsed.range() !== 'unicast') return false;
  if (parsed.kind() === 'ipv4') return true;
  // Only native global IPv6: mapped, transition, local, and special-purpose ranges are excluded.
  return parsed.match(ipaddr.parseCIDR('2000::/3')) && !parsed.match(ipaddr.parseCIDR('2001::/23'));
}

export function publicWebUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AppError('WEB_URL', '올바른 공개 HTTP(S) URL이 필요합니다.');
  }
  const host = url.hostname
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '')
    .toLowerCase();
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.port ||
    url.username ||
    url.password ||
    /[\x00-\x20\x7f]/.test(value) ||
    url.href.length > 2048 ||
    (isIP(host)
      ? !isPublicWebAddress(host)
      : !host.includes('.') ||
        /(?:^|\.)(?:localhost|local|internal|invalid|test|onion)$/.test(host))
  )
    throw new AppError(
      'WEB_URL_DENIED',
      '웹 조회는 인증 정보가 없는 공개 HTTP(S) 주소와 기본 포트만 지원합니다. 사설·로컬 주소는 사용할 수 없습니다.',
    );
  url.hash = '';
  return url;
}

export function createPublicWebLookup(resolve: WebResolver = lookup): LookupFunction {
  return (host, options, callback) => {
    resolve(host, { ...options, all: true }, (error, addresses) => {
      if (error) {
        callback(error, '', 0);
        return;
      }
      if (!addresses.length || addresses.some((item) => !isPublicWebAddress(item.address))) {
        callback(
          new AppError('WEB_ADDRESS_DENIED', '웹 주소의 DNS가 사설 또는 예약 IP를 반환했습니다.'),
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

export function createPublicWebDispatcher(resolve?: WebResolver): Agent {
  return new Agent({
    connect: { lookup: createPublicWebLookup(resolve), timeout: 10000 },
    autoSelectFamily: true,
    keepAliveTimeout: 1000,
  });
}

// The socket's own lookup enforces the boundary, avoiding a second unchecked DNS lookup.
// This dispatcher does not use environment proxies, cookies, or application credentials.
const dispatcher = createPublicWebDispatcher();
export const publicWebFetch = async (url: string, init: RequestInit): Promise<Response> =>
  (await undiciFetch(url, { ...init, dispatcher } as UndiciRequestInit)) as unknown as Response;
