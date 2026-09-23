import {
  AppError,
  localUrlSchema,
  type InferenceEvent,
  type InferenceProvider,
  type InferenceRequest,
  type ModelCapabilities,
  type ModelDescriptor,
  type ModelTemplateCapabilities,
  type ProviderId,
  type Usage,
} from '@lodex/contracts';
import { decodeSse } from './sse';
import { ThinkingSplitter } from './thinking';
import { privateServerFetch, connectionError } from './network';
export { decodeSse } from './sse';
export { privateServerFetch } from './network';
type Fetch = (input: string, init: RequestInit) => Promise<Response>;
type RetryWait = (milliseconds: number, signal: AbortSignal) => Promise<void>;
const modelRetryDelaysMs = [2000, 5000, 7000] as const;
const retryableModelStatus = (status: number, provider: Exclude<ProviderId, 'demo'>): boolean =>
  (provider === 'openrouter' && status === 400) ||
  status === 408 ||
  status === 425 ||
  status === 429 ||
  status >= 500;
const waitForRetry: RetryWait = (milliseconds, signal) =>
  new Promise<void>((resolve, reject) => {
    signal.throwIfAborted();
    const timer = setTimeout(done, milliseconds);
    function done() {
      signal.removeEventListener('abort', abort);
      resolve();
    }
    function abort() {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      reject(signal.reason);
    }
    signal.addEventListener('abort', abort, { once: true });
  });
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const number = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const price = (value: unknown): number | null => {
  const parsed = typeof value === 'string' && value.trim() ? Number(value) : number(value);
  return typeof parsed === 'number' && Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
};
const boolean = (value: unknown): boolean | null => (typeof value === 'boolean' ? value : null);

function messagesForTemplate(
  messages: InferenceRequest['messages'],
  capabilities: ModelTemplateCapabilities | null,
) {
  let adapted = messages;
  if (capabilities?.supportsSystemRole === false) {
    const system = messages
      .filter((message) => message.role === 'system')
      .map((message) => message.content)
      .join('\n\n');
    adapted = messages.filter((message) => message.role !== 'system');
    if (system) {
      const prefix = `[System instructions]\n${system}\n\n`;
      adapted =
        adapted[0]?.role === 'user'
          ? [{ ...adapted[0], content: prefix + adapted[0].content }, ...adapted.slice(1)]
          : [{ role: 'user', content: prefix.trimEnd() }, ...adapted];
    }
  }
  const typedContent =
    capabilities?.supportsStringContent === false && capabilities.supportsTypedContent === true;
  const preserveReasoning = capabilities?.supportsPreserveReasoning !== false;
  return adapted.map((message) => ({
    role: message.role,
    content: typedContent ? [{ type: 'text', text: message.content }] : message.content,
    ...(message.toolCalls
      ? {
          tool_calls: message.toolCalls.map((call) => ({
            id: call.id,
            type: 'function',
            function: { name: call.name, arguments: call.arguments },
          })),
        }
      : {}),
    ...(message.toolCallId ? { tool_call_id: message.toolCallId } : {}),
    ...(preserveReasoning && message.reasoningDetails?.length
      ? { reasoning_details: message.reasoningDetails }
      : {}),
    ...(preserveReasoning && message.reasoningContent
      ? { reasoning_content: message.reasoningContent }
      : {}),
  }));
}

function needsTemplateCapabilities(request: InferenceRequest) {
  return (
    !!request.tools?.length ||
    request.messages.some(
      (message) =>
        message.role === 'system' ||
        !!message.toolCalls?.length ||
        !!message.reasoningDetails?.length ||
        !!message.reasoningContent,
    )
  );
}

