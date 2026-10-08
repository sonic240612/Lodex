import { expect, it } from 'vitest';
import { defaultModelConfig, defaultPlan, type Message, type Session } from '@lodex/contracts';
import { compileContext, prepareSemanticCompaction, compactRunningContext } from './index';
import { evidenceExcerpt, planningHandoff, researchEvidence } from './handoff';

function fixture() {
  const config = {
    ...defaultModelConfig(),
    contextBudgetTokens: 16000,
    maxTokens: 3200,
    autoMaxTokens: true,
  };
  const user: Message = {
    id: crypto.randomUUID(),
    role: 'user',
    content: 'Investigate before implementing.',
    createdAt: '',
    status: 'complete',
    error: null,
    usage: null,
  };
  const answer: Message = {
    id: crypto.randomUUID(),
    role: 'assistant',
    agentMode: 'plan',
    inferenceConfig: { ...config, model: 'planner' },
    content: 'Investigation done. Implement the agreed change.',
    createdAt: '',
    status: 'complete',
    error: null,
    usage: null,
    continuation: [
      {
        role: 'assistant',
        content: '',
        reasoningContent: 'OLD_MODEL_PRIVATE_REASONING',
        reasoningDetails: [{ index: 0, data: 'OLD_OPAQUE_STATE' }],
        toolCalls: [{ id: 'plan-read', name: 'read_file', arguments: '{"path":"src/app.ts"}' }],
      },
      {
        role: 'tool',
        toolCallId: 'plan-read',
        toolName: 'read_file',
        content:
          '{"path":"src/app.ts","sha256":"' +
          'a'.repeat(64) +
          '","lines":[{"line":7,"text":"PLAN_TOOL_FACT_ONLY"}]}',
      },
      { role: 'assistant', content: 'Investigation done. Implement the agreed change.' },
    ],
  };
  const session: Session = {
    id: crypto.randomUUID(),
    version: 1,
    title: '',
    createdAt: '',
    updatedAt: '',
    config: { ...config, model: 'builder' },
    mode: 'build',
    run: null,
    plan: defaultPlan(),
    messages: [user, answer],
  };
  return { session, answer };
}
it('carries Plan findings and exact recall IDs into Build across a model change and an existing lossy checkpoint', () => {
  const { session, answer } = fixture();
  session.contextCompaction = {
    throughMessageId: answer.id,
    summary: 'Lossy prose omitted the investigation.',
    createdAt: new Date().toISOString(),
    reason: 'eco',
    compactedMessageCount: 2,
    originalEstimateTokens: 9000,
    compactedEstimateTokens: 1000,
  };
  const before = structuredClone(session),
    compiled = compileContext(session, 'Build from the investigation.');
  expect(compiled.request.messages.at(-1)?.content).toContain('PLAN_TOOL_FACT_ONLY');
  expect(compiled.request.messages.at(-1)?.content).toContain('plan-read');
  expect(compiled.manifest.handoff).toMatchObject({
    sourceMessageId: answer.id,
    sourceMode: 'plan',
    includedToolResults: 1,
  });
  expect(JSON.stringify(compiled.request)).not.toContain('OLD_MODEL_PRIVATE_REASONING');
  expect(JSON.stringify(compiled.request)).not.toContain('OLD_OPAQUE_STATE');
  expect(compiled.request.messages[0]?.content).toContain('do not restart investigation');
  expect(session).toEqual(before);
  const continuation = Array.from({ length: 8 }, (_, i) => [
    {
      role: 'assistant' as const,
      content: '',
      toolCalls: [{ id: `read-${i}`, name: 'read_file', arguments: '{}' }],
    },
    { role: 'tool' as const, toolCallId: `read-${i}`, content: 'x'.repeat(4000) },
  ]).flat();
  expect(
    compactRunningContext({ request: compiled.request, continuation }).request.messages.some(
      (message) => message.role === 'user' && message.content.includes('PLAN_TOOL_FACT_ONLY'),
    ),
  ).toBe(true);
});
it('preserves investigation excerpts and recall references in fast and LLM compaction input', () => {
  const { session, answer } = fixture();
  session.mode = 'plan';
  session.messages.push(
    ...Array.from({ length: 6 }, (_, i): Message => ({
      id: crypto.randomUUID(),
      role: i % 2 ? 'assistant' : 'user',
      content: `later ${i}`,
      createdAt: '',
      status: 'complete',
      error: null,
      usage: null,
    })),
  );
  const fast = compileContext(session, '', [], undefined, { forceCompaction: true });
  expect(fast.compaction?.summary).toContain('PLAN_TOOL_FACT_ONLY');
  expect(fast.compaction?.summary).toContain(answer.id);
  const semantic = prepareSemanticCompaction(session);
  expect(semantic.request.messages[1]?.content).toContain('PLAN_TOOL_FACT_ONLY');
  expect(semantic.request.messages[1]?.content).toContain('plan-read');
});
it('carries completed reads from an interrupted Plan without treating the partial reply as findings', () => {
  const { session, answer } = fixture();
  answer.status = 'interrupted';
  answer.content = 'UNFINISHED_PLAN_CLAIM';
  answer.continuation!.pop();
  const compiled = compileContext(session, 'Continue in Build.');
  expect(compiled.request.messages.at(-1)?.content).toContain('PLAN_TOOL_FACT_ONLY');
  expect(JSON.stringify(compiled.request)).not.toContain('UNFINISHED_PLAN_CLAIM');
  expect(compiled.manifest.handoff).toMatchObject({
    sourceStatus: 'interrupted',
    sourceMode: 'plan',
    includedToolResults: 1,
  });
  expect(compiled.manifest.excludedMessageIds).toContain(answer.id);
});
it('keeps handoff JSON bounded and distinguishes legacy evidence, failures and completed Build work', () => {
  const { session, answer } = fixture();
  delete answer.agentMode;
  answer.continuation!.push({
    role: 'tool',
    toolCallId: 'failed',
    toolName: 'web_fetch',
    content: 'DO_NOT_USE_FAILED_RESEARCH',
    isError: true,
  });
  expect(researchEvidence(answer)).toHaveLength(1);
  const handoff = planningHandoff(session, 1500)!;
  expect(Buffer.byteLength(handoff.text)).toBeLessThanOrEqual(1500);
  expect(handoff.manifest.sourceMode).toBe('unknown');
  expect(JSON.parse(handoff.text.slice(handoff.text.indexOf('\n') + 1)).sourceMessageId).toBe(
    answer.id,
  );
  expect(handoff.text).not.toContain('DO_NOT_USE_FAILED_RESEARCH');
  answer.agentMode = 'build';
  expect(planningHandoff(session, 3000)).toBeUndefined();
  answer.agentMode = 'plan';
  session.mode = 'plan';
  expect(planningHandoff(session, 3000)).toBeUndefined();
  expect(Buffer.byteLength(evidenceExcerpt('한글🙂'.repeat(40), 30))).toBeLessThanOrEqual(30);
});
