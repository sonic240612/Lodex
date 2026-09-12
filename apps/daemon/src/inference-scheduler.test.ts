import { describe, expect, it, vi } from 'vitest';
import {
  defaultModelConfig,
  defaultPlan,
  type InferenceRequest,
  type Session,
} from '@lodex/contracts';
import type { RuntimeManager, RuntimeLease } from '@lodex/local-runtime';
import { InferenceScheduler } from './inference-scheduler';

const session: Session = {
  id: crypto.randomUUID(),
  version: 1,
  title: 'test',
  createdAt: '',
  updatedAt: '',
  config: { ...defaultModelConfig(), model: 'base' },
  plan: defaultPlan(),
  messages: [],
  run: null,
};
const request = (model: string): InferenceRequest => ({
  config: { ...session.config, managedModelId: model, managedModelVersion: 1 },
  messages: [{ role: 'user', content: 'hello' }],
});
const consume = async (iter: AsyncIterable<unknown>) => {
  const out = [];
  for await (const event of iter) out.push(event);
  return out;
};

describe('per-generation model leases', () => {
  it('releases the parent before a different child model and cancels queued work without acquiring VRAM', async () => {
    const calls: string[] = [];
    let releaseGeneration!: () => void, started!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGeneration = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const acquire = vi.fn<RuntimeManager['acquire']>(async (id) => {
      calls.push('acquire:' + id);
      return {
        profileId: id,
        model: 'alias-' + id,
        baseUrl: 'http://127.0.0.1:10/v1',
        key: 'fixture',
        release: async () => {
          calls.push('release:' + id);
        },
      } as RuntimeLease;
    });
    const scheduler = new InferenceScheduler(
      { acquire },
      () => null,
      () => ({
        listModels: async () => [],
        capabilities: async () => ({ tools: true, streaming: true }),
        async *generate(req) {
          if (req.config.model === 'alias-parent') {
            started();
            await gate;
          }
          yield { type: 'finished', reason: 'stop' };
        },
      }),
    );
    const provider = scheduler.provider(session);
    const parent = consume(provider.generate(request('parent'), new AbortController().signal));
    await ready;
    const stop = new AbortController();
    const cancelled = consume(provider.generate(request('cancelled'), stop.signal));
    stop.abort();
    await expect(cancelled).rejects.toThrow();
    const child = consume(provider.generate(request('child'), new AbortController().signal));
    expect(calls).toEqual(['acquire:parent']);
    releaseGeneration();
    await Promise.all([parent, child]);
    expect(calls).toEqual(['acquire:parent', 'release:parent', 'acquire:child', 'release:child']);
  });

  it('releases on provider failure and maps only the owned alias back to the pinned identity', async () => {
    const release = vi.fn(async () => {});
    const acquire = vi.fn<RuntimeManager['acquire']>(
      async () =>
        ({
          profileId: 'one',
          model: 'alias',
          baseUrl: 'http://127.0.0.1:10/v1',
          key: 'fixture',
          release,
        }) as RuntimeLease,
    );
    const scheduler = new InferenceScheduler(
      { acquire },
      () => null,
      () => ({
        listModels: async () => [],
        capabilities: async () => ({ tools: true, streaming: true }),
        async *generate() {
          yield {
            type: 'provider_state_delta',
            provider: 'llama-server',
            model: 'alias',
            data: [],
          };
          throw new Error('failure');
        },
      }),
    );
    const iterator = scheduler
      .provider(session)
      .generate(request('one'), new AbortController().signal)
      [Symbol.asyncIterator]();
    expect((await iterator.next()).value).toMatchObject({ model: 'base' });
    await expect(iterator.next()).rejects.toThrow('failure');
    expect(release).toHaveBeenCalledTimes(1);
  });
});
