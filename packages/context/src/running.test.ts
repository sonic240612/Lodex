import { describe, expect, it } from 'vitest';
import {
  defaultModelConfig,
  defaultPlan,
  type InferenceMessage,
  type InferenceRequest,
  type Session,
} from '@lodex/contracts';
import {
  compactRunningContext,
  compileContext,
  measureRequest,
  projectRunningContext,
} from './index';

function request(): InferenceRequest {
  return {
    config: {
      ...defaultModelConfig(),
      contextBudgetTokens: 8000,
      maxTokens: 1600,
      autoMaxTokens: true,
    },
    messages: [
      { role: 'system', content: 'System instructions. Plan is read-only. Keep user constraints.' },
      { role: 'user', content: 'Current goal: fix the code without changing the public API.' },
    ],
  };
}
function exchanges(count: number, bytes = 1300): InferenceMessage[] {
  return Array.from({ length: count }, (_, index) => [
    {
      role: 'assistant' as const,
      content: 'Inspect evidence.',
      toolCalls: [{ id: `read-${index}`, name: 'read_file', arguments: '{}' }],
    },
    {
      role: 'tool' as const,
      toolCallId: `read-${index}`,
      toolName: 'read_file',
      content: `file-${index}: ` + '한글🙂'.repeat(Math.ceil(bytes / 10)),
      isError: index === 0,
    },
  ]).flat();
}

