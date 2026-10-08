import { afterEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  modelConfigSchema,
  type InferenceProvider,
  type InferenceRequest,
  type ModelDescriptor,
} from '@lodex/contracts';
import {
  runModelEvaluation,
  validateEvaluationOptions,
  type EvaluationOptions,
} from './model-evaluation';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});
async function options(overrides: Partial<EvaluationOptions> = {}): Promise<EvaluationOptions> {
  const outputDirectory = await mkdtemp(join(tmpdir(), 'lodex-eval-report-'));
  cleanups.push(async () => {
    if (dirname(resolve(outputDirectory)) !== resolve(tmpdir()))
      throw new Error('unsafe fixture cleanup');
    await rm(outputDirectory, { recursive: true, force: true });
  });
  return {
    config: modelConfigSchema.parse({ provider: 'ollama', model: 'fixture' }),
    variant: 'both',
    suite: 'smoke',
    rounds: 1,
    requestTimeoutMs: 1000,
    turnTimeoutMs: 5000,
    totalTimeoutMs: 15000,
    maxCallsPerTurn: 20,
    maxCostUsd: 0,
    allowCloud: false,
    outputDirectory,
    ...overrides,
  };
}
const descriptor: ModelDescriptor = {
  id: 'fixture',
  name: 'Fixture',
  contextLength: 32768,
  maxCompletionTokens: 6553,
  defaultTemperature: null,
  defaultTopP: null,
  tools: true,
  pricing: null,
};
function provider(
  options: { mutate?: boolean; forbidden?: boolean; cost?: number } = {},
): InferenceProvider {
  return {
    listModels: async () => [
      {
        ...descriptor,
        ...(options.cost === undefined
          ? {}
          : { pricing: { prompt: 0.00000001, completion: 0.00000001, request: 0 } }),
      },
    ],
    capabilities: async () => ({ tools: true, streaming: true }),
    async *generate(request: InferenceRequest) {
      expect(
        request.tools?.some((tool) =>
          ['run_command', 'run_host_command', 'web_fetch', 'delegate_tasks'].includes(
            tool.function.name,
          ),
        ) ?? false,
      ).toBe(false);
      const lastUserIndex = request.messages.findLastIndex((message) => message.role === 'user');
      const user = request.messages[lastUserIndex]?.content ?? '';
      const since = request.messages.slice(lastUserIndex + 1);
      const all = request.messages.map((message) => message.content).join('\n');
      if (request.purpose === 'context_summary') {
        yield {
          type: 'text_delta',
          text:
            'Project state: ' +
            (all.match(/fact-[a-f0-9]{16}/)?.[0] ?? '') +
            '. app.txt was set to theme=dark and retries=3. keep.txt and facts.txt must remain unchanged. Continue the current requested read using project tools; original observations can be recalled.',
        };
        yield { type: 'finished', reason: 'stop' };
        return;
      }
      let name = '',
        args: unknown;
      if (options.forbidden) {
        name = 'run_host_command';
        args = { command: 'should never execute' };
      } else if (
        !since.some((message) => message.role === 'tool') &&
        user.includes('Read facts.txt')
      ) {
        name = 'read_many_files';
        args = { files: [{ path: 'facts.txt' }, { path: 'app.txt' }, { path: 'keep.txt' }] };
      } else if (
        !since.some((message) => message.role === 'tool') &&
        user.includes('Update app.txt') &&
        options.mutate !== false
      ) {
        name = 'propose_edit';
        args = {
          path: 'app.txt',
          expectedHash: createHash('sha256').update('theme=light\nretries=0\n').digest('hex'),
          oldText: 'theme=light\nretries=0',
          newText: 'theme=dark\nretries=3',
        };
      } else if (
        !since.some((message) => message.role === 'tool') &&
        user.includes('Read all of notes-')
      ) {
        name = 'read_file';
        args = { path: user.match(/notes-\d+\.txt/)?.[0], maxLines: 300 };
      }
      yield {
        type: 'usage',
        usage: {
          inputTokens: 80,
          outputTokens: 20,
          ttftMs: { value: 10, source: 'app_observed' },
          decodeTps: { value: 30, source: 'engine_reported' },
          ...(options.cost === undefined ? {} : { costUsd: options.cost, billing: 'reported' }),
        },
      };
      if (name) {
        yield {
          type: 'tool_call_delta',
          id: crypto.randomUUID(),
          index: 0,
          name,
          arguments: JSON.stringify(args),
        };
        yield { type: 'finished', reason: 'tool_calls' };
      } else {
        yield {
          type: 'text_delta',
          text:
            (all.match(/fact-[a-f0-9]{16}/)?.[0] ?? 'No observation yet') +
            ' ' +
            [...all.matchAll(/note-\d+-[a-f0-9]{12}/g)].map((match) => match[0]).join(' '),
        };
        yield { type: 'finished', reason: 'stop' };
      }
    },
  };
}

