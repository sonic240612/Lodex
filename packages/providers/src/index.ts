import {
  AppError,
  localUrlSchema,
  type InferenceEvent,
  type InferenceProvider,
  type InferenceRequest,
  type ModelCapabilities,
  type ModelDescriptor,
  type ProviderId,
  type Usage,
} from '@lodex/contracts';
import { decodeSse } from './sse';
import { ThinkingSplitter } from './thinking';
import { privateServerFetch, connectionError } from './network';
export { decodeSse } from './sse';
export { privateServerFetch } from './network';
type Fetch = (input: string, init: RequestInit) => Promise<Response>;
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const number = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
export class ChatCompletionProvider implements InferenceProvider {
  private baseUrl: string;
  private fetcher: Fetch;
  constructor(
    private kind: Exclude<ProviderId, 'demo'>,
    baseUrl: string,
    private key: string | null,
    fetcher?: Fetch,
  ) {
    this.fetcher = fetcher ?? (kind === 'llama-server' ? privateServerFetch : fetch);
    this.baseUrl =
      kind === 'openrouter'
        ? 'https://openrouter.ai/api/v1'
        : localUrlSchema.parse(baseUrl).replace(/\/$/, '');
  }
  private async fetchResponse(path: string, init: RequestInit): Promise<Response> {
    try {
      return await this.fetcher(this.baseUrl + path, init);
    } catch (error) {
      if (init.signal?.aborted && init.signal.reason?.name !== 'TimeoutError')
        throw init.signal.reason;
      if (this.kind === 'openrouter')
        throw new AppError(
          'PROVIDER_CONNECTION',
          'OpenRouter에 연결하지 못했습니다. DNS·인터넷 연결·인증서 설정을 확인하세요.',
          502,
        );
      throw connectionError(error, this.baseUrl);
    }
  }
  private headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      ...(this.key ? { Authorization: 'Bearer ' + this.key } : {}),
    };
  }
  async listModels(signal?: AbortSignal): Promise<ModelDescriptor[]> {
    const response = await this.fetchResponse('/models', {
      headers: this.headers(),
      redirect: 'error',
      signal: signal ?? AbortSignal.timeout(15000),
    });
    if (!response.ok)
      throw new AppError(
        'CATALOG_HTTP',
        '모델 목록 조회 실패 (HTTP ' + response.status + ').',
        502,
      );
    const body = object(await response.json());
    if (!Array.isArray(body.data))
      throw new AppError('CATALOG_FORMAT', '모델 목록 형식을 해석할 수 없습니다.', 502);
    return body.data.flatMap((item) => {
      const model = object(item);
      if (typeof model.id !== 'string') return [];
      return [
        {
          id: model.id,
          name: typeof model.name === 'string' ? model.name : model.id,
          contextLength: number(model.context_length),
          tools: Array.isArray(model.supported_parameters)
            ? model.supported_parameters.includes('tools')
            : null,
        },
      ];
    });
  }
  async capabilities(model: string): Promise<ModelCapabilities> {
    const descriptor = (await this.listModels()).find((m) => m.id === model);
    return { tools: descriptor?.tools ?? null, streaming: true };
  }
  async *generate(request: InferenceRequest, signal: AbortSignal): AsyncGenerator<InferenceEvent> {
    yield { type: 'started' };
    const started = performance.now();
    let firstTokenAt: number | null = null,
      finishReason: string | null = null;
    const config = request.config;
    const splitter = new ThinkingSplitter();
    let structuredThinking = false;
    const response = await this.fetchResponse('/chat/completions', {
      method: 'POST',
      headers: this.headers(),
      signal,
      redirect: 'error',
      body: JSON.stringify({
        model: config.model,
        messages: request.messages.map((m) => ({
          role: m.role,
          content: m.content,
          ...(m.toolCalls
            ? {
                tool_calls: m.toolCalls.map((call) => ({
                  id: call.id,
                  type: 'function',
                  function: { name: call.name, arguments: call.arguments },
                })),
              }
            : {}),
          ...(m.toolCallId ? { tool_call_id: m.toolCallId } : {}),
          ...(m.reasoningDetails?.length ? { reasoning_details: m.reasoningDetails } : {}),
          ...(m.reasoningContent
            ? {
                [this.kind === 'llama-server' ? 'reasoning_content' : 'reasoning']:
                  m.reasoningContent,
              }
            : {}),
        })),
        ...(request.tools?.length
          ? { tools: request.tools, tool_choice: 'auto', parallel_tool_calls: false }
          : {}),
        stream: true,
        temperature: config.temperature,
        top_p: config.topP,
        max_tokens: config.maxTokens,
        ...(this.kind === 'openrouter'
          ? {
              provider: {
                require_parameters: true,
                data_collection: 'deny',
                allow_fallbacks: false,
              },
            }
          : {}),
      }),
    });
    if (!response.ok)
      throw new AppError(
        'PROVIDER_HTTP',
        '모델 요청 실패 (HTTP ' + response.status + '). 주소·모델 ID·연결 설정을 확인하세요.',
        502,
      );
    if (!response.body || !response.headers.get('content-type')?.includes('text/event-stream'))
      throw new AppError('PROVIDER_FORMAT', '서버가 SSE 스트림을 반환하지 않았습니다.', 502);
    for await (const event of decodeSse(response.body, signal)) {
      if (event.data === '[DONE]') {
        if (!finishReason)
          throw new AppError('MISSING_FINISH', '정상 종료 사유가 없는 응답입니다.', 502);
        for (const part of splitter.finish())
          if (!part.thinking || !structuredThinking)
            yield { type: part.thinking ? 'reasoning_delta' : 'text_delta', text: part.text };
        yield { type: 'finished', reason: finishReason };
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(event.data);
      } catch {
        throw new AppError('INVALID_JSON', '서버 스트림에 잘못된 JSON이 있습니다.', 502);
      }
      const chunk = object(parsed);
      if (chunk.error)
        throw new AppError('PROVIDER_STREAM', '모델 제공자가 응답 도중 오류를 반환했습니다.', 502);
      const choice = object(Array.isArray(chunk.choices) ? chunk.choices[0] : undefined);
      const delta = object(choice.delta);
      const reasoning =
        typeof delta.reasoning_content === 'string'
          ? delta.reasoning_content
          : typeof delta.reasoning === 'string'
            ? delta.reasoning
            : '';
      const details = Array.isArray(delta.reasoning_details) ? delta.reasoning_details : [];
      if (details.length)
        yield {
          type: 'provider_state_delta',
          provider: this.kind,
          model: config.model,
          data: details,
        };
      const thinkingText =
        reasoning ||
        details
          .map((item) => {
            const detail = object(item);
            return detail.type === 'reasoning.text' && typeof detail.text === 'string'
              ? detail.text
              : detail.type === 'reasoning.summary' && typeof detail.summary === 'string'
                ? detail.summary
                : '';
          })
          .join('');
      if (thinkingText) structuredThinking = true;
      const parts = [
        ...(thinkingText ? [{ thinking: true, text: thinkingText }] : []),
        ...splitter
          .push(typeof delta.content === 'string' ? delta.content : '')
          .filter((p) => !p.thinking || !structuredThinking),
      ];
      for (const part of parts) {
        if (firstTokenAt === null) {
          firstTokenAt = performance.now();
          yield {
            type: 'usage',
            usage: { ttftMs: { value: firstTokenAt - started, source: 'app_observed' } },
          };
        }
        yield { type: part.thinking ? 'reasoning_delta' : 'text_delta', text: part.text };
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const item of delta.tool_calls) {
          const call = object(item),
            fn = object(call.function);
          yield {
            type: 'tool_call_delta',
            index: typeof call.index === 'number' ? call.index : -1,
            ...(typeof call.id === 'string' ? { id: call.id } : {}),
            ...(typeof fn.name === 'string' ? { name: fn.name } : {}),
            ...(typeof fn.arguments === 'string' ? { arguments: fn.arguments } : {}),
          };
        }
      }
      if (typeof choice.finish_reason === 'string') finishReason = choice.finish_reason;
      const usage = object(chunk.usage),
        timings = object(chunk.timings);
      const update: Partial<Usage> = {};
      if (number(usage.prompt_tokens) !== null) update.inputTokens = number(usage.prompt_tokens);
      if (number(usage.completion_tokens) !== null)
        update.outputTokens = number(usage.completion_tokens);
      if (this.kind === 'openrouter' && number(usage.cost) !== null) {
        update.costUsd = number(usage.cost);
        update.billing = 'reported';
      }
      if (number(timings.predicted_per_second) !== null)
        update.decodeTps = {
          value: number(timings.predicted_per_second)!,
          source: 'engine_reported',
        };
      if (number(timings.prompt_per_second) !== null)
        update.prefillTps = {
          value: number(timings.prompt_per_second)!,
          source: 'engine_reported',
        };
      if (Object.keys(update).length) yield { type: 'usage', usage: update };
    }
    // EOF without DONE is never treated as a completed tool call / successful response.
    throw new AppError(
      'TRUNCATED_STREAM',
      '연결이 정상 종료 전에 끊겼습니다. 부분 응답을 보존했습니다.',
      502,
    );
  }
}
export class DemoProvider implements InferenceProvider {
  async listModels(): Promise<ModelDescriptor[]> {
    return [{ id: 'demo', name: '데모 · LLM 사용 안 함', contextLength: null, tools: false }];
  }
  async capabilities(): Promise<ModelCapabilities> {
    return { tools: false, streaming: true };
  }
  async *generate(_request: InferenceRequest, signal: AbortSignal): AsyncGenerator<InferenceEvent> {
    yield { type: 'started' };
    const text =
      'Lodex의 대화 저장과 스트리밍이 연결되었습니다.\n\n이 응답은 UI 확인용 데모입니다. 실제 모델 답변이 아닙니다.\n\n설정에서 로컬 llama-server 주소와 모델 ID를 입력하거나, OpenRouter 키와 모델을 연결하면 실제 대화를 시작할 수 있습니다. 오른쪽에서 Goal과 할 일을 작성해 보세요.';
    for (const part of text.match(/.{1,5}|\n/g) ?? []) {
      signal.throwIfAborted();
      await new Promise<void>((resolve, reject) => {
        const done = () => {
          signal.removeEventListener('abort', abort);
          resolve();
        };
        const timer = setTimeout(done, 30);
        const abort = () => {
          clearTimeout(timer);
          signal.removeEventListener('abort', abort);
          reject(signal.reason);
        };
        signal.addEventListener('abort', abort, { once: true });
      });
      yield { type: 'text_delta', text: part };
    }
    yield { type: 'finished', reason: 'stop' };
  }
}
