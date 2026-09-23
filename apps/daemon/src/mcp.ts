import { AppError, type Activity, type McpSelection, type Session } from '@lodex/contracts';
import {
  McpConnection,
  definitionForModel,
  mcpToolName,
  type McpRegistration,
  type SecretResolver,
  type McpConfig,
  type Root,
  type CreateMessageRequestParams,
  type CreateMessageResult,
  type ElicitRequestParams,
  type ElicitResult,
} from '@lodex/mcp';

export function selectedMcpTools(session: Session, registrations: McpRegistration[]) {
  return (session.mcp ?? []).map((selection) => {
    const server = registrations.find((entry) => entry.id === selection.serverId);
    const tool = server?.tools.find((entry) => entry.name === selection.toolName);
    if (
      !server ||
      server.revision !== selection.serverRevision ||
      !tool?.supported ||
      tool.revision !== selection.toolRevision
    )
      throw new AppError(
        'MCP_CHANGED',
        '선택한 MCP 도구가 변경되거나 삭제되었습니다. MCP 목록에서 다시 검토하세요.',
        409,
      );
    return { selection, server, definition: definitionForModel(server, tool) };
  });
}
/** Connections belong to one run. No shared capabilities or automatic replay. */
export class RunMcp {
  private connections = new Map<string, McpConnection>();
  private tokens = new Map<string, string | undefined>();
  private sampling = new Map<
    string,
    (params: CreateMessageRequestParams, signal: AbortSignal) => Promise<CreateMessageResult>
  >();
  private elicitation = new Map<
    string,
    (params: ElicitRequestParams, signal: AbortSignal) => Promise<ElicitResult>
  >();
  constructor(
    private options: {
      selections: { selection: McpSelection; server: McpRegistration }[];
      supervisorPath: string;
      resolveSecret: SecretResolver;
      resolveOAuthToken?: (config: McpConfig, signal: AbortSignal) => Promise<string | undefined>;
      roots?: Root[];
    },
  ) {}
  permission(name: string) {
    const selected = this.options.selections.find(
      (value) => mcpToolName(value.server.id, value.selection.toolName) === name,
    );
    if (!selected) throw new AppError('MCP_TOOL', '이 대화에 허용되지 않은 MCP 도구입니다.', 403);
    const annotations = selected.server.tools.find(
      (tool) => tool.name === selected.selection.toolName,
    )?.definition.annotations;
    return {
      readOnly: annotations?.readOnlyHint === true,
      destructive: annotations?.destructiveHint === true,
      openWorld: annotations?.openWorldHint === true,
    };
  }
  async call(options: {
    name: string;
    argumentsJson: string;
    mode: 'plan' | 'build';
    signal: AbortSignal;
    maxBytes: number;
    record: (call: NonNullable<Activity['mcpCall']>) => Promise<void>;
    sampling?: (
      params: CreateMessageRequestParams,
      signal: AbortSignal,
    ) => Promise<CreateMessageResult>;
    elicitation?: (params: ElicitRequestParams, signal: AbortSignal) => Promise<ElicitResult>;
  }): Promise<string> {
    if (options.mode !== 'build')
      throw new AppError('MCP_PLAN', 'Plan 모드에서는 MCP 도구를 실행하지 않습니다.', 403);
    const selected = this.options.selections.find(
      (value) => mcpToolName(value.server.id, value.selection.toolName) === options.name,
    );
    if (!selected) throw new AppError('MCP_TOOL', '이 대화에 허용되지 않은 MCP 도구입니다.', 403);
    let args: Record<string, unknown>;
    try {
      if (Buffer.byteLength(options.argumentsJson) > 16384) throw new Error();
      const parsed: unknown = JSON.parse(options.argumentsJson);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
      args = parsed as Record<string, unknown>;
    } catch {
      throw new AppError('MCP_ARGUMENTS', 'MCP 인자는 16 KiB 이하의 JSON 객체여야 합니다.');
    }
    const audit: NonNullable<Activity['mcpCall']> = {
      ...selected.selection,
      status: 'running',
      startedAt: new Date().toISOString(),
    };
    await options.record(audit);
    if (options.sampling) this.sampling.set(selected.server.id, options.sampling);
    if (options.elicitation) this.elicitation.set(selected.server.id, options.elicitation);
    try {
      let connection = this.connections.get(selected.server.id);
      const oauthToken = await this.options.resolveOAuthToken?.(
        selected.server.config,
        options.signal,
      );
      if (connection && oauthToken !== this.tokens.get(selected.server.id)) {
        await connection.close();
        this.connections.delete(selected.server.id);
        connection = undefined;
      }
      if (!connection) {
        connection = await McpConnection.connect({
          config: selected.server.config,
          expected: selected.server,
          supervisorPath: this.options.supervisorPath,
          resolveSecret: this.options.resolveSecret,
          signal: options.signal,
          oauthToken,
          ...(this.options.roots ? { roots: this.options.roots } : {}),
          ...(options.sampling
            ? {
                sampling: (params: CreateMessageRequestParams, samplingSignal: AbortSignal) => {
                  const handler = this.sampling.get(selected.server.id);
                  if (!handler)
                    throw new AppError(
                      'MCP_SAMPLING_INACTIVE',
                      '현재 MCP 호출에 연결된 Sampling 요청이 아닙니다.',
                    );
                  return handler(params, samplingSignal);
                },
              }
            : {}),
          ...(options.elicitation
            ? {
                elicitation: (params: ElicitRequestParams, elicitationSignal: AbortSignal) => {
                  const handler = this.elicitation.get(selected.server.id);
                  if (!handler)
                    throw new AppError(
                      'MCP_ELICITATION_INACTIVE',
                      '현재 MCP 호출에 연결된 사용자 입력 요청이 아닙니다.',
                    );
                  return handler(params, elicitationSignal);
                },
              }
            : {}),
        });
        this.connections.set(selected.server.id, connection);
        this.tokens.set(selected.server.id, oauthToken);
      }
      options.signal.throwIfAborted();
      const result = await connection.call({
        name: selected.selection.toolName,
        revision: selected.selection.toolRevision,
        arguments: args,
        mode: options.mode,
        signal: options.signal,
        maxBytes: options.maxBytes,
      });
      await options.record({
        ...audit,
        status: result.isError ? 'failed' : 'completed',
        finishedAt: new Date().toISOString(),
      });
      return JSON.stringify(result);
    } catch (error) {
      const unknown =
        options.signal.aborted ||
        !(error instanceof AppError) ||
        error.code === 'MCP_OUTCOME_UNKNOWN';
      await options.record({
        ...audit,
        status: unknown ? 'unknown' : 'failed',
        finishedAt: new Date().toISOString(),
        error: unknown
          ? 'MCP 실행 결과를 확인하지 못했습니다. 서버 기록을 확인하세요.'
          : (error as AppError).message,
      });
      throw error;
    } finally {
      this.sampling.delete(selected.server.id);
      this.elicitation.delete(selected.server.id);
    }
  }
  async close() {
    const results = await Promise.allSettled(
      [...this.connections.values()].map((connection) => connection.close()),
    );
    this.connections.clear();
    this.tokens.clear();
    this.sampling.clear();
    this.elicitation.clear();
    if (results.some((result) => result.status === 'rejected'))
      throw new AppError(
        'MCP_CLOSE_UNKNOWN',
        'MCP 서버 종료를 확인하지 못했습니다. 실행 중인 프로세스를 확인하세요.',
      );
  }
}