it('grades actual file effects across independent baseline/Eco sessions and persists measured reports', async () => {
  const config = await options();
  const result = await runModelEvaluation(config, { providerFactory: () => provider() });
  expect(result.stopped).toBe('completed');
  expect(
    result.cases.map((item) => ({
      task: item.task,
      variant: item.variant,
      passed: item.passed,
      reasons: item.reasons,
    })),
  ).toEqual([
    { task: 'read', variant: 'baseline', passed: true, reasons: [] },
    { task: 'edit', variant: 'baseline', passed: true, reasons: [] },
    { task: 'recall', variant: 'baseline', passed: true, reasons: [] },
    { task: 'read', variant: 'eco', passed: true, reasons: [] },
    { task: 'edit', variant: 'eco', passed: true, reasons: [] },
    { task: 'recall', variant: 'eco', passed: true, reasons: [] },
  ]);
  expect(result.summary).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ variant: 'baseline', passed: 3, successRate: 1, costUsd: 0 }),
      expect.objectContaining({ variant: 'eco', passed: 3, successRate: 1, costUsd: 0 }),
    ]),
  );
  expect(result.validation).toBe('not_certified');
  expect(result.cases[0]?.calls[0]?.usage.decodeTps?.value).toBe(30);
  expect(
    JSON.parse(await readFile(join(config.outputDirectory, result.id + '.json'), 'utf8')),
  ).toEqual(result);
});

it('does not accept a model claim when the expected edit never happened', async () => {
  const result = await runModelEvaluation(await options({ variant: 'baseline' }), {
    providerFactory: () => provider({ mutate: false }),
  });
  expect(result.cases.find((item) => item.task === 'read')?.passed).toBe(true);
  expect(result.cases.find((item) => item.task === 'edit')?.reasons).toContain(
    'file_content_mismatch',
  );
  expect(result.summary[0]?.successRate).toBe(1 / 3);
});

it('scores all large observation markers and distinguishes real soak duration from an unrun soak', async () => {
  const result = await runModelEvaluation(
    await options({
      variant: 'baseline',
      suite: 'context',
      config: modelConfigSchema.parse({
        provider: 'ollama',
        model: 'fixture',
        contextBudgetTokens: 131072,
      }),
    }),
    { providerFactory: () => provider() },
  );
  expect(result.cases).toHaveLength(11);
  expect(
    result.cases.every((item) => item.passed),
    JSON.stringify(
      result.cases
        .filter((item) => !item.passed)
        .map((item) => ({ task: item.task, reasons: item.reasons })),
    ),
  ).toBe(true);
  expect(result.soakCompleted).toBe(false);
  expect(result.requestedSoakHours).toBeNull();
});

it('blocks forbidden tool calls before the harness can execute them', async () => {
  const result = await runModelEvaluation(await options({ variant: 'baseline' }), {
    providerFactory: () => provider({ forbidden: true }),
  });
  expect(result.cases.every((item) => !item.passed)).toBe(true);
  expect(result.cases[0]?.calls[0]?.errorCode).toBe('EVALUATION_TOOL_DENIED');
});

it('requires explicit cloud consent and budget before inspecting a provider', async () => {
  const config = await options({
    config: modelConfigSchema.parse({ provider: 'openrouter', model: 'fixture' }),
  });
  const factory = vi.fn(() => provider());
  await expect(runModelEvaluation(config, { providerFactory: factory })).rejects.toThrow(
    '--allow-cloud',
  );
  expect(factory).not.toHaveBeenCalled();
  expect(() => validateEvaluationOptions({ ...config, allowCloud: true, maxCostUsd: 0 })).toThrow(
    '--max-cost-usd',
  );
});

it('reserves the maximum cloud request cost and stops before exceeding the total cap', async () => {
  const config = await options({
    config: modelConfigSchema.parse({ provider: 'openrouter', model: 'fixture' }),
    allowCloud: true,
    maxCostUsd: 0.0001,
    variant: 'baseline',
  });
  const actual = provider({ cost: 0.00001 }),
    generate = vi.fn(actual.generate.bind(actual));
  const result = await runModelEvaluation(config, {
    providerFactory: () => ({ ...actual, generate }),
    apiKey: 'fixture-secret-never-log',
  });
  expect(result.stopped).toBe('cost_budget');
  expect(generate).not.toHaveBeenCalled();
  expect(JSON.stringify(result)).not.toContain('fixture-secret-never-log');
});

it('keeps uncertain cloud reservations instead of treating absent billing as free', async () => {
  const config = await options({
    config: modelConfigSchema.parse({ provider: 'openrouter', model: 'fixture' }),
    allowCloud: true,
    maxCostUsd: 0.0006,
    variant: 'baseline',
  });
  const actual = provider();
  actual.listModels = async () => [
    { ...descriptor, pricing: { prompt: 0.00000001, completion: 0.00000001, request: 0 } },
  ];
  const result = await runModelEvaluation(config, {
    providerFactory: () => actual,
    apiKey: 'fixture',
  });
  expect(result.stopped).toBe('cost_budget');
  expect(result.summary[0]?.uncertainCostUsd).toBeGreaterThan(0);
  expect(result.summary[0]?.costUsd).toBe(0);
});

it('cancels a stalled request, writes its failure and closes the temporary daemon', async () => {
  let aborted = false;
  const actual = provider();
  actual.generate = async function* (_request, signal) {
    await new Promise<never>((_resolve, reject) => {
      if (signal.aborted) return reject(signal.reason);
      signal.addEventListener(
        'abort',
        () => {
          aborted = true;
          reject(signal.reason);
        },
        { once: true },
      );
    });
  };
  const result = await runModelEvaluation(
    await options({ requestTimeoutMs: 20, variant: 'baseline' }),
    { providerFactory: () => actual },
  );
  expect(aborted).toBe(true);
  expect(result.cases[0]?.calls[0]?.errorCode).toBe('EVALUATION_TIMEOUT');
  expect(result.cases[0]?.passed).toBe(false);
});
