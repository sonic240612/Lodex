import { describe, expect, it } from 'vitest';
import { defaultModelConfig } from '@lodex/contracts';
import { loadLastModelConfig, saveLastModelConfig } from './model-preference';

function memoryStorage(initial?: string) {
  let value = initial ?? null;
  return {
    getItem: () => value,
    setItem: (_key: string, next: string) => {
      value = next;
    },
    removeItem: () => {
      value = null;
    },
    value: () => value,
  };
}

describe('last model preference', () => {
  it('round-trips the provider, model identity and generation settings', () => {
    const storage = memoryStorage();
    const config = {
      ...defaultModelConfig(),
      provider: 'openrouter' as const,
      model: 'openai/gpt-test',
      temperature: 0.2,
      contextBudgetTokens: 131072,
      autoMaxTokens: true,
      cloudConsent: true,
    };
    saveLastModelConfig(config, storage);
    expect(loadLastModelConfig(storage)).toEqual(config);
  });

  it('discards malformed or outdated preferences', () => {
    const storage = memoryStorage('{"provider":"unknown","apiKey":"secret"}');
    expect(loadLastModelConfig(storage)).toBeNull();
    expect(storage.value()).toBeNull();
  });

  it('does not fail when preference storage is unavailable', () => {
    const storage = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
    };
    expect(loadLastModelConfig(storage)).toBeNull();
    expect(() => saveLastModelConfig(defaultModelConfig(), storage)).not.toThrow();
  });
});