describe('running context checkpoints', () => {
  it('can reduce a Korean checkpoint even when the excerpt increases JavaScript character count', () => {
    const base = request(),
      continuation = exchanges(1, 1);
    const previous = {
      summary: '가'.repeat(30) + 'x'.repeat(42),
      throughContinuationCount: 2,
      historyCompacted: true,
      createdAt: new Date().toISOString(),
      count: 1,
      originalEstimateTokens: 7000,
      compactedEstimateTokens: 4000,
    };
    const next = compactRunningContext({ request: base, continuation, previous, force: true });
    expect(Buffer.byteLength(next.checkpoint.summary)).toBeLessThan(
      Buffer.byteLength(previous.summary),
    );
    expect(next.checkpoint.summary.length).toBeGreaterThan(previous.summary.length);
  });

  it('replays a saved checkpoint on a later turn without restoring omitted exchanges or old opaque reasoning', () => {
    const base = request(),
      continuation = exchanges(8);
    const checkpoint = compactRunningContext({ request: base, continuation }).checkpoint;
    continuation[continuation.length - 2]!.reasoningContent = 'OLD_PRIVATE_STATE';
    const source: Session = {
      id: crypto.randomUUID(),
      title: 'replay',
      version: 1,
      createdAt: '',
      updatedAt: '',
      config: { ...defaultModelConfig(), model: 'new-model' },
      plan: defaultPlan(),
      run: null,
      messages: [
        {
          id: crypto.randomUUID(),
          role: 'assistant',
          content: 'Answer',
          createdAt: '',
          status: 'complete',
          error: null,
          usage: null,
          continuation,
          runContextCompaction: checkpoint,
          inferenceConfig: { ...base.config, model: 'old-model' },
        },
      ],
    };
    const result = compileContext(source, 'Next task.').request;
    expect(
      result.messages.some((entry) => entry.content.includes('running context checkpoint')),
    ).toBe(true);
    expect(
      result.messages.some((entry) => entry.role === 'tool' && entry.toolCallId === 'read-0'),
    ).toBe(false);
    expect(result.messages.at(-2)?.toolCallId).toBe('read-7');
    expect(JSON.stringify(result.messages)).not.toContain('OLD_PRIVATE_STATE');
  });

  it('compacts complete exchanges, keeps pinned instructions and the latest exchange, and preserves originals', () => {
    const base = request(),
      continuation = exchanges(8);
    const original = structuredClone({ base, continuation });
    const result = compactRunningContext({ request: base, continuation });
    expect(measureRequest(result.request).inputEstimateTokens).toBeLessThanOrEqual(6400);
    expect(result.request.messages[0]).toEqual(base.messages[0]);
    expect(result.request.messages[1]).toEqual(base.messages[1]);
    expect(result.request.messages.at(-1)?.toolCallId).toBe('read-7');
    expect(result.checkpoint.throughContinuationCount % 2).toBe(0);
    expect(result.checkpoint.throughContinuationCount).toBeGreaterThan(0);
    expect(JSON.stringify(result.request)).not.toContain('�');
    expect({ base, continuation }).toEqual(original);
  });

  it('reduces historical checkpoints but keeps additional system instructions and the current request', () => {
    const base = request();
    base.messages.splice(
      1,
      0,
      { role: 'system', content: 'Additional policy that must remain verbatim.' },
      {
        role: 'system',
        content: 'Application-created conversation checkpoint.\n' + 'old'.repeat(3000),
      },
    );
    const result = compactRunningContext({ request: base, continuation: [] });
    expect(result.checkpoint.throughContinuationCount).toBe(0);
    expect(result.request.messages).toContainEqual(base.messages[1]);
    expect(result.request.messages).toContainEqual(base.messages.at(-1));
    expect(result.request.messages).not.toContainEqual(base.messages[2]);
  });

  it('keeps multi-call batches atomic and rejects missing, duplicate or orphan results', () => {
    const base = request();
    const batch: InferenceMessage[] = [
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          { id: 'a', name: 'read_file', arguments: '{}' },
          { id: 'b', name: 'read_file', arguments: '{}' },
        ],
      },
      { role: 'tool', toolCallId: 'a', content: 'a'.repeat(10000) },
      { role: 'tool', toolCallId: 'b', content: 'b'.repeat(10000) },
    ];
    expect(
      compactRunningContext({ request: base, continuation: batch }).checkpoint
        .throughContinuationCount,
    ).toBe(3);
    const checkpoint = compactRunningContext({ request: base, continuation: batch }).checkpoint;
    expect(() =>
      projectRunningContext(base.messages, batch, { ...checkpoint, throughContinuationCount: 2 }),
    ).toThrow('교환');
    expect(() => compactRunningContext({ request: base, continuation: batch.slice(0, 2) })).toThrow(
      '완료되지',
    );
    expect(() => compactRunningContext({ request: base, continuation: batch.slice(1) })).toThrow(
      '짝',
    );
    expect(() =>
      compactRunningContext({ request: base, continuation: [batch[0]!, batch[1]!, batch[1]!] }),
    ).toThrow('완료되지');
  });

  it('refuses to truncate oversized fixed instructions, user requests or tool definitions', () => {
    for (const part of ['system', 'user', 'tools']) {
      const base = request();
      if (part === 'tools')
        base.tools = [
          {
            type: 'function',
            function: {
              name: 'large',
              description: 'x'.repeat(16000),
              parameters: {},
            },
          },
        ];
      else base.messages[part === 'system' ? 0 : 1]!.content = 'x'.repeat(16000);
      expect(() => compactRunningContext({ request: base, continuation: exchanges(1) })).toThrow(
        '고정',
      );
    }
  });

  it('extends a durable checkpoint across more exchanges and can reduce it for an exact tokenizer', () => {
    const base = request(),
      continuation = exchanges(8);
    const first = compactRunningContext({ request: base, continuation });
    const more = [
      ...continuation,
      ...exchanges(4).map((entry) => ({
        ...entry,
        ...(entry.toolCallId ? { toolCallId: 'more-' + entry.toolCallId } : {}),
        ...(entry.toolCalls
          ? { toolCalls: entry.toolCalls.map((call) => ({ ...call, id: 'more-' + call.id })) }
          : {}),
      })),
    ];
    const next = compactRunningContext({
      request: base,
      continuation: more,
      previous: first.checkpoint,
    });
    expect(next.checkpoint.throughContinuationCount).toBeGreaterThan(
      first.checkpoint.throughContinuationCount,
    );
    expect(next.checkpoint.count).toBe(2);
    expect(projectRunningContext([], more, next.checkpoint)[0]?.content).toContain(
      'running context checkpoint',
    );
    let checkpoint = next.checkpoint;
    while (checkpoint.throughContinuationCount < more.length) {
      checkpoint = compactRunningContext({
        request: base,
        continuation: more,
        previous: checkpoint,
        force: true,
      }).checkpoint;
    }
    const reduced = compactRunningContext({
      request: base,
      continuation: more,
      previous: checkpoint,
      force: true,
    });
    expect(reduced.checkpoint.summary.length).toBeLessThan(checkpoint.summary.length);
  });
});
