import { describe, expect, it } from 'vitest';
import { importMcpConfigurations } from './import';
describe('passive MCP imports', () => {
  it('converts common server maps and explicit dotenv references without launching', () => {
    const values = importMcpConfigurations(
      JSON.stringify({
        mcpServers: {
          remote: {
            url: 'https://example.com/mcp',
            headers: { Authorization: 'Bearer ${ENV:LODEX_MCP_TOKEN}' },
          },
          local: {
            command: process.execPath,
            args: ['missing-server.js'],
            env: { TOKEN: '${LODEX_MCP_LOCAL}' },
          },
        },
      }),
      process.cwd(),
    );
    expect(values.every((value) => value.config && !value.issues.length)).toBe(true);
    expect(values[0]!.config).toMatchObject({
      transport: 'http',
      headers: { Authorization: { secretRef: 'LODEX_MCP_TOKEN', prefix: 'Bearer ' } },
    });
    expect(values[1]!.config).toMatchObject({ transport: 'stdio', executable: process.execPath });
  });
  it('does not return inline credentials and does not silently drop unsupported settings', () => {
    for (const source of [
      { url: 'https://example.com/mcp', headers: { Authorization: 'private-key-fixture' } },
      { url: 'https://example.com/mcp', disabled: true },
      { url: 'https://example.com/mcp', oauth: {} },
      { command: 'npx', args: ['unreviewed-package'] },
    ]) {
      const values = importMcpConfigurations(JSON.stringify({ mcpServers: { fixture: source } }));
      expect(values[0]!.config).toBeNull();
      expect(values[0]!.issues.length).toBeGreaterThan(0);
      expect(JSON.stringify(values)).not.toContain('private-key-fixture');
    }
  });
});
