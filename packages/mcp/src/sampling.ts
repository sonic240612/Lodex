import {
  AppError,
  type InferenceMessage,
  type InferenceRequest,
  type ToolCall,
  type ToolDefinition,
} from '@lodex/contracts';
import type {
  CreateMessageRequestParams,
  CreateMessageResultWithTools,
  JsonSchemaType,
} from '@modelcontextprotocol/client';
import { createMcpValidator } from './schema';

function fail(message: string): never {
  throw new AppError('MCP_SAMPLING_INPUT', message);
}
const identifier = /^[a-zA-Z0-9_-]{1,128}$/;
const callIdentifier = /^[^\x00-\x20\x7f]{1,200}$/;

/** Server-supplied tools are returned to that server, never executed as Lodex tools. */
export function prepareSampling(
  params: CreateMessageRequestParams,
): Pick<InferenceRequest, 'messages' | 'tools' | 'toolChoice' | 'stopSequences'> {
  if (!Array.isArray(params.messages) || !params.messages.length || params.messages.length > 64)
    fail('MCP 모델 요청 메시지는 1~64개여야 합니다.');
  if (Buffer.byteLength(JSON.stringify(params)) > 131072)
    fail('MCP 모델 요청이 128 KiB를 초과했습니다.');
  if (params.tools && params.tools.length > 64) fail('MCP 모델 요청의 도구 수가 너무 많습니다.');
  const validator = createMcpValidator();
  const names = new Set<string>();
  const tools: ToolDefinition[] = (params.tools ?? []).map((tool) => {
    if (!identifier.test(tool.name) || names.has(tool.name))
      fail('MCP 모델 요청에 중복되거나 지원하지 않는 도구 이름이 있습니다.');
    names.add(tool.name);
    validator.getValidator(tool.inputSchema as JsonSchemaType);
    return {
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description ?? '',
        parameters: tool.inputSchema,
      },
    };
  });
  if (params.toolChoice?.mode && !['auto', 'required', 'none'].includes(params.toolChoice.mode))
    fail('MCP 모델 요청의 도구 선택 방식이 올바르지 않습니다.');
  if (!tools.length && params.toolChoice?.mode === 'required')
    fail('필수 도구 호출을 요청했지만 도구가 없습니다.');
  if (
    params.stopSequences &&
    (params.stopSequences.length > 4 ||
      params.stopSequences.some(
        (stop) => typeof stop !== 'string' || !stop.length || Buffer.byteLength(stop) > 1024,
      ))
  )
    fail('종료 문자열은 비어 있지 않은 1 KiB 이하 문자열을 최대 4개 지정할 수 있습니다.');
  const messages: InferenceMessage[] = [];
  const used = new Set<string>();
  let pending = new Set<string>();
  for (const message of params.messages) {
    if (message.role !== 'user' && message.role !== 'assistant') fail('잘못된 메시지 역할입니다.');
    const blocks = Array.isArray(message.content) ? message.content : [message.content];
    if (!blocks.length) fail('빈 MCP 메시지입니다.');
    if (pending.size) {
      if (message.role !== 'user' || blocks.some((block) => block.type !== 'tool_result'))
        fail('도구 호출 바로 뒤에는 해당 도구의 결과만 있어야 합니다.');
      for (const block of blocks) {
        if (block.type !== 'tool_result' || !pending.delete(block.toolUseId))
          fail('도구 결과가 중복되었거나 대응하는 호출이 없습니다.');
        if (block.content.some((content) => content.type !== 'text'))
          fail('현재 MCP 도구 결과는 텍스트만 지원합니다.');
        messages.push({
          role: 'tool',
          toolCallId: block.toolUseId,
          content: block.content
            .map((content) => (content.type === 'text' ? content.text : ''))
            .join('\n'),
          ...(block.isError ? { isError: true } : {}),
        });
      }
      if (pending.size) fail('일부 도구 호출의 결과가 없습니다.');
      continue;
    }
    let content = '';
    const toolCalls: ToolCall[] = [];
    for (const block of blocks) {
      if (block.type === 'text') content += (content ? '\n' : '') + block.text;
      else if (block.type === 'tool_use') {
        if (
          message.role !== 'assistant' ||
          !callIdentifier.test(block.id) ||
          used.has(block.id) ||
          !names.has(block.name)
        )
          fail('도구 호출 역할·번호·이름이 올바르지 않습니다.');
        if (!block.input || typeof block.input !== 'object' || Array.isArray(block.input))
          fail('도구 인자는 JSON 객체여야 합니다.');
        used.add(block.id);
        toolCalls.push({ id: block.id, name: block.name, arguments: JSON.stringify(block.input) });
      } else fail('현재 MCP 모델 요청은 텍스트와 도구 호출·결과만 지원합니다.');
    }
    pending = new Set(toolCalls.map((tool) => tool.id));
    messages.push({ role: message.role, content, ...(toolCalls.length ? { toolCalls } : {}) });
  }
  if (pending.size) fail('마지막 도구 호출에 대응하는 결과가 없습니다.');
  return {
    messages,
    ...(tools.length ? { tools, toolChoice: params.toolChoice?.mode ?? 'auto' } : {}),
    ...(params.stopSequences?.length ? { stopSequences: params.stopSequences } : {}),
  };
}

export function samplingResult(
  model: string,
  params: CreateMessageRequestParams,
  text: string,
  calls: ToolCall[],
  finished: string,
): CreateMessageResultWithTools {
  if (calls.length) {
    if (params.toolChoice?.mode === 'none' || finished === 'length' || finished === 'max_tokens')
      fail('허용되지 않거나 끝나지 않은 MCP 도구 호출입니다.');
    const validator = createMcpValidator();
    const names = new Map(params.tools?.map((tool) => [tool.name, tool]));
    const ids = new Set<string>();
    const content: CreateMessageResultWithTools['content'] = [];
    if (text) content.push({ type: 'text', text });
    for (const call of calls) {
      const tool = names.get(call.name);
      if (!tool || !callIdentifier.test(call.id) || ids.has(call.id))
        fail('MCP 모델이 잘못된 도구 호출을 반환했습니다.');
      ids.add(call.id);
      let input: unknown;
      try {
        input = JSON.parse(call.arguments);
      } catch {
        fail('MCP 도구 인자가 올바른 JSON이 아닙니다.');
      }
      if (
        !input ||
        typeof input !== 'object' ||
        Array.isArray(input) ||
        !validator.getValidator(tool.inputSchema as JsonSchemaType)(input).valid
      )
        fail('MCP 도구 인자가 도구의 스키마와 일치하지 않습니다.');
      content.push({
        type: 'tool_use',
        id: call.id,
        name: call.name,
        input: input as Record<string, unknown>,
      });
    }
    return { model, role: 'assistant', content, stopReason: 'toolUse' };
  }
  if (params.toolChoice?.mode === 'required' && finished !== 'length' && finished !== 'max_tokens')
    fail('필수 MCP 도구 호출을 모델이 반환하지 않았습니다.');
  return {
    model,
    role: 'assistant',
    content: { type: 'text', text },
    stopReason:
      finished === 'length' || finished === 'max_tokens'
        ? 'maxTokens'
        : finished === 'stop'
          ? 'endTurn'
          : finished,
  };
}
