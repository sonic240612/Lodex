import { afterEach, describe, expect, it, vi } from 'vitest';
import { McpOAuthManager } from './oauth';

const managers: McpOAuthManager[] = [];
afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.close();
});
function manager(fetcher: typeof fetch) {
  const value = new McpOAuthManager({
    tokenStore: { load: async () => undefined, save: async () => {}, remove: async () => {} },
    fetch: fetcher,
  });
  managers.push(value);
  return value;
}
const challenge = (url: string) =>
  new Response('', {
    status: 401,
    headers: { 'WWW-Authenticate': `Bearer resource_metadata="${url}"` },
  });
const json = (value: unknown) =>
  new Response(JSON.stringify(value), {
    headers: { 'Content-Type': 'application/json' },
  });

describe('OAuth discovery connection boundary', () => {
  it.each([
    'http://127.0.0.1:12345/metadata',
    'https://127.0.0.1/metadata',
    'https://10.1.2.3/metadata',
    'https://169.254.169.254/metadata',
    'https://[::1]/metadata',
    'https://[::ffff:127.0.0.1]/metadata',
    'https://localhost/metadata',
    'https://server.internal/metadata',
  ])('does not contact an unselected private metadata endpoint: %s', async (target) => {
    const fetcher = vi.fn<typeof fetch>(async () => challenge(target));
    await expect(
      manager(fetcher).prepare({ resourceUrl: 'https://mcp.example/mcp', clientId: 'public' }),
    ).rejects.toMatchObject({ code: 'MCP_OAUTH_DISCOVERY_ADDRESS' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('checks authorization server discovery before contacting a second private origin', async () => {
    const resourceUrl = 'https://mcp.example/mcp';
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(challenge('https://mcp.example/metadata'))
      .mockResolvedValueOnce(
        json({ resource: resourceUrl, authorization_servers: ['http://127.0.0.1:12345/auth'] }),
      );
    await expect(
      manager(fetcher).prepare({ resourceUrl, clientId: 'public' }),
    ).rejects.toMatchObject({ code: 'MCP_OAUTH_DISCOVERY_ADDRESS' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each([
    { resource: 'http://127.0.0.1:12345', issuer: 'http://127.0.0.1:12345' },
    { resource: 'https://mcp.example', issuer: 'https://auth.example:8443' },
  ])(
    'keeps selected local servers and public cross-origin OAuth working: $resource',
    async ({ resource, issuer }) => {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(challenge(resource + '/metadata'))
        .mockResolvedValueOnce(
          json({ resource: resource + '/mcp', authorization_servers: [issuer + '/issuer'] }),
        )
        .mockResolvedValueOnce(
          json({
            issuer: issuer + '/issuer',
            authorization_endpoint: issuer + '/authorize',
            token_endpoint: issuer + '/token',
            code_challenge_methods_supported: ['S256'],
            response_types_supported: ['code'],
            grant_types_supported: ['authorization_code'],
            token_endpoint_auth_methods_supported: ['none'],
          }),
        );
      const result = await manager(fetcher).prepare({
        resourceUrl: resource + '/mcp',
        clientId: 'public',
      });
      expect(result.issuer).toBe(issuer + '/issuer');
      expect(fetcher).toHaveBeenCalledTimes(3);
      expect(fetcher.mock.calls.every(([, init]) => init?.redirect === 'error')).toBe(true);
    },
  );
});
