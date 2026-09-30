import { describe, expect, it, vi } from 'vitest';
import { fetch as undiciFetch } from 'undici';
import {
  createPublicWebDispatcher,
  createPublicWebLookup,
  isPublicWebAddress,
  publicWebUrl,
  type WebResolver,
} from './web-network';

describe('public web connection boundary', () => {
  it.each([
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '192.168.1.1',
    '169.254.169.254',
    '100.114.148.69',
    '0.0.0.0',
    '224.0.0.1',
    '255.255.255.255',
    '192.0.2.1',
    '198.18.0.1',
    '::1',
    'fc00::1',
    'fe80::1',
    '2001:db8::1',
    '2002:7f00:1::',
    '::ffff:127.0.0.1',
    '64:ff9b::7f00:1',
    'not an IP',
  ])('rejects non-public address %s', (address) => {
    expect(isPublicWebAddress(address)).toBe(false);
  });

  it.each(['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '2001:4860:4860::8888'])(
    'accepts global unicast %s',
    (address) => {
      expect(isPublicWebAddress(address)).toBe(true);
    },
  );

  it.each([
    'http://127.0.0.1/',
    'http://2130706433/',
    'http://0x7f000001/',
    'http://[::ffff:127.0.0.1]/',
    'https://example.com:8080/',
    'https://user:pass@example.com/',
    'file:///tmp/example',
    'https://server.local/',
    'https://localhost/',
    'https://example.com/\npath',
  ])('denies disallowed URL %s', (url) => {
    expect(() => publicWebUrl(url)).toThrow();
  });

  it('canonicalizes URLs without sending fragments', () => {
    expect(publicWebUrl('https://EXAMPLE.com:443/docs?q=1#section').href).toBe(
      'https://example.com/docs?q=1',
    );
  });

  it('rejects mixed public/private DNS answers at the socket lookup', () => {
    const resolve: WebResolver = (_host, _options, callback) =>
      callback(null, [
        { address: '8.8.8.8', family: 4 },
        { address: '127.0.0.1', family: 4 },
      ]);
    const callback = vi.fn();
    createPublicWebLookup(resolve)('mixed.example.com', { all: true }, callback);
    expect(callback.mock.calls[0]?.[0]).toMatchObject({ code: 'WEB_ADDRESS_DENIED' });
  });

  it('returns the same validated addresses to the connection without another lookup', () => {
    const resolve: WebResolver = vi.fn((_host, _options, callback) =>
      callback(null, [{ address: '8.8.8.8', family: 4 }]),
    );
    const callback = vi.fn();
    createPublicWebLookup(resolve)('example.com', { all: true }, callback);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith(null, [{ address: '8.8.8.8', family: 4 }], 0);
  });

  it('prevents an actual Undici connection when DNS returns a local address', async () => {
    const resolve: WebResolver = (_host, _options, callback) =>
      callback(null, [{ address: '127.0.0.1', family: 4 }]);
    const dispatcher = createPublicWebDispatcher(resolve);
    try {
      await expect(
        undiciFetch('http://blocked.example.com/', { dispatcher }),
      ).rejects.toMatchObject({ cause: { code: 'WEB_ADDRESS_DENIED' } });
    } finally {
      await dispatcher.close();
    }
  });
});
