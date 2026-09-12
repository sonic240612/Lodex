import { AppError, type ToolCall } from '@lodex/contracts';
export class ToolCallAssembler {
  private calls = new Map<number, ToolCall>();
  add(event: { index: number; id?: string; name?: string; arguments?: string }): ToolCall {
    if (!Number.isInteger(event.index) || event.index < 0 || event.index > 3)
      throw new AppError('TOOL_FORMAT', '도구 호출 번호가 잘못되었습니다.');
    const call = this.calls.get(event.index) ?? { id: '', name: '', arguments: '' };
    if (event.id && event.id !== call.id) call.id += event.id;
    if (event.name) call.name += event.name;
    if (event.arguments) call.arguments += event.arguments;
    if (call.id.length > 200 || call.name.length > 100 || Buffer.byteLength(call.arguments) > 16384)
      throw new AppError('TOOL_LIMIT', '도구 요청이 너무 큽니다.');
    this.calls.set(event.index, call);
    return call;
  }
  finish(): ToolCall[] {
    const calls = [...this.calls.entries()].sort(([a], [b]) => a - b);
    if (
      calls.some(([index, call], position) => index !== position || !call.id || !call.name) ||
      new Set(calls.map(([, call]) => call.id)).size !== calls.length
    )
      throw new AppError('TOOL_FORMAT', '완성되지 않았거나 중복된 도구 호출입니다.');
    return calls.map(([, call]) => call);
  }
}

export function mergeDetails(target: Record<string, unknown>[], value: unknown) {
  if (!Array.isArray(value))
    throw new AppError('REASONING_FORMAT', '지원하지 않는 reasoning 상태입니다.');
  for (const raw of value) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
      throw new AppError('REASONING_FORMAT', '잘못된 reasoning 상태입니다.');
    const item = raw as Record<string, unknown>;
    const index = item.index;
    if (!Number.isInteger(index) || (index as number) < 0 || (index as number) > 127)
      throw new AppError('REASONING_FORMAT', 'reasoning 상태에 유효한 index가 필요합니다.');
    let old = target.find((v) => v.index === index);
    if (!old) {
      old = {};
      target.push(old);
    }
    for (const [key, field] of Object.entries(item)) {
      if (['text', 'summary', 'data'].includes(key) && typeof field === 'string')
        old[key] = String(old[key] ?? '') + field;
      else {
        if (old[key] !== undefined && JSON.stringify(old[key]) !== JSON.stringify(field))
          throw new AppError('REASONING_FORMAT', 'reasoning 상태의 식별자가 변경되었습니다.');
        old[key] = field;
      }
    }
  }
  if (Buffer.byteLength(JSON.stringify(target)) > 131072)
    throw new AppError('REASONING_LIMIT', 'reasoning 상태 저장 한도를 초과했습니다.');
}
