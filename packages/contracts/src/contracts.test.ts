import { describe, expect, it } from 'vitest';
import {
  commandSchema,
  defaultModelConfig,
  localUrlSchema,
  makeCommand,
  modelConfigSchema,
  planSchema,
} from './index';
describe('command boundary', () => {
  it('requires a local provider and matching version reference for managed models', () => {
    const managedModelId = crypto.randomUUID();
    expect(modelConfigSchema.safeParse({ managedModelId }).success).toBe(false);
    expect(modelConfigSchema.safeParse({ managedModelVersion: 1 }).success).toBe(false);
    expect(
      modelConfigSchema.safeParse({
        provider: 'openrouter',
        managedModelId,
        managedModelVersion: 1,
      }).success,
    ).toBe(false);
    expect(
      modelConfigSchema.safeParse({
        provider: 'llama-server',
        managedModelId,
        managedModelVersion: 1,
      }).success,
    ).toBe(true);
  });
  it('rejects unknown protocol versions and injected fields', () => {
    const command = makeCommand({
      type: 'create_session',
      sessionId: crypto.randomUUID(),
      title: '테스트',
      config: defaultModelConfig(),
    });
    expect(commandSchema.safeParse({ ...command, protocolVersion: 2 }).success).toBe(false);
    expect(commandSchema.safeParse({ ...command, shell: 'anything' }).success).toBe(false);
    expect(commandSchema.safeParse({ ...command, actor: 'telegram' }).success).toBe(false);
  });
  it('rejects out-of-range generation settings and duplicate task IDs', () => {
    expect(modelConfigSchema.safeParse({ temperature: -1 }).success).toBe(false);
    expect(modelConfigSchema.safeParse({ maxTokens: 1.5 }).success).toBe(false);
    expect(modelConfigSchema.safeParse({ topP: 0 }).success).toBe(false);
    const task = { id: crypto.randomUUID(), title: '할 일', done: false };
    expect(planSchema.safeParse({ goal: '', tasks: [task, task] }).success).toBe(false);
  });
  it.each([
    'http://example.com/v1',
    'http://127.0.0.1.evil.com/v1',
    'file:///tmp/model',
    'http://user:password@localhost/v1',
    'http://localhost/v1?key=secret',
    'http://0.0.0.0:8080/v1',
    'http://[::]:8080/v1',
    'http://100.63.255.255:8080/v1',
    'http://100.128.0.1:8080/v1',
    'http://169.254.169.254/v1',
    'https://gpu.example.ts.net.evil.com/v1',
  ])('rejects unsupported or credential-bearing endpoint %s', (url) => {
    expect(localUrlSchema.safeParse(url).success).toBe(false);
  });
  it.each([
    'http://127.0.0.1:8080/v1',
    'http://localhost:8080/v1',
    'http://[::1]:8080/v1',
    'https://localhost/v1',
    'http://100.64.0.1:8080/v1',
    'http://100.127.255.254:8080/v1',
    'http://[fd7a:115c:a1e0::1234]:8080/v1',
    'http://gpu-box:8080/v1',
    'https://gpu-box.tailnet.ts.net/v1',
    'http://192.168.1.2:8080/v1',
    'http://10.0.0.2:8080/v1',
    'http://172.16.0.2:8080/v1',
  ])('allows private server %s', (url) => expect(localUrlSchema.safeParse(url).success).toBe(true));
  it('normalizes a server root and trailing slashes without replacing its Tailscale host', () => {
    expect(localUrlSchema.parse(' http://100.75.2.3:8080 ')).toBe('http://100.75.2.3:8080/v1');
    expect(localUrlSchema.parse('https://gpu.tailnet.ts.net/llama/v1/')).toBe(
      'https://gpu.tailnet.ts.net/llama/v1',
    );
  });
});