function llamaTemplateCapabilities(value: unknown): ModelTemplateCapabilities | null {
  const caps = object(object(value).chat_template_caps);
  const supportsTools = boolean(caps.supports_tools);
  const supportsToolCalls = boolean(caps.supports_tool_calls);
  const supportsSystemRole = boolean(caps.supports_system_role);
  const supportsParallelToolCalls = boolean(caps.supports_parallel_tool_calls);
  const supportsPreserveReasoning = boolean(caps.supports_preserve_reasoning);
  const supportsReasoningEffort = boolean(caps.supports_reasoning_effort);
  const supportsStringContent = boolean(caps.supports_string_content);
  const supportsTypedContent = boolean(caps.supports_typed_content);
  const supportsObjectArguments = boolean(caps.supports_object_arguments);
  if (supportsTools === null || supportsToolCalls === null) return null;
  return {
    source: 'llama_cpp_props',
    supportsTools,
    supportsToolCalls,
    supportsSystemRole,
    supportsParallelToolCalls,
    supportsPreserveReasoning,
    supportsReasoningEffort,
    supportsStringContent,
    supportsTypedContent,
    supportsObjectArguments,
  };
}
async function openRouterHttpError(response: Response, toolsRequested: boolean): Promise<string> {
  if (response.status !== 404)
    return '모델 요청 실패 (HTTP ' + response.status + '). OpenRouter 계정·키·사용량을 확인하세요.';

  // Inspect only the error category. Provider bodies may contain private request details.
  let reason = '';
  try {
    const reader = response.body?.getReader();
    if (reader) {
      const decoder = new TextDecoder();
      let body = '';
      while (body.length < 4096) {
        const part = await reader.read();
        if (part.done) break;
        body += decoder.decode(part.value, { stream: true });
      }
      if (body.length >= 4096) await reader.cancel();
      const message = object(object(JSON.parse(body)).error).message;
      if (typeof message === 'string') reason = message.toLowerCase();
    }
  } catch {
    // Malformed/unavailable error bodies must not replace the useful HTTP status.
  }
  if (/tool (use|calling)|support.*tools/.test(reason))
    return 'OpenRouter 404: 이 모델에는 도구 호출을 지원하는 엔드포인트가 없습니다. 모델 연결의 목록 조회에서 도구 지원 모델을 선택하세요.';
  if (/data.collection|data.policy|privacy|zero.data.retention|\bzdr\b/.test(reason))
    return 'OpenRouter 404: 데이터 수집 금지 정책을 만족하는 제공자가 없습니다. 다른 모델을 선택하거나 OpenRouter 제공자 설정을 확인하세요.';
  if (/parameter|temperature|top_p|max_tokens/.test(reason))
    return 'OpenRouter 404: 현재 생성 설정을 모두 지원하는 제공자가 없습니다. 다른 모델을 선택하세요.';
  if (/model.*(not found|does not exist|unknown|invalid)|invalid model|unknown model/.test(reason))
    return 'OpenRouter 404: 모델 ID를 찾을 수 없습니다. 모델 연결의 목록 조회에서 정확한 ID를 선택하세요.';
  return toolsRequested
    ? 'OpenRouter 404: 모델 ID가 잘못되었거나 도구 호출·생성 설정·데이터 수집 금지 정책을 만족하는 제공자가 없습니다. 모델 연결의 목록 조회에서 도구 지원 모델을 선택하세요.'
    : 'OpenRouter 404: 모델 ID가 잘못되었거나 생성 설정·데이터 수집 금지 정책을 만족하는 제공자가 없습니다. 모델 연결의 목록 조회에서 모델을 다시 선택하세요.';
}
export class ChatCompletionProvider implements InferenceProvider {
  private baseUrl: string;
  private fetcher: Fetch;
  private templateCapabilitiesLoaded = false;
  private templateCapabilitiesValue: ModelTemplateCapabilities | null = null;
  constructor(
    private kind: Exclude<ProviderId, 'demo'>,
    baseUrl: string,
    private key: string | null,
    fetcher?: Fetch,
    private retryWait: RetryWait = waitForRetry,
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
  private async templateCapabilities(
    signal?: AbortSignal,
  ): Promise<ModelTemplateCapabilities | null> {
    if (this.kind !== 'llama-server') return null;
    if (this.templateCapabilitiesLoaded) return this.templateCapabilitiesValue;
    const propsUrl = this.baseUrl.replace(/\/v1$/, '') + '/props';
    try {
      const response = await this.fetcher(propsUrl, {
        headers: this.headers(),
        redirect: 'error',
        signal: signal ?? AbortSignal.timeout(5000),
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        this.templateCapabilitiesLoaded = true;
        return null;
      }
      const capabilities = llamaTemplateCapabilities(await response.json());
      this.templateCapabilitiesValue = capabilities;
      this.templateCapabilitiesLoaded = true;
      return capabilities;
    } catch {
      if (signal?.aborted) throw signal.reason;
      // Older OpenAI-compatible servers may not expose llama.cpp /props.
      this.templateCapabilitiesLoaded = true;
      return null;
    }
  }
  private async fetchModelResponse(init: RequestInit, signal: AbortSignal): Promise<Response> {
    for (let attempt = 0; ; attempt += 1) {
      const response = await this.fetchResponse('/chat/completions', init);
      if (
        response.ok ||
        !retryableModelStatus(response.status, this.kind) ||
        attempt >= modelRetryDelaysMs.length
      )
        return response;
      await response.body?.cancel().catch(() => undefined);
      await this.retryWait(modelRetryDelaysMs[attempt]!, signal);
    }
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
    const templateCapabilities = await this.templateCapabilities(signal);
    return body.data.flatMap((item) => {
      const model = object(item);
      if (typeof model.id !== 'string') return [];
      const defaults = object(model.default_parameters);
      const topProvider = object(model.top_provider);
      const rawPricing = object(model.pricing);
      const prompt = price(rawPricing.prompt),
        completion = price(rawPricing.completion),
        request = price(rawPricing.request) ?? 0;
      return [
        {
          id: model.id,
          name: typeof model.name === 'string' ? model.name : model.id,
          contextLength: number(model.context_length),
          maxCompletionTokens: number(topProvider.max_completion_tokens),
          defaultTemperature: number(defaults.temperature),
          defaultTopP: number(defaults.top_p),
          tools:
            templateCapabilities !== null
              ? templateCapabilities.supportsTools && templateCapabilities.supportsToolCalls
              : Array.isArray(model.supported_parameters)
                ? model.supported_parameters.includes('tools')
                : null,
          ...(templateCapabilities ? { templateCapabilities } : {}),
          pricing:
            this.kind === 'openrouter' && prompt !== null && completion !== null
              ? { prompt, completion, request }
              : null,
        },
      ];
    });
  }
  async capabilities(model: string): Promise<ModelCapabilities> {
    const descriptor = (await this.listModels()).find((m) => m.id === model);
    return {
      tools: descriptor?.tools ?? null,
      streaming: true,
      ...(descriptor?.templateCapabilities ? { template: descriptor.templateCapabilities } : {}),
    };
  }
  private requestBody(
    request: InferenceRequest,
    stream: boolean,
    templateCapabilities: ModelTemplateCapabilities | null = null,
  ) {
    const config = request.config;
    if (
      request.tools?.length &&
      (templateCapabilities?.supportsTools === false ||
        templateCapabilities?.supportsToolCalls === false)
    )
      throw new AppError(
        'MODEL_TOOLS_UNSUPPORTED',
        '활성 chat template이 도구 호출을 지원하지 않습니다. tool_use template이 포함된 GGUF를 선택하거나 로컬 모델 설정에서 호환 Chat template을 지정하세요.',
      );
    return {
      model: config.model,
      messages:
        this.kind === 'llama-server'
          ? messagesForTemplate(request.messages, templateCapabilities)
          : request.messages.map((message) => ({
              role: message.role,
              content: message.content,
              ...(message.toolCalls
                ? {
                    tool_calls: message.toolCalls.map((call) => ({
                      id: call.id,
                      type: 'function',
                      function: { name: call.name, arguments: call.arguments },
                    })),
                  }
                : {}),
              ...(message.toolCallId ? { tool_call_id: message.toolCallId } : {}),
              ...(message.reasoningDetails?.length
                ? { reasoning_details: message.reasoningDetails }
                : {}),
              ...(message.reasoningContent ? { reasoning: message.reasoningContent } : {}),
            })),
      ...(request.tools?.length
        ? {
            tools: request.tools,
            tool_choice: 'auto',
            ...(this.kind === 'llama-server'
              ? { parallel_tool_calls: templateCapabilities?.supportsParallelToolCalls === true }
              : {}),
          }
        : {}),
      stream,
      ...(config.useDefaultTemperature ? {} : { temperature: config.temperature }),
      ...(config.useDefaultTopP ? {} : { top_p: config.topP }),
      max_tokens: config.maxTokens,
      ...(this.kind === 'openrouter'
        ? {
            usage: { include: true },
            provider: {
              require_parameters: true,
              data_collection: 'deny',
              allow_fallbacks: false,
            },
          }
        : {}),
    };
  }
  async countInputTokens(request: InferenceRequest, signal: AbortSignal): Promise<number | null> {
    if (this.kind !== 'llama-server') return null;
    const templateCapabilities = needsTemplateCapabilities(request)
      ? await this.templateCapabilities(signal)
      : null;
    const response = await this.fetchResponse('/chat/completions/input_tokens', {
      method: 'POST',
      headers: this.headers(),
      signal,
      redirect: 'error',
      body: JSON.stringify(this.requestBody(request, false, templateCapabilities)),
    });
    if ([404, 405, 501].includes(response.status)) {
      await response.body?.cancel().catch(() => undefined);
      return null;
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new AppError(
        'TOKEN_COUNT_HTTP',
        `llama-server 입력 토큰 계산 실패 (HTTP ${response.status}).`,
        502,
      );
    }
    let value: unknown;
    try {
      value = await response.json();
    } catch {
      throw new AppError(
        'TOKEN_COUNT_FORMAT',
        'llama-server 토큰 계산 응답이 올바르지 않습니다.',
        502,
      );
    }
    const inputTokens = number(object(value).input_tokens);
    if (inputTokens === null || !Number.isInteger(inputTokens))
      throw new AppError(
        'TOKEN_COUNT_FORMAT',
        'llama-server 토큰 계산 응답이 올바르지 않습니다.',
        502,
      );
    return inputTokens;
  }
  async *generate(request: InferenceRequest, signal: AbortSignal): AsyncGenerator<InferenceEvent> {
    yield { type: 'started' };
    const started = performance.now();
    let firstTokenAt: number | null = null,
      finishReason: string | null = null;
    const config = request.config;
    const splitter = new ThinkingSplitter();
    let structuredThinking = false;
    const toolIndexesById = new Map<string, number>();
    const implicitToolIndexes: number[] = [];
    let nextToolIndex = 0;
    const templateCapabilities =
      this.kind === 'llama-server' && needsTemplateCapabilities(request)
        ? await this.templateCapabilities(signal)
        : null;
    const response = await this.fetchModelResponse(
      {
        method: 'POST',
        headers: this.headers(),
        signal,
        redirect: 'error',
        body: JSON.stringify(this.requestBody(request, true, templateCapabilities)),
      },
      signal,
    );
    if (!response.ok)
      throw new AppError(
        'PROVIDER_HTTP',
        this.kind === 'openrouter'
          ? await openRouterHttpError(response, !!request.tools?.length)
          : '모델 요청 실패 (HTTP ' + response.status + '). 주소·모델 ID·연결 설정을 확인하세요.',
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
        for (const [position, item] of delta.tool_calls.entries()) {
          const call = object(item),
            fn = object(call.function);
          const id = typeof call.id === 'string' ? call.id : undefined;
          const explicitIndex =
            typeof call.index === 'number' && Number.isInteger(call.index) && call.index >= 0
              ? call.index
              : undefined;
          const index =
            explicitIndex ??
            (id
              ? (toolIndexesById.get(id) ?? nextToolIndex)
              : (implicitToolIndexes[position] ?? nextToolIndex));
          nextToolIndex = Math.max(nextToolIndex, index + 1);
          implicitToolIndexes[position] = index;
          if (id) toolIndexesById.set(id, index);
          yield {
            type: 'tool_call_delta',
            index,
            ...(id ? { id } : {}),
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
    return [
      {
        id: 'demo',
        name: '데모 · LLM 사용 안 함',
        contextLength: null,
        maxCompletionTokens: null,
        defaultTemperature: null,
        defaultTopP: null,
        tools: false,
        pricing: null,
      },
    ];
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
