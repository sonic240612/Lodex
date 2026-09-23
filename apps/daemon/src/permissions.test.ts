import { describe, expect, it } from 'vitest';
import { permissionDecision } from './permissions';

describe('permission policy', () => {
  it('asks for every project write in ask mode', () => {
    expect(permissionDecision('ask', { kind: 'file', paths: ['src/app.ts'] })).toMatchObject({
      action: 'prompt',
      risk: 'low',
    });
  });

  it('auto-approves ordinary files but not secret files', () => {
    expect(permissionDecision('auto', { kind: 'file', paths: ['src/app.ts'] }).action).toBe(
      'allow',
    );
    expect(permissionDecision('auto', { kind: 'file', paths: ['.env.local'] })).toMatchObject({
      action: 'prompt',
      risk: 'high',
    });
    expect(
      permissionDecision('auto', {
        kind: 'file',
        paths: ['src/obsolete.ts'],
        destructive: true,
      }),
    ).toMatchObject({ action: 'prompt', risk: 'high' });
  });

  it.each([
    ['npm test', 'none', 'allow'],
    ['git reset --hard HEAD', 'none', 'prompt'],
    ['Remove-Item -Recurse .\\dist', 'none', 'prompt'],
    ['npm install', 'bridge', 'prompt'],
    ['python -c "import os; os.remove(\'a\')"', 'none', 'prompt'],
    ['npm test && echo done', 'none', 'prompt'],
  ] as const)('classifies Docker command %s', (command, network, action) => {
    expect(
      permissionDecision('auto', { kind: 'command', command, network, environment: 'docker' })
        .action,
    ).toBe(action);
  });

  it('only auto-approves MCP calls explicitly marked as closed-world reads', () => {
    expect(
      permissionDecision('auto', {
        kind: 'mcp',
        target: 'mcp_files_read',
        readOnly: true,
        destructive: false,
        openWorld: false,
      }).action,
    ).toBe('allow');
    expect(
      permissionDecision('auto', {
        kind: 'mcp',
        target: 'mcp_remote_write',
        readOnly: false,
        destructive: true,
        openWorld: true,
      }),
    ).toMatchObject({ action: 'prompt', risk: 'high' });
  });

  it('treats an edit and its validation command as one policy decision', () => {
    const safe = {
      kind: 'fusion' as const,
      paths: ['src/app.ts'],
      command: 'npm test',
      network: 'none' as const,
      environment: 'docker' as const,
    };
    expect(permissionDecision('ask', safe)).toMatchObject({
      kind: 'fusion',
      action: 'prompt',
      risk: 'low',
    });
    expect(permissionDecision('auto', safe)).toMatchObject({
      kind: 'fusion',
      action: 'allow',
      risk: 'low',
    });
    expect(permissionDecision('auto', { ...safe, command: 'npm test && rm -rf .' })).toMatchObject({
      action: 'prompt',
      risk: 'high',
    });
  });

  it('allows every classified action in full access and records high risk', () => {
    expect(
      permissionDecision('full', {
        kind: 'command',
        command: 'shutdown',
        network: 'bridge',
        environment: 'host',
      }),
    ).toMatchObject({ action: 'allow', mode: 'full', risk: 'high' });
  });
});
