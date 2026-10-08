import { describe, expect, it, vi } from 'vitest';
import { defaultModelConfig, type ModelDescriptor } from '@lodex/contracts';
import { ModelCatalogLoader, modelCatalogSource, selectCatalogModel } from './model-catalog';

const descriptor: ModelDescriptor = {
  id: 'org/new-model',
  name: 'New model',
  contextLength: 128000,
  defaultTemperature: 0.6,
  defaultTopP: 0.9,
  maxCompletionTokens: 16000,
  tools: true,
  pricing: null,
};

describe('model catalog requests', () => {
  it('does not repeatedly fetch on a failure and allows an explicit retry', async () => {
    const loader = new ModelCatalogLoader();
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new Error('HTTP 429'))
      .mockResolvedValue([descriptor]);
    const source = modelCatalogSource({ ...defaultModelConfig(), provider: 'openrouter' });
    await expect(loader.load(source, fetch)).rejects.toThrow('HTTP 429');
    for (let i = 0; i < 4; i++)
      await expect(loader.load(source, fetch)).rejects.toThrow('HTTP 429');
    expect(fetch).toHaveBeenCalledTimes(1);
    await expect(loader.load(source, fetch, true)).resolves.toEqual([descriptor]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('deduplicates pending requests and rejects stale refresh results', async () => {
    const loader = new ModelCatalogLoader();
    let resolve!: (models: ModelDescriptor[]) => void;
    const fetch = vi.fn(
      () =>
        new Promise<ModelDescriptor[]>((yes) => {
          resolve = yes;
        }),
    );
    const pending = loader.load('source', fetch);
    expect(loader.load('source', fetch)).toBe(pending);
    expect(fetch).toHaveBeenCalledTimes(1);
    const refreshed = loader.load('source', async () => [descriptor], true);
    expect(await refreshed).toEqual([descriptor]);
    resolve([]);
    await pending;
    expect(loader.isCurrent('source', pending)).toBe(false);
    expect(loader.isCurrent('source', refreshed)).toBe(true);
  });

  it('preserves custom saved settings when selecting the same catalog entry', () => {
    const saved = {
      ...defaultModelConfig(),
      provider: 'openrouter' as const,
      model: descriptor.id,
      contextBudgetTokens: 32000,
      maxTokens: 2048,
      temperature: 0.21,
      topP: 0.73,
    };
    expect(selectCatalogModel(saved, descriptor)).toBe(saved);
  });

  it('applies defaults and provider output limit when explicitly choosing another model', () => {
    const saved = {
      ...defaultModelConfig(),
      model: 'old-model',
      contextBudgetTokens: 32000,
      autoMaxTokens: true,
      temperature: 0.21,
      topP: 0.73,
    };
    expect(selectCatalogModel(saved, descriptor)).toMatchObject({
      model: descriptor.id,
      contextBudgetTokens: 128000,
      maxTokens: 16000,
      temperature: 0.6,
      topP: 0.9,
    });
    expect(saved.model).toBe('old-model');
  });
});
