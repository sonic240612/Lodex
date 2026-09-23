import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  defaultModelConfig,
  type InferenceProvider,
  type InferenceRequest,
  type SubagentRecord,
} from '@lodex/contracts';
import { inspectSkillDirectory } from '@lodex/skills';
import { parseDelegation, runSubagents } from './subagents';

const config = { ...defaultModelConfig(), provider: 'demo' as const, model: 'child' };
const provider = (generate: InferenceProvider['generate']): InferenceProvider => ({
  generate,
  listModels: async () => [],
  capabilities: async () => ({ tools: true, streaming: true }),
});
const opts = (generate: InferenceProvider['generate']) => ({
  config,
  provider: provider(generate),
  signal: new AbortController().signal,
  reserveModelCall: vi.fn(),
  reserveToolCall: vi.fn(),
  onUpdate: vi.fn(async (_records: SubagentRecord[]) => {}),
});

describe('isolated read-only subagents', () => {
  it('drains every active child after a progress persistence failure', async () => {
    let started = 0,
      releaseBoth!: () => void,
      releaseCleanup!: () => void;
    const both = new Promise<void>((resolve) => {
      releaseBoth = resolve;
    });
    const cleanup = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    let cancelling = false,
      finished = false;
    const options = opts(async function* (request, signal) {
      started++;
      if (started === 2) releaseBoth();
      await both;
      if (request.messages[1]!.content === 'second') {
        try {
          await new Promise<void>((_resolve, reject) =>
            signal.addEventListener(
              'abort',
              () => {
                cancelling = true;
                reject(signal.reason);
              },
              { once: true },
            ),
          );
        } finally {
          await cleanup;
        }
      }
      yield { type: 'text_delta', text: 'result' };
      yield { type: 'finished', reason: 'stop' };
    });
    options.onUpdate.mockImplementation(async (records) => {
      if (records[0]?.status === 'completed') throw new Error('progress disk failure');
    });
    const work = runSubagents([{ task: 'first' }, { task: 'second' }], options);
    void work.then(
      () => {
        finished = true;
      },
      () => {
        finished = true;
      },
    );
    await vi.waitFor(() => expect(cancelling).toBe(true));
    expect(finished).toBe(false);
    releaseCleanup();
    await expect(work).rejects.toThrow('progress disk failure');
  });
  it('starts independent concurrent tasks after durable intent and returns attributed summaries', async () => {
    const requests: InferenceRequest[] = [];
    let running = 0,
      peak = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const options = opts(async function* (request) {
      expect(options.onUpdate).toHaveBeenCalled();
      requests.push(structuredClone(request));
      running++;
      peak = Math.max(peak, running);
      if (requests.length === 3) release();
      await gate;
      yield { type: 'text_delta', text: 'result: ' + request.messages[1]!.content };
      yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 3 } };
      yield { type: 'finished', reason: 'stop' };
      running--;
    });
    const result = JSON.parse(
      await runSubagents([{ task: 'alpha' }, { task: 'beta' }, { task: 'gamma' }], options),
    );
    expect(peak).toBe(3);
    expect(requests.map((r) => r.messages[1]!.content)).toEqual(['alpha', 'beta', 'gamma']);
    expect(requests.every((r) => r.messages.length === 2 && !r.tools)).toBe(true);
    expect(result.subagents.map((r: SubagentRecord) => r.status)).toEqual([
      'completed',
      'completed',
      'completed',
    ]);
    expect(new Set(result.subagents.map((r: SubagentRecord) => r.id)).size).toBe(3);
    expect(options.reserveModelCall).toHaveBeenCalledTimes(3);
    expect(options.onUpdate.mock.calls[0]![0].every((r) => r.status === 'queued')).toBe(true);
    expect(JSON.stringify(result)).not.toContain('reasoningDetails');
  });

  it.each(['propose_edit', 'run_command', 'delegate_tasks', 'mcp_external'])(
    'does not dispatch unavailable child tool %s',
    async (name) => {
      const options = opts(async function* () {
        yield { type: 'tool_call_delta', index: 0, id: 'call-1', name, arguments: '{}' };
        yield { type: 'finished', reason: 'tool_calls' };
      });
      const result = JSON.parse(await runSubagents([{ task: 'try tool' }], options));
      expect(result.subagents[0].status).toBe('failed');
      expect(options.reserveToolCall).not.toHaveBeenCalled();
    },
  );

  it('loads selected skill instructions on demand without copying parent history', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'lodex-subagent-skill-'));
    try {
      await writeFile(
        join(directory, 'SKILL.md'),
        '---\nname: subagent-help\ndescription: Gives read-only review guidance.\n---\nInspect the named files and cite exact evidence.\n',
      );
      const skill = await inspectSkillDirectory(directory);
      const requests: InferenceRequest[] = [];
      const options = {
        ...opts(async function* (request) {
          requests.push(structuredClone(request));
          if (!request.messages.some((message) => message.role === 'tool')) {
            yield {
              type: 'tool_call_delta' as const,
              index: 0,
              id: 'read-skill-1',
              name: 'read_skill',
              arguments: JSON.stringify({ skillId: skill.id, revision: skill.revision }),
            };
            yield { type: 'finished' as const, reason: 'tool_calls' };
          } else {
            yield { type: 'text_delta' as const, text: 'Applied the selected review guidance.' };
            yield { type: 'finished' as const, reason: 'stop' };
          }
        }),
        skills: [skill],
      };
      const result = JSON.parse(await runSubagents([{ task: 'Review the design' }], options));
      expect(requests).toHaveLength(2);
      expect(requests[0]?.tools?.map((tool) => tool.function.name)).toEqual([
        'read_skill',
        'read_skill_resource',
      ]);
      expect(requests[0]?.messages).toHaveLength(2);
      expect(requests[1]?.messages.at(-1)?.content).toContain('Inspect the named files');
      expect(result.subagents[0]).toMatchObject({
        status: 'completed',
        skillReads: [{ skillId: skill.id, revision: skill.revision, path: 'SKILL.md' }],
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('checks the shared parent reservation before generation', async () => {
    const generate = vi.fn(async function* () {
      yield { type: 'finished' as const, reason: 'stop' };
    });
    const options = opts(generate);
    options.reserveModelCall.mockImplementation(() => {
      throw new Error('budget');
    });
    const result = JSON.parse(await runSubagents([{ task: 'blocked' }], options));
    expect(result.subagents[0].status).toBe('failed');
    expect(generate).not.toHaveBeenCalled();
  });

  it('cancels active children together and records cancellation', async () => {
    const stop = new AbortController();
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const options = opts(async function* (_request, signal) {
      started();
      await new Promise<void>((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
      );
      yield { type: 'finished', reason: 'stop' };
    });
    options.signal = stop.signal;
    const work = runSubagents([{ task: 'long task' }], options);
    await ready;
    stop.abort();
    await expect(work).rejects.toThrow();
    expect(options.onUpdate.mock.calls.at(-1)![0][0]!.status).toBe('cancelled');
  });

  it('does not start when durable intent cannot be saved', async () => {
    const generate = vi.fn(async function* () {
      yield { type: 'finished' as const, reason: 'stop' };
    });
    const options = opts(generate);
    options.onUpdate.mockRejectedValue(new Error('disk failure'));
    await expect(runSubagents([{ task: 'task' }], options)).rejects.toThrow('disk failure');
    expect(generate).not.toHaveBeenCalled();
  });

  it('treats token exhaustion as incomplete and limits UTF-8 task input', async () => {
    const options = opts(async function* () {
      yield { type: 'text_delta', text: 'partial' };
      yield { type: 'finished', reason: 'length' };
    });
    const result = JSON.parse(await runSubagents([{ task: 'task' }], options));
    expect(result.subagents[0]).toMatchObject({ status: 'failed', summary: 'partial' });
    expect(() =>
      parseDelegation(JSON.stringify({ tasks: [{ task: '한'.repeat(1400) }] })),
    ).toThrow();
    expect(() =>
      parseDelegation(JSON.stringify({ tasks: Array(4).fill({ task: 'a' }) })),
    ).toThrow();
  });
});
