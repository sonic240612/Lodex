import { expect, it, vi } from 'vitest';
import type { ModelDescriptor } from '@lodex/contracts';
import { OpenRouterCatalog } from './model-catalog';

const models: ModelDescriptor[] = [
  {
    id: 'vendor/model',
    name: 'Model',
    contextLength: 32768,
    maxCompletionTokens: 4096,
    defaultTemperature: null,
    defaultTopP: null,
    tools: true,
    pricing: null,
  },
];
function fixture() {
  let state: { version: number; document: unknown } | null = null;
  let now = Date.parse('2026-01-01T00:00:00Z');
  const store = {
    integration: vi.fn(async () => state),
    saveIntegration: vi.fn(async (_name: string, version: number, document: unknown) => {
      if (version !== (state?.version ?? 0)) throw new Error('conflict');
      state = { version: version + 1, document: structuredClone(document) };
      return state.version;
    }),
  };
  const fetch = vi.fn(async () => models);
  return {
    store,
    fetch,
    advance: (ms: number) => {
      now += ms;
    },
    now: () => now,
    cache: new OpenRouterCatalog(store, fetch, () => now),
  };
}
it('persists a public catalog across manager restart and honors explicit refresh', async () => {
  const { store, fetch, cache, now } = fixture();
  expect((await cache.get()).source).toBe('live');
  const reopened = new OpenRouterCatalog(store, fetch, now);
  expect((await reopened.get()).source).toBe('cache');
  expect(fetch).toHaveBeenCalledTimes(1);
  await reopened.get(true);
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(store.saveIntegration.mock.calls)).not.toMatch(/Bearer|api_key|baseUrl/);
});
it('marks offline results stale, retains their timestamp and expires them after 30 days', async () => {
  const { cache, fetch, advance } = fixture();
  const live = await cache.get();
  advance(7 * 60 * 60 * 1000);
  fetch.mockRejectedValue(new Error('offline'));
  const offline = await cache.get();
  expect(offline.stale).toBe(true);
  expect(offline.fetchedAt).toBe(live.fetchedAt);
  expect(offline.notice).toContain('저장된');
  advance(30 * 24 * 60 * 60 * 1000);
  await expect(cache.get()).rejects.toThrow('offline');
});
it('shares concurrent refreshes and returns live data when cache writes fail', async () => {
  const { cache, store, fetch } = fixture();
  store.saveIntegration.mockRejectedValue(new Error('disk'));
  const [a, b] = await Promise.all([cache.get(true), cache.get(true)]);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(a).toEqual(b);
  expect(a.stale).toBe(false);
  expect(a.notice).toContain('저장하지');
});
