import { z } from 'zod';

/** Shared by URL validation and the provider's actual socket DNS lookup. */
export function isPrivateServerAddress(value: string): boolean {
  const address = value.toLowerCase().replace(/^\[|\]$/g, '');
  if (address === '::1' || /^fd7a:115c:a1e0:/.test(address)) return true;
  const parts = address.split('.');
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255))
    return false;
  const [a, b] = parts.map(Number);
  return (
    a === 127 ||
    a === 10 ||
    (a === 172 && b! >= 16 && b! <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b! >= 64 && b! <= 127)
  );
}
function allowedHostname(host: string): boolean {
  if (isPrivateServerAddress(host)) return true;
  // MagicDNS accepts a machine name or its full *.ts.net name. DNS answers are
  // checked by the socket connector; a matching name alone does not grant access.
  const name = host.replace(/\.$/, '');
  const labels = name.split('.');
  const valid = labels.every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label));
  return valid && (labels.length === 1 || (labels.length >= 4 && name.endsWith('.ts.net')));
}
export const localUrlSchema = z
  .string()
  .trim()
  .max(8192)
  .pipe(z.url())
  .superRefine((value, ctx) => {
    const url = new URL(value);
    let message: string | undefined;
    if (url.hostname === '0.0.0.0' || url.hostname === '[::]')
      message =
        '0.0.0.0과 ::는 서버의 수신 주소입니다. 접속할 서버의 Tailscale IP·호스트 이름 또는 localhost를 입력하세요.';
    else if (!['http:', 'https:'].includes(url.protocol) || !allowedHostname(url.hostname))
      message =
        'llama-server는 localhost·사설 IP·Tailscale IP/MagicDNS의 HTTP(S) 주소를 입력하세요.';
    else if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      /[\x00-\x1f\x7f]/.test(value)
    )
      message = '서버 URL에는 사용자 정보·쿼리·해시·제어 문자를 넣을 수 없습니다.';
    if (message) ctx.addIssue({ code: 'custom', message });
  })
  .transform((value) => {
    const url = new URL(value);
    url.pathname = url.pathname === '/' ? '/v1' : url.pathname.replace(/\/+$/, '');
    return url.toString().replace(/\/$/, '');
  });
