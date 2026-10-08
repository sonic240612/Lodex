import { describe, expect, it, vi } from 'vitest';
import type { McpContextAttachment } from '@lodex/contracts';
import { validateConfig, type McpRegistration } from '@lodex/mcp';
import { McpResourceSubscriptions } from './mcp-subscriptions';

function fixture(supported = true) {
  const manager = new McpResourceSubscriptions(),
    operation = new AbortController(),
    shutdown = new AbortController();
  const registration: McpRegistration = {
    id: crypto.randomUUID(),
    revision: 'a'.repeat(64),
    config: validateConfig({
      name: 'Fixture',
      transport: 'http',
      protocol: 'legacy',
      url: 'http://127.0.0.1:8888/mcp',
    }),
    server: null,
    protocol: '2025-11-25',
    tools: [],
    inspectedAt: new Date().toISOString(),
    ...(supported ? { supportsResourceSubscriptions: true } : {}),
  };
  const attachment: McpContextAttachment = {
    id: crypto.randomUUID(),
    serverId: registration.id,
    serverRevision: registration.revision,
    kind: 'resource',
    entryKey: 'fixture://reviewed',
    entryRevision: 'b'.repeat(64),
    text: 'Reviewed content',
    bytes: 16,
    sha256: 'c'.repeat(64),
    readAt: new Date().toISOString(),
  };
  const connection = {
    subscribeResource: vi.fn(async () => {}),
    unsubscribeResource: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  };
  let notify: (event: {
    kind: 'updated' | 'catalog_changed' | 'disconnected';
    uri?: string;
  }) => void = () => {};
  let lifetime: AbortSignal | undefined;
  const connect = vi.fn(async (signal: AbortSignal, onEvent: typeof notify) => {
    lifetime = signal;
    notify = onEvent;
    return connection;
  });
  const options = {
    sessionId: crypto.randomUUID(),
    attachment,
    registration,
    signal: operation.signal,
    shutdown: shutdown.signal,
    connect,
  };
  return {
    manager,
    connection,
    operation,
    shutdown,
    options,
    connect,
    notify: (event: Parameters<typeof notify>[0]) => notify(event),
    lifetime: () => lifetime,
  };
}

describe('MCP notification subscription lifetime', () => {
  it('retains reviewed text, ignores other URIs, and does not let a completed request timeout end a watch', async () => {
    const f = fixture(),
      before = structuredClone(f.options.attachment);
    await f.manager.subscribe(f.options);
    f.operation.abort();
    expect(f.lifetime()?.aborted).toBe(false);
    f.notify({ kind: 'updated', uri: 'fixture://unreviewed' });
    expect(f.manager.snapshot(f.options.sessionId)[0]?.status).toBe('watching');
    f.notify({ kind: 'updated', uri: before.entryKey });
    expect(f.manager.snapshot(f.options.sessionId)[0]).toMatchObject({
      status: 'changed',
      notifications: 1,
    });
    expect(f.options.attachment).toEqual(before);
    await f.manager.unsubscribe(f.options.sessionId, before.id);
    expect(f.lifetime()?.aborted).toBe(true);
    expect(f.connection.unsubscribeResource).toHaveBeenCalledOnce();
    expect(f.connection.close).toHaveBeenCalledOnce();
    f.notify({ kind: 'updated', uri: before.entryKey });
    expect(f.manager.snapshot(f.options.sessionId)).toEqual([]);
  });
  it('does not connect when subscribe is unsupported and rejects unreviewed server registrations', async () => {
    const f = fixture(false);
    expect(await f.manager.subscribe(f.options)).toMatchObject([{ status: 'unsupported' }]);
    expect(f.connect).not.toHaveBeenCalled();
    await expect(
      f.manager.subscribe({
        ...f.options,
        attachment: { ...f.options.attachment, serverRevision: 'd'.repeat(64) },
      }),
    ).rejects.toMatchObject({ code: 'MCP_CHANGED' });
    await expect(
      f.manager.subscribe({
        ...f.options,
        attachment: { ...f.options.attachment, kind: 'prompt' },
      }),
    ).rejects.toMatchObject({ code: 'MCP_SUBSCRIBE_RESOURCE' });
    await f.manager.close();
  });
  it('closes failed/cancelled subscriptions without retrying uncertain RPCs', async () => {
    const f = fixture();
    f.connection.subscribeResource.mockImplementation(async () => {
      f.operation.abort();
      f.operation.signal.throwIfAborted();
    });
    await expect(f.manager.subscribe(f.options)).rejects.toMatchObject({ name: 'AbortError' });
    expect(f.connection.subscribeResource).toHaveBeenCalledOnce();
    expect(f.connection.close).toHaveBeenCalledOnce();
    expect(f.lifetime()?.aborted).toBe(true);
    expect(f.manager.snapshot(f.options.sessionId)[0]?.status).toBe('disconnected');
    f.connection.unsubscribeResource.mockRejectedValue(new Error('Unknown result'));
    await f.manager.close();
    expect(f.connection.unsubscribeResource).toHaveBeenCalledOnce();
    expect(f.manager.snapshot(f.options.sessionId)).toEqual([]);
  });
  it('requires explicit reconnection and cleans all sessions when a registered server is removed', async () => {
    const f = fixture();
    await f.manager.subscribe(f.options);
    await f.manager.subscribe(f.options);
    expect(f.connect).toHaveBeenCalledOnce();
    f.notify({ kind: 'disconnected' });
    expect(f.manager.snapshot(f.options.sessionId)[0]?.status).toBe('disconnected');
    expect(f.connect).toHaveBeenCalledOnce();
    await f.manager.subscribe(f.options);
    expect(f.connect).toHaveBeenCalledTimes(2);
    await f.manager.removeServer(f.options.registration.id);
    expect(f.lifetime()?.aborted).toBe(true);
    expect(f.manager.snapshot(f.options.sessionId)).toEqual([]);
    expect(new McpResourceSubscriptions().snapshot(f.options.sessionId)).toEqual([]);
  });
  it('stops on daemon shutdown and rejects new work after close', async () => {
    const f = fixture();
    await f.manager.subscribe(f.options);
    f.shutdown.abort();
    expect(f.lifetime()?.aborted).toBe(true);
    await f.manager.close();
    expect(f.connection.close).toHaveBeenCalledOnce();
    await expect(f.manager.subscribe(f.options)).rejects.toMatchObject({ code: 'SHUTTING_DOWN' });
  });
});
