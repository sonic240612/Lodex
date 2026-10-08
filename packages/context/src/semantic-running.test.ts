import { expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  defaultModelConfig,
  defaultPlan,
  RUN_INPUT_PREFIX,
  type InferenceRequest,
  type Session,
} from '@lodex/contracts';
import {
  compactRunningContextWithModel,
  compileContext,
  measureRequest,
  projectRunningContext,
} from './index';

const measure = async (request: InferenceRequest) =>
  measureRequest(request, { enforce: false }).inputEstimateTokens;
const request = (): InferenceRequest => ({
  config: {
    ...defaultModelConfig(),
    contextBudgetTokens: 8000,
    maxTokens: 1600,
    autoMaxTokens: true,
  },
  messages: [
    { role: 'system', content: 'Keep the API and current permission policy.' },
    { role: 'user', content: 'Earlier investigation. ' + 'evidence '.repeat(1400) },
    { role: 'user', content: 'Implement the researched change.' },
  ],
});

it('measures the generated summary and asks for a shorter handoff when it misses the target', async () => {
  const base = request();
  base.messages[1]!.content = 'Earlier research findings';
  let calls = 0;
  const result = await compactRunningContextWithModel({
    request: base,
    continuation: [],
    measure,
    signal: new AbortController().signal,
    summarize: async (input) => {
      calls++;
      return input.messages[0]!.content.includes('substantially shorter')
        ? 'A concise verified handoff. '.repeat(40)
        : 'Verbose handoff. '.repeat(240);
    },
  });
  expect(calls).toBe(2);
  expect(result?.checkpoint.compactedInputTokens).toBeLessThan(2400);
});

it('uses bounded tool-free LLM chunks, retains original evidence, and reaches 20–30%', async () => {
  const base = request(),
    original = structuredClone(base),
    calls: InferenceRequest[] = [];
  const result = await compactRunningContextWithModel({
    request: base,
    continuation: [],
    measure,
    signal: new AbortController().signal,
    summarize: async (input) => {
      calls.push(input);
      expect(input.tools).toBeUndefined();
      expect(() => measureRequest(input)).not.toThrow();
      return '## Progress\nVerified investigation; preserve the public API. ' + 's'.repeat(1300);
    },
  });
  expect(calls.length).toBeGreaterThan(1);
  const transcript = calls
    .map((call) => JSON.parse(call.messages[1]!.content).transcriptChunk)
    .join('');
  expect(JSON.parse(transcript).records[0].content).toBe(base.messages[1]!.content);
  expect(base).toEqual(original);
  expect(result?.checkpoint.method).toBe('semantic');
  const ratio = result!.checkpoint.compactedInputTokens! / base.config.contextBudgetTokens;
  expect(ratio).toBeGreaterThanOrEqual(0.2);
  expect(ratio).toBeLessThanOrEqual(0.3);
  expect(result!.request.messages.at(-1)?.content).toContain('## Progress');
});

it('preserves the latest live input and fresh task status while removing complete tool exchanges', async () => {
  const base = request();
  const live = { role: 'user' as const, content: RUN_INPUT_PREFIX + 'Keep CSS classes unchanged.' };
  const continuation = [
    live,
    {
      role: 'assistant' as const,
      content: '',
      toolCalls: [{ id: 'read-1', name: 'read_file', arguments: '{}' }],
    },
    {
      role: 'tool' as const,
      content: 'source '.repeat(1500),
      toolCallId: 'read-1',
      toolName: 'read_file',
    },
  ];
  const result = await compactRunningContextWithModel({
    request: base,
    continuation,
    suffix: [{ role: 'system', content: 'Task 1 complete. Task 2 in progress.' }],
    measure,
    signal: new AbortController().signal,
    summarize: async () =>
      'Read file result read-1. Task 2 remains. Preserve exact CSS class names.',
  });
  expect(result?.checkpoint.preservedInputIndex).toBe(0);
  expect(result?.request.messages).toContainEqual(live);
  expect(result?.request.messages.at(-1)?.content).toContain('Task 2 in progress');
  expect(result?.request.messages.some((m) => m.role === 'tool')).toBe(false);
  expect(continuation.at(-1)?.content).toContain('source '.repeat(1500));
});

it('reports a fixed-content floor and does not repeatedly summarize unchanged evidence', async () => {
  const base = request();
  base.messages[0]!.content = 'policy '.repeat(400);
  const result = await compactRunningContextWithModel({
    request: base,
    continuation: [],
    measure,
    signal: new AbortController().signal,
    summarize: async () =>
      'Verified earlier investigation. Continue implementation without changing the API.',
  });
  expect(result?.checkpoint.targetLimited).toBe(true);
  expect(result?.request.messages[0]).toEqual(base.messages[0]);
  expect(
    await compactRunningContextWithModel({
      request: base,
      continuation: [],
      previous: result!.checkpoint,
      measure,
      signal: new AbortController().signal,
      summarize: async () => {
        throw new Error('must not run');
      },
    }),
  ).toBeNull();
});

it('keeps prior checkpoints untouched when summarization fails or is cancelled', async () => {
  const base = request(),
    snapshot = structuredClone(base);
  await expect(
    compactRunningContextWithModel({
      request: base,
      continuation: [],
      measure,
      signal: new AbortController().signal,
      summarize: async () => {
        throw new Error('provider failed');
      },
    }),
  ).rejects.toThrow('provider failed');
  const controller = new AbortController();
  await expect(
    compactRunningContextWithModel({
      request: base,
      continuation: [],
      measure,
      signal: controller.signal,
      summarize: async () => {
        controller.abort(new Error('cancelled'));
        return 'summary';
      },
    }),
  ).rejects.toThrow('cancelled');
  expect(base).toEqual(snapshot);
});

it('does not restore compacted historical turns on the next request', async () => {
  const boundary = randomUUID();
  const result = await compactRunningContextWithModel({
    request: request(),
    continuation: [],
    historyThroughMessageId: boundary,
    measure,
    signal: new AbortController().signal,
    summarize: async () =>
      'The prior investigation is complete. Preserve the API and continue implementation.',
  });
  const session: Session = {
    run: null,
    id: randomUUID(),
    title: 'test',
    version: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    config: request().config,
    plan: defaultPlan(),
    messages: [
      {
        id: boundary,
        role: 'user',
        content: 'old bulky evidence',
        status: 'complete',
        createdAt: new Date().toISOString(),
        error: null,
        usage: null,
      },
      {
        id: randomUUID(),
        role: 'user',
        content: 'Implement the researched change.',
        status: 'complete',
        createdAt: new Date().toISOString(),
        error: null,
        usage: null,
      },
      {
        id: randomUUID(),
        role: 'assistant',
        content: 'Done',
        status: 'complete',
        createdAt: new Date().toISOString(),
        error: null,
        usage: null,
        continuation: [{ role: 'assistant', content: 'Done' }],
        runContextCompaction: result!.checkpoint,
      },
    ],
  };
  const compiled = compileContext(session, 'Continue', [], undefined, {
    deferAutoCompaction: true,
  });
  expect(JSON.stringify(compiled.request.messages)).not.toContain('old bulky evidence');
  expect(JSON.stringify(compiled.request.messages)).toContain('prior investigation is complete');
  expect(
    projectRunningContext([], session.messages[2]!.continuation!, result!.checkpoint),
  ).toHaveLength(2);
});
