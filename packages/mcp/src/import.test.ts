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

  it('imports Codex TOML server tables and environment-backed HTTP headers', () => {
    const values = importMcpConfigurations(
      `
[mcp_servers.docs]
url = "https://example.com/mcp"
bearer_token_env_var = "LODEX_MCP_DOCS_TOKEN"
startup_timeout_sec = 10

[mcp_servers.local]
command = ${JSON.stringify(process.execPath)}
args = ["server.js"]
env_vars = ["LODEX_MCP_LOCAL_TOKEN"]
`,
      process.cwd(),
    );
    expect(values).toHaveLength(2);
    expect(values[0]).toMatchObject({
      name: 'docs',
      config: {
        transport: 'http',
        headers: {
          Authorization: { secretRef: 'LODEX_MCP_DOCS_TOKEN', prefix: 'Bearer ' },
        },
      },
      issues: [],
    });
    expect(values[0]!.warnings).toContain(
      'startup_timeout_sec: Lodex의 공통 실행 제한과 대화별 도구 선택을 사용합니다.',
    );
    expect(values[1]).toMatchObject({
      name: 'local',
      config: {
        transport: 'stdio',
        executable: process.execPath,
        args: ['server.js'],
        env: {
          LODEX_MCP_LOCAL_TOKEN: { secretRef: 'LODEX_MCP_LOCAL_TOKEN', prefix: '' },
        },
      },
      issues: [],
    });
  });

  it('imports OpenCode JSONC v1 and v2 command arrays, comments and env references', () => {
    const cwd = process.cwd();
    const values = importMcpConfigurations(
      `{
        // OpenCode v2 layout
        "mcp": { "servers": {
          "local": {
            "type": "local",
            "command": [${JSON.stringify(process.execPath)}, "fixture.js"],
            "cwd": ".",
            "environment": { "TOKEN": "{env:LODEX_MCP_LOCAL}" },
          },
          "remote": {
            "type": "remote",
            "url": "https://example.com/mcp",
            "headers": { "Authorization": "Bearer \${LODEX_MCP_REMOTE}" }
          }
        }}
      }`,
      cwd,
    );
    expect(values[0]).toMatchObject({
      config: {
        executable: process.execPath,
        args: ['fixture.js'],
        cwd,
        env: { TOKEN: { secretRef: 'LODEX_MCP_LOCAL', prefix: '' } },
      },
      issues: [],
    });
    expect(values[1]).toMatchObject({
      config: {
        transport: 'http',
        headers: {
          Authorization: { secretRef: 'LODEX_MCP_REMOTE', prefix: 'Bearer ' },
        },
      },
      issues: [],
    });

    const v1 = importMcpConfigurations(
      JSON.stringify({
        mcp: {
          one: { type: 'remote', url: 'https://example.com/mcp', enabled: true },
        },
      }),
    );
    expect(v1[0]).toMatchObject({ name: 'one', config: { transport: 'http' }, issues: [] });
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
      expect(values[0]!.warnings).toEqual([]);
      expect(JSON.stringify(values)).not.toContain('private-key-fixture');
    }
  });
});
