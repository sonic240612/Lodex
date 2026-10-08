import {
  AppError,
  normalizeProviderBaseUrl,
  type InferenceProvider,
  type InferenceRequest,
  type InferenceEvent,
  type ModelDescriptor,
  type Usage,
} from '@lodex/contracts';
import { privateServerFetch, connectionError } from './network';
import { ThinkingSplitter } from './thinking';

type Fetch = (url: string, init: RequestInit) => Promise<Response>;
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const number = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;

async function* lines(body: ReadableStream<Uint8Array>, signal: AbortSignal) {
  const reader = body.getReader(),
    decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '';
  const abort = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener('abort', abort, { once: true });
  try {
    for (;;) {
      signal.throwIfAborted();
      const part = await reader.read();
      signal.throwIfAborted();
      buffer += decoder.decode(part.value, { stream: !part.done });
      let newline: number;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        if (newline > 1_048_576)
          throw new AppError('OLLAMA_FORMAT', 'Ollama 이벤트 크기가 너무 큽니다.', 502);
        const text = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (text) yield text;
      }
      if (buffer.length > 1_048_576)
        throw new AppError('OLLAMA_FORMAT', 'Ollama 이벤트 크기가 너무 큽니다.', 502);
      if (part.done) {
        if (buffer.trim()) yield buffer.trim();
        return;
      }
    }
  } finally {
    signal.removeEventListener('abort', abort);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
async function json(response: Response, signal: AbortSignal) {
  if (!response.body) throw new AppError('OLLAMA_FORMAT', 'Ollama 응답이 비어 있습니다.', 502);
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let bytes = 0;
  const abort = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener('abort', abort, { once: true });
  try {
    for (;;) {
      signal.throwIfAborted();
      const part = await reader.read();
      signal.throwIfAborted();
      if (part.done) break;
      bytes += part.value.length;
      if (bytes > 8_388_608)
        throw new AppError('OLLAMA_FORMAT', 'Ollama 모델 정보가 너무 큽니다.', 502);
      chunks.push(part.value);
    }
    const value: unknown = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)),
    );
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new AppError('OLLAMA_FORMAT', 'Ollama 모델 정보 형식이 올바르지 않습니다.', 502);
    return object(value);
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    if (error instanceof AppError) throw error;
    throw new AppError('OLLAMA_FORMAT', 'Ollama 모델 정보 형식이 올바르지 않습니다.', 502);
  } finally {
    signal.removeEventListener('abort', abort);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
export class OllamaProvider implements InferenceProvider {
  private base: string;
  private details = new Map<string, Record<string, unknown>>();
  constructor(
    base: string,
    private fetcher: Fetch = privateServerFetch,
    private wait = async (milliseconds: number, signal: AbortSignal) => {
      signal.throwIfAborted();
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          signal.removeEventListener('abort', abort);
          resolve();
        }, milliseconds);
        const abort = () => {
          clearTimeout(timer);
          signal.removeEventListener('abort', abort);
          reject(signal.reason);
        };
        signal.addEventListener('abort', abort, { once: true });
      });
    },
  ) {
    this.base = normalizeProviderBaseUrl('ollama', base);
  }
  private async response(path: string, signal: AbortSignal, body?: unknown) {
    try {
      return await this.fetcher(this.base + '/api' + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        redirect: 'error',
        signal,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      throw connectionError(error, this.base);
    }
  }
  private async metadata(path: string, signal: AbortSignal, body?: unknown) {
    const response = await this.response(path, signal, body);
    if (!response.ok) {
      await response.body?.cancel();
      throw new AppError(
        'OLLAMA_HTTP',
        `Ollama 모델 정보 조회 실패 (HTTP ${response.status}). 서버 주소와 설치한 모델 이름을 확인하세요.`,
        502,
      );
    }
    return json(response, signal);
  }
  private async show(model: string, signal: AbortSignal) {
    let details = this.details.get(model);
    if (!details) {
      details = await this.metadata('/show', signal, { model });
      this.details.set(model, details);
    }
    if (details.remote_host || details.remote_model || /(?:^|[:\-])cloud(?:$|:)/i.test(model))
      throw new AppError(
        'OLLAMA_CLOUD_UNSUPPORTED',
        'Ollama 연결은 설치된 로컬 모델만 지원합니다. 클라우드 모델은 OpenRouter 연결에서 선택하세요.',
      );
    return details;
  }
  private descriptor(model: string, details: Record<string, unknown>): ModelDescriptor {
    const info = object(details.model_info);
    const architecture =
      typeof info['general.architecture'] === 'string' ? info['general.architecture'] : '';
    const parameters = typeof details.parameters === 'string' ? details.parameters : '';
    const parameter = (key: string) => {
      const value = new RegExp('(?:^|\\n)' + key + '\\s+([\\d.]+)(?:\\s|$)').exec(parameters)?.[1];
      return value === undefined ? null : number(Number(value));
    };
    const positive = (value: number | null) => (value !== null && value > 0 ? value : null);
    const maximum = positive(number(info[architecture + '.context_length']));
    const configured = positive(parameter('num_ctx'));
    return {
      id: model,
      name: model,
      contextLength:
        configured && maximum ? Math.min(configured, maximum) : (configured ?? maximum),
      maxCompletionTokens: positive(parameter('num_predict')),
      defaultTemperature: parameter('temperature'),
      defaultTopP: parameter('top_p'),
      tools: Array.isArray(details.capabilities) ? details.capabilities.includes('tools') : null,
      pricing: null,
    };
  }
  async listModels(signal = AbortSignal.timeout(15000)): Promise<ModelDescriptor[]> {
    const response = await this.metadata('/tags', signal);
    if (!Array.isArray(response.models) || response.models.length > 10000)
      throw new AppError('OLLAMA_FORMAT', 'Ollama 모델 목록 형식이 올바르지 않습니다.', 502);
    const models = response.models
      .map(object)
      .filter(
        (model) =>
          typeof model.name === 'string' &&
          model.name.length > 0 &&
          model.name.length <= 200 &&
          !model.remote_host &&
          !model.remote_model &&
          !/(?:^|[:\-])cloud(?:$|:)/i.test(String(model.name)),
      );
    const result: ModelDescriptor[] = [];
    let cursor = 0;
    await Promise.all(
      Array.from({ length: Math.min(4, models.length) }, async () => {
        while (cursor < models.length) {
          const model = models[cursor++]!,
            id = model.name as string;
          const details = await this.show(id, signal);
          result.push(this.descriptor(id, details));
        }
      }),
    );
    return result.sort((a, b) => a.id.localeCompare(b.id));
  }
  async capabilities(model: string) {
    return {
      tools: this.descriptor(model, await this.show(model, AbortSignal.timeout(15000))).tools,
      streaming: true,
    };
  }
  async countInputTokens(_request: InferenceRequest, signal: AbortSignal) {
    signal.throwIfAborted();
    return null;
  }
  async *generate(request: InferenceRequest, signal: AbortSignal): AsyncGenerator<InferenceEvent> {
    yield { type: 'started' };
    const start = performance.now(),
      config = request.config;
    const details = await this.show(config.model, signal);
    if (request.toolChoice === 'required')
      throw new AppError(
        'OLLAMA_TOOL_CHOICE',
        'Ollama native API는 필수 도구 선택을 지원하지 않습니다. 자동 선택을 사용하세요.',
      );
    const tools = request.toolChoice === 'none' ? [] : (request.tools ?? []);
    if (tools.length && this.descriptor(config.model, details).tools === false)
      throw new AppError(
        'MODEL_TOOLS_UNSUPPORTED',
        '이 Ollama 모델은 도구 호출을 지원하지 않습니다.',
      );
    const names = new Map(
      request.messages.flatMap(
        (message) => message.toolCalls?.map((call) => [call.id, call.name] as const) ?? [],
      ),
    );
    const body = {
      model: config.model,
      stream: true,
      // Lodex owns compaction: never silently discard earlier instructions server-side.
      truncate: false,
      shift: false,
      messages: request.messages.map((message) => ({
        role: message.role,
        content: message.content,
        ...(message.reasoningContent ? { thinking: message.reasoningContent } : {}),
        ...(message.toolCalls
          ? {
              tool_calls: message.toolCalls.map((call) => {
                let args: unknown;
                try {
                  args = JSON.parse(call.arguments);
                } catch {
                  throw new AppError(
                    'TOOL_ARGUMENTS',
                    'Ollama에 전달할 도구 인자가 JSON이 아닙니다.',
                  );
                }
                if (!args || typeof args !== 'object' || Array.isArray(args))
                  throw new AppError('TOOL_ARGUMENTS', 'Ollama 도구 인자는 객체여야 합니다.');
                return { id: call.id, function: { name: call.name, arguments: args } };
              }),
            }
          : {}),
        ...(message.toolCallId
          ? {
              tool_call_id: message.toolCallId,
              tool_name: message.toolName ?? names.get(message.toolCallId) ?? '',
            }
          : {}),
      })),
      ...(tools.length ? { tools } : {}),
      ...(config.keepAliveSeconds === undefined ? {} : { keep_alive: config.keepAliveSeconds }),
      ...(request.purpose === 'context_summary' &&
      Array.isArray(details.capabilities) &&
      details.capabilities.includes('thinking')
        ? { think: false }
        : {}),
      options: {
        num_ctx: config.contextBudgetTokens,
        num_predict: config.maxTokens,
        ...(config.useDefaultTemperature ? {} : { temperature: config.temperature }),
        ...(config.useDefaultTopP ? {} : { top_p: config.topP }),
        ...(request.stopSequences?.length ? { stop: request.stopSequences } : {}),
      },
    };
    let response: Response;
    const delays = [2000, 5000, 7000];
    for (let attempt = 0; ; attempt++) {
      response = await this.response('/chat', signal, body);
      if (
        response.ok ||
        !([408, 425, 429].includes(response.status) || response.status >= 500) ||
        attempt >= delays.length
      )
        break;
      await response.body?.cancel();
      await this.wait(delays[attempt]!, signal);
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new AppError(
        'PROVIDER_HTTP',
        `Ollama 모델 요청 실패 (HTTP ${response.status}). 모델 설치 상태와 서버 로그를 확인하세요.`,
        502,
      );
    }
    if (!response.body) throw new AppError('OLLAMA_FORMAT', 'Ollama 응답이 비어 있습니다.', 502);
    let index = 0,
      first = true,
      structuredThinking = false;
    const splitter = new ThinkingSplitter();
    for await (const line of lines(response.body, signal)) {
      let chunk: Record<string, unknown>;
      try {
        chunk = object(JSON.parse(line));
      } catch {
        throw new AppError('INVALID_JSON', 'Ollama 스트림에 잘못된 JSON이 있습니다.', 502);
      }
      if (chunk.error)
        throw new AppError(
          'PROVIDER_STREAM',
          'Ollama가 응답 도중 오류를 반환했습니다. 서버 로그를 확인하세요.',
          502,
        );
      const message = object(chunk.message);
      const thinking = typeof message.thinking === 'string' ? message.thinking : '';
      if (thinking) structuredThinking = true;
      const parts = [
        ...(thinking ? [{ thinking: true, text: thinking }] : []),
        ...splitter
          .push(typeof message.content === 'string' ? message.content : '')
          .filter((part) => !part.thinking || !structuredThinking),
      ];
      for (const part of parts) {
        if (first) {
          first = false;
          yield {
            type: 'usage',
            usage: { ttftMs: { value: performance.now() - start, source: 'app_observed' } },
          };
        }
        yield { type: part.thinking ? 'reasoning_delta' : 'text_delta', text: part.text };
      }
      if (Array.isArray(message.tool_calls))
        for (const value of message.tool_calls) {
          if (!tools.length)
            throw new AppError(
              'MODEL_TOOL_CHOICE',
              '도구가 허용되지 않은 요청에 Ollama가 도구 호출을 반환했습니다.',
              502,
            );
          const call = object(value),
            fn = object(call.function);
          if (
            typeof fn.name !== 'string' ||
            !fn.arguments ||
            typeof fn.arguments !== 'object' ||
            Array.isArray(fn.arguments)
          )
            throw new AppError('TOOL_ARGUMENTS', 'Ollama 도구 호출 형식이 올바르지 않습니다.', 502);
          yield {
            type: 'tool_call_delta',
            index: index++,
            id: typeof call.id === 'string' && call.id ? call.id : crypto.randomUUID(),
            name: fn.name,
            arguments: JSON.stringify(fn.arguments),
          };
        }
      if (chunk.done === true) {
        const inputTokens = number(chunk.prompt_eval_count),
          outputTokens = number(chunk.eval_count),
          prefillNs = number(chunk.prompt_eval_duration),
          decodeNs = number(chunk.eval_duration);
        const usage: Partial<Usage> = { inputTokens, outputTokens };
        if (inputTokens !== null && prefillNs)
          usage.prefillTps = {
            value:
              (Math.max(0, inputTokens - (number(chunk.prompt_eval_cached_count) ?? 0)) * 1e9) /
              prefillNs,
            source: 'engine_reported',
          };
        if (outputTokens !== null && decodeNs)
          usage.decodeTps = { value: (outputTokens * 1e9) / decodeNs, source: 'engine_reported' };
        yield { type: 'usage', usage };
        for (const part of splitter.finish())
          if (!part.thinking || !structuredThinking)
            yield { type: part.thinking ? 'reasoning_delta' : 'text_delta', text: part.text };
        yield {
          type: 'finished',
          reason: index
            ? 'tool_calls'
            : typeof chunk.done_reason === 'string'
              ? chunk.done_reason
              : 'stop',
        };
        return;
      }
    }
    throw new AppError(
      'TRUNCATED_STREAM',
      'Ollama 연결이 정상 종료 전에 끊겼습니다. 부분 응답을 보존했습니다.',
      502,
    );
  }
}
