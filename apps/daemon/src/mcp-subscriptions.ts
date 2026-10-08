import {
  AppError,
  type McpContextAttachment,
  type McpResourceSubscription,
} from '@lodex/contracts';
import type { McpConnection, McpRegistration } from '@lodex/mcp';

type ResourceEvent = { kind: 'updated' | 'catalog_changed' | 'disconnected'; uri?: string };
type Connection = Pick<McpConnection, 'subscribeResource' | 'unsubscribeResource' | 'close'>;
type Active = {
  state: McpResourceSubscription;
  controller: AbortController;
  connection?: Connection;
};

/** Notifications carry no content. Reviewed attachments are never changed by this manager. */
export class McpResourceSubscriptions {
  private values = new Map<string, Active>();
  private closing = false;
  private key(sessionId: string, attachmentId: string) {
    return sessionId + ':' + attachmentId;
  }
  snapshot(sessionId: string) {
    return [...this.values.values()]
      .filter((item) => item.state.sessionId === sessionId)
      .map((item) => structuredClone(item.state));
  }

  async subscribe(options: {
    sessionId: string;
    attachment: McpContextAttachment;
    registration: McpRegistration;
    signal: AbortSignal;
    shutdown: AbortSignal;
    connect: (signal: AbortSignal, onEvent: (event: ResourceEvent) => void) => Promise<Connection>;
  }) {
    const { attachment, registration, sessionId } = options;
    options.signal.throwIfAborted();
    if (this.closing) throw new AppError('SHUTTING_DOWN', '앱을 종료하는 중입니다.', 503);
    if (attachment.kind === 'prompt')
      throw new AppError(
        'MCP_SUBSCRIBE_RESOURCE',
        '프롬프트는 리소스 변경 알림을 지원하지 않습니다.',
      );
    if (
      attachment.serverId !== registration.id ||
      attachment.serverRevision !== registration.revision
    )
      throw new AppError(
        'MCP_CHANGED',
        '첨부 자료의 서버 등록이 변경되었습니다. 다시 미리 보고 첨부하세요.',
        409,
      );
    const uri = attachment.kind === 'resource' ? attachment.entryKey : attachment.resolvedUri;
    if (!uri) throw new AppError('MCP_SUBSCRIBE_RESOURCE', '첨부한 자료의 URI를 찾을 수 없습니다.');
    const key = this.key(sessionId, attachment.id),
      existing = this.values.get(key);
    if (existing && ['watching', 'changed'].includes(existing.state.status))
      return this.snapshot(sessionId);
    if (existing) await this.stop(key);
    if (this.values.size >= 8)
      throw new AppError(
        'MCP_SUBSCRIBE_LIMIT',
        '동시에 최대 8개 자료의 변경 알림을 받을 수 있습니다.',
        429,
      );
    const controller = new AbortController();
    const entry: Active = {
      controller,
      state: {
        sessionId,
        attachmentId: attachment.id,
        serverId: registration.id,
        uri,
        status: registration.supportsResourceSubscriptions ? 'watching' : 'unsupported',
        startedAt: new Date().toISOString(),
        notifications: 0,
      },
    };
    this.values.set(key, entry);
    if (!registration.supportsResourceSubscriptions) return this.snapshot(sessionId);
    const cancelled = () => controller.abort(options.signal.reason);
    options.signal.addEventListener('abort', cancelled, { once: true });
    try {
      const signal = AbortSignal.any([controller.signal, options.shutdown]);
      const connection = await options.connect(signal, (event) => {
        if (this.values.get(key) !== entry || controller.signal.aborted) return;
        if (event.kind === 'disconnected') entry.state.status = 'disconnected';
        else if (event.kind === 'catalog_changed' || event.uri === uri) {
          entry.state.status = 'changed';
          entry.state.changedAt = new Date().toISOString();
          entry.state.notifications = Math.min(1_000_000, entry.state.notifications + 1);
        }
      });
      entry.connection = connection;
      signal.throwIfAborted();
      await connection.subscribeResource({
        serverRevision: registration.revision,
        entryKey: attachment.entryKey,
        revision: attachment.entryRevision,
        kind: attachment.kind,
        uri,
        signal,
      });
      options.signal.throwIfAborted();
      return this.snapshot(sessionId);
    } catch (error) {
      entry.state.status = 'disconnected';
      controller.abort();
      await entry.connection?.close().catch(() => undefined);
      throw error;
    } finally {
      options.signal.removeEventListener('abort', cancelled);
    }
  }
  private async stop(key: string) {
    const entry = this.values.get(key);
    if (!entry) return;
    this.values.delete(key);
    try {
      await entry.connection?.unsubscribeResource(entry.state.uri, AbortSignal.timeout(5000));
    } catch {
      /* No retries: closing the owned connection also ends its subscriptions. */
    } finally {
      entry.controller.abort();
      await entry.connection?.close().catch(() => undefined);
    }
  }
  async unsubscribe(sessionId: string, attachmentId: string) {
    await this.stop(this.key(sessionId, attachmentId));
    return this.snapshot(sessionId);
  }
  async removeSession(sessionId: string) {
    await Promise.all(
      [...this.values]
        .filter(([, item]) => item.state.sessionId === sessionId)
        .map(([key]) => this.stop(key)),
    );
  }
  async removeServer(serverId: string) {
    await Promise.all(
      [...this.values]
        .filter(([, item]) => item.state.serverId === serverId)
        .map(([key]) => this.stop(key)),
    );
  }
  async close() {
    this.closing = true;
    await Promise.all([...this.values.keys()].map((key) => this.stop(key)));
  }
}
