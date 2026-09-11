import { AppError } from '@lodex/contracts';
export interface ServerSentEvent {
  data: string;
  event: string;
  id: string | null;
}
export async function* decodeSse(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): AsyncGenerator<ServerSentEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '',
    data: string[] = [],
    event = 'message',
    id: string | null = null,
    eventSize = 0;
  const cancel = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    signal.throwIfAborted();
    for (;;) {
      const chunk = await reader.read();
      signal.throwIfAborted();
      buffer += decoder.decode(chunk.value, { stream: !chunk.done });
      if (buffer.length > 1_048_576)
        throw new AppError('SSE_SIZE', '서버 이벤트가 허용 크기를 초과했습니다.');
      // Accept LF, CRLF and bare CR, including a CRLF split between chunks.
      let index: number;
      while ((index = buffer.search(/[\r\n]/)) !== -1) {
        if (buffer[index] === '\r' && index === buffer.length - 1 && !chunk.done) break;
        const line = buffer.slice(0, index);
        const skip = buffer[index] === '\r' && buffer[index + 1] === '\n' ? 2 : 1;
        buffer = buffer.slice(index + skip);
        if (line === '') {
          if (data.length) yield { data: data.join('\n'), event, id };
          data = [];
          event = 'message';
          eventSize = 0;
        } else if (!line.startsWith(':')) {
          const colon = line.indexOf(':');
          const field = colon === -1 ? line : line.slice(0, colon);
          const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
          if (field === 'data') {
            eventSize += value.length;
            if (eventSize > 1_048_576)
              throw new AppError('SSE_SIZE', '서버 이벤트가 허용 크기를 초과했습니다.');
            data.push(value);
          } else if (field === 'event') event = value;
          else if (field === 'id' && !value.includes('\0')) id = value;
        }
      }
      if (chunk.done) break; // An unterminated event is deliberately not dispatched.
    }
  } finally {
    signal.removeEventListener('abort', cancel);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
