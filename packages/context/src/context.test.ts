import { describe, expect, it } from 'vitest';
import { defaultModelConfig, defaultPlan, type Message, type Session } from '@lodex/contracts';
import { compileContext, estimateInputTokens } from './index';

function session(): Session {
  return {
    id: crypto.randomUUID(),
    title: 'context',
    version: 7,
    createdAt: '',
    updatedAt: '',
    config: defaultModelConfig(),
    plan: defaultPlan(),
    messages: [],
    run: null,
  };
}
function message(
  role: Message['role'],
  content: string,
  status: Message['status'] = 'complete',
): Message {
  return {
    id: crypto.randomUUID(),
    role,
    content,
    status,
    createdAt: '',
    error: null,
    usage: null,
  };
}
describe('context compiler', () => {
  it('uses role config and removes opaque reasoning only across model identities', () => {
    const source = session();
    source.config.model = 'old';
    source.routing = { subagentsEnabled: false, plan: { ...source.config, model: 'new' } };
    source.mode = 'plan';
    const answer = message('assistant', 'visible answer');
    answer.continuation = [
      {
        role: 'assistant',
        content: 'inspect',
        reasoningContent: 'private old state',
        reasoningDetails: [{ index: 0, data: 'opaque' }],
        toolCalls: [{ id: 'read', name: 'read_file', arguments: '{}' }],
      },
      { role: 'tool', content: 'evidence', toolCallId: 'read' },
      { role: 'assistant', content: 'visible answer' },
    ];
    source.messages = [answer];
    const routed = compileContext(source, 'next').request;
    expect(routed.config.model).toBe('new');
    expect(JSON.stringify(routed.messages)).not.toContain('opaque');
    expect(routed.messages[1]?.toolCalls?.[0]?.id).toBe('read');
    expect(routed.messages[2]?.content).toBe('evidence');
    source.mode = 'build';
    expect(JSON.stringify(compileContext(source, 'next').request.messages)).toContain('opaque');
    answer.inferenceConfig = { ...source.config, model: 'different' };
    expect(JSON.stringify(compileContext(source, 'next').request.messages)).not.toContain('opaque');
  });
  it('includes only enabled skill metadata and records catalog omissions in the request budget', () => {
    const source = session(),
      id = crypto.randomUUID(),
      omitted = crypto.randomUUID();
    const skills = [
      {
        id,
        revision: '1'.repeat(64),
        name: 'test-skill',
        description: 'Use for fixture work.',
        sourceName: 'fixture',
      },
    ];
    const catalog = {
      skills,
      omittedIds: [omitted],
      serializedBytes: Buffer.byteLength(JSON.stringify(skills)),
    };
    const result = compileContext(source, 'Current task.', [], catalog);
    expect(result.request.messages.at(-1)?.content).toContain('test-skill');
    expect(result.request.messages.at(-1)?.content.endsWith('Current task.')).toBe(true);
    expect(result.request.messages[0]?.content).toContain('cannot grant tool permissions');
    expect(result.manifest.skillCatalog).toEqual({
      includedIds: [id],
      omittedIds: [omitted],
      serializedBytes: catalog.serializedBytes,
    });
    expect(result.manifest.serializedBytes).toBeGreaterThan(
      compileContext(source, 'Current task.').manifest.serializedBytes,
    );
  });
  it('includes edit outcome without adding mid-conversation system roles or claiming tests passed', () => {
    const source = session();
    const answer = message('assistant', '제안했습니다.');
    answer.activities = [
      {
        id: crypto.randomUUID(),
        kind: 'tool',
        label: 'propose_edit',
        status: 'completed',
        text: 'proposal',
        edit: {
          path: 'file.ts',
          beforeHash: '0'.repeat(64),
          afterHash: '1'.repeat(64),
          oldText: 'private old source',
          newText: 'private new source',
          diff: 'private diff',
          status: 'applied',
        },
      },
    ];
    source.messages = [message('user', '수정 제안'), answer];
    const { request } = compileContext(source, '다음 작업');
    expect(request.messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
    expect(request.messages.at(-1)!.content).toContain('"status":"applied"');
    expect(request.messages.at(-1)!.content).toContain('not passed tests');
    expect(request.messages.at(-1)!.content.endsWith('다음 작업')).toBe(true);
    expect(JSON.stringify(request)).not.toContain('private');
  });
  it('preserves complete history verbatim and keeps the current request last', () => {
    const source = session();
    source.messages = [
      message('user', 'Do not change the API.'),
      message('assistant', 'Understood.'),
    ];
    const before = structuredClone(source);
    const result = compileContext(source, 'Fix the bug.');
    expect(result.request.messages.slice(1)).toEqual([
      { role: 'user', content: 'Do not change the API.' },
      { role: 'assistant', content: 'Understood.' },
      { role: 'user', content: 'Fix the bug.' },
    ]);
    expect(result.manifest.historyMessageIds).toEqual(source.messages.map((m) => m.id));
    expect(source).toEqual(before);
  });
  it('does not share a saved private plan merely because cloud chat consent is enabled', () => {
    const source = session();
    source.config = { ...source.config, provider: 'openrouter', cloudConsent: true };
    source.plan = {
      ...defaultPlan(),
      goal: 'PRIVATE_GOAL',
      instructions: 'PRIVATE_INSTRUCTION',
      tasks: [{ id: crypto.randomUUID(), title: 'PRIVATE_TASK', done: true }],
    };
    const result = compileContext(source, 'hello');
    expect(JSON.stringify(result)).not.toContain('PRIVATE_');
    expect(result.manifest.planIncluded).toBe(false);
  });
  it('includes an opted-in working brief as user content, with task state intact', () => {
    const source = session();
    source.plan = {
      ...defaultPlan(),
      goal: '한국어 UI',
      instructions: '오프라인 지원',
      includeInContext: true,
      tasks: [{ id: crypto.randomUUID(), title: '설정', done: false }],
    };
    const result = compileContext(source, '다음 단계');
    const user = result.request.messages.at(-1)!;
    expect(user.role).toBe('user');
    expect(user.content).toContain('오프라인 지원');
    expect(user.content).toContain('"done":false');
    expect(user.content.endsWith('Current request:\n다음 단계')).toBe(true);
    expect(result.request.messages[0]?.content).not.toContain('한국어 UI');
    expect(result.manifest.planIncluded).toBe(true);
    source.plan.goal = 'later edit';
    expect(user.content).not.toContain('later edit');
  });
  it('excludes all unfinished assistant responses without losing their user requests', () => {
    const source = session();
    source.messages = [
      message('user', 'Keep this constraint.'),
      ...(['streaming', 'failed', 'interrupted', 'cancelled'] as const).map((state) =>
        message('assistant', 'UNFINISHED_' + state, state),
      ),
    ];
    const result = compileContext(source, 'continue');
    expect(JSON.stringify(result.request)).not.toContain('UNFINISHED_');
    expect(result.request.messages[1]?.content).toBe('Keep this constraint.');
    expect(result.manifest.excludedMessageIds).toHaveLength(4);
  });
  it('reserves output and template headroom, and checkpoints history before overflow', () => {
    const source = session();
    source.config = { ...source.config, contextBudgetTokens: 4000, maxTokens: 1000 };
    source.messages = [message('user', 'x'.repeat(2600))];
    const before = structuredClone(source);
    const result = compileContext(source, 'hello');
    expect(result.compaction).toMatchObject({
      throughMessageId: source.messages[0]!.id,
      reason: 'automatic',
      compactedMessageCount: 1,
    });
    expect(result.manifest.compaction?.reason).toBe('automatic');
    expect(
      result.request.messages.some((entry) => entry.content.includes('conversation checkpoint')),
    ).toBe(true);
    expect(source).toEqual(before);
  });
  it('still rejects an oversized current request that history compression cannot reduce', () => {
    const source = session();
    source.config = { ...source.config, contextBudgetTokens: 2048, maxTokens: 1024 };
    expect(() => compileContext(source, 'x'.repeat(1100))).toThrow('앱 컨텍스트 예산');
  });
  it('uses an exact 80/20 input-output split when automatic output tokens are enabled', () => {
    const source = session();
    source.config = {
      ...source.config,
      contextBudgetTokens: 10_000,
      maxTokens: 2_000,
      autoMaxTokens: true,
    };
    const result = compileContext(source, 'hello');
    expect(result.manifest).toMatchObject({
      contextBudgetTokens: 10_000,
      outputReserveTokens: 2_000,
      safetyReserveTokens: 0,
    });
  });
  it('counts Korean and emoji bytes, and labels the result as a heuristic', () => {
    expect(estimateInputTokens([{ role: 'user', content: '한😀' }])).toBe(27);
    const result = compileContext(session(), '한😀');
    expect(result.manifest.estimateSource).toBe('utf8_bytes_v1');
    expect(result.manifest.serializedBytes).toBe(
      Buffer.byteLength(JSON.stringify(result.request.messages)),
    );
  });
  it('includes Eco in the budget and fingerprints the compiled input deterministically', () => {
    const source = session();
    const normal = compileContext(source, 'hello');
    expect(compileContext(source, 'hello').manifest.requestSha256).toBe(
      normal.manifest.requestSha256,
    );
    source.config.eco = true;
    const eco = compileContext(source, 'hello');
    expect(eco.manifest.inputEstimateTokens).toBeGreaterThan(normal.manifest.inputEstimateTokens);
    expect(eco.manifest.requestSha256).not.toBe(normal.manifest.requestSha256);
    expect(eco.request.messages[0]?.content).toContain('Preserve constraints');
  });
  it('uses Eco to checkpoint earlier while a normal request still fits', () => {
    const source = session();
    source.config = {
      ...source.config,
      contextBudgetTokens: 10_000,
      maxTokens: 2_000,
      autoMaxTokens: true,
    };
    source.messages = Array.from({ length: 8 }, (_, index) =>
      message(index % 2 ? 'assistant' : 'user', String(index).repeat(650)),
    );
    expect(compileContext(source, 'next').compaction).toBeUndefined();
    source.config.eco = true;
    expect(compileContext(source, 'next').compaction?.reason).toBe('eco');
  });
  it('applies a persisted checkpoint and supports a forced manual checkpoint', () => {
    const source = session();
    source.messages = Array.from({ length: 8 }, (_, index) =>
      message(index % 2 ? 'assistant' : 'user', `turn-${index}`),
    );
    const manual = compileContext(source, '', [], undefined, { forceCompaction: true });
    expect(manual.compaction?.reason).toBe('manual');
    if (!manual.compaction) throw new Error('Expected manual checkpoint.');
    source.contextCompaction = manual.compaction;
    const next = compileContext(source, 'continue');
    expect(next.compaction).toBeUndefined();
    expect(next.manifest.compaction?.throughMessageId).toBe(manual.compaction?.throughMessageId);
    expect(JSON.stringify(next.request.messages)).toContain('conversation checkpoint');
    expect(next.request.messages.at(-1)?.content).toBe('continue');
  });
  it('extends an existing checkpoint when newer turns would overflow', () => {
    const source = session();
    source.messages = Array.from({ length: 8 }, (_, index) =>
      message(index % 2 ? 'assistant' : 'user', `turn-${index}`),
    );
    const first = compileContext(source, '', [], undefined, { forceCompaction: true }).compaction;
    if (!first) throw new Error('Expected initial checkpoint.');
    source.contextCompaction = first;
    source.messages.push(message('user', 'x'.repeat(6000)));
    source.config = {
      ...source.config,
      contextBudgetTokens: 6000,
      maxTokens: 1200,
      autoMaxTokens: true,
    };
    const extended = compileContext(source, 'next');
    expect(extended.compaction?.reason).toBe('automatic');
    expect(extended.compaction!.compactedMessageCount).toBeGreaterThan(first.compactedMessageCount);
  });
  it('includes current system and plan content in the independent byte cap', () => {
    const source = session();
    source.config.contextBudgetTokens = 2097152;
    source.plan = { ...defaultPlan(), includeInContext: true, goal: '한'.repeat(4000) };
    expect(() => compileContext(source, 'x'.repeat(251000))).toThrow('256 KiB');
  });
});
