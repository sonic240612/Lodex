import { randomUUID } from 'node:crypto';
import {
  AppError,
  type McpContentInput,
  type McpContentPreview,
  type McpContextAttachment,
} from '@lodex/contracts';
import type { McpConnection } from '@lodex/mcp';

/** Review snapshots never refresh themselves or execute through the model tool loop. */
export class McpContentPreviews {
  private values = new Map<string, McpContentPreview>();
  private prune() {
    for (const [id, value] of this.values)
      if (Date.parse(value.expiresAt) <= Date.now()) this.values.delete(id);
  }
  async create(
    input: McpContentInput,
    connect: () => Promise<McpConnection>,
    signal: AbortSignal,
  ): Promise<McpContentPreview> {
    this.prune();
    if (this.values.size >= 8)
      throw new AppError(
        'MCP_PREVIEW_LIMIT',
        '열어 둔 미리보기가 많습니다. 대화에 첨부하거나 5분 후 다시 시도하세요.',
        429,
      );
    if (Object.keys(input.arguments ?? {}).length > 32)
      throw new AppError('MCP_ARGUMENTS', '프롬프트 인자는 32개 이하여야 합니다.');
    const connection = await connect();
    let snapshot: McpContentPreview;
    try {
      const common = {
        serverRevision: input.serverRevision,
        revision: input.entryRevision,
        signal,
        maxBytes: 24576,
      };
      const result =
        input.kind === 'resource'
          ? await connection.readResource({ ...common, uri: input.entryKey })
          : input.kind === 'resource_template'
            ? await connection.readResourceTemplate({
                ...common,
                uriTemplate: input.entryKey,
                arguments: input.arguments ?? {},
              })
            : await connection.getPrompt({
                ...common,
                name: input.entryKey,
                ...(input.arguments ? { arguments: input.arguments } : {}),
              });
      snapshot = {
        id: randomUUID(),
        ...result.provenance,
        text: result.text,
        expiresAt: new Date(Date.now() + 300000).toISOString(),
      };
    } finally {
      await connection.close();
    }
    signal.throwIfAborted();
    this.values.set(snapshot.id, snapshot);
    return structuredClone(snapshot);
  }
  get(id: string): McpContextAttachment {
    this.prune();
    const value = this.values.get(id);
    if (!value)
      throw new AppError(
        'MCP_PREVIEW_EXPIRED',
        'MCP 미리보기가 만료되었습니다. 내용을 다시 확인하세요.',
        409,
      );
    const { expiresAt: _expires, ...attachment } = value;
    return structuredClone(attachment);
  }
  consume(id: string) {
    this.values.delete(id);
  }
}
