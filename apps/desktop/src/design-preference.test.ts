import { describe, expect, it } from 'vitest';
import { loadDesignPreference, saveDesignPreference } from './design-preference';

describe('design preference', () => {
  it('starts with Liquid Glass when no valid selection has been saved', () => {
    for (const value of [null, '', 'unknown', 'glass']) {
      expect(loadDesignPreference({ getItem: () => value, setItem: () => {} })).toBe('glass');
    }
  });

  it('restores either design after the preference is reloaded', () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
    };
    saveDesignPreference('classic', storage);
    expect(loadDesignPreference(storage)).toBe('classic');
    saveDesignPreference('glass', storage);
    expect(loadDesignPreference(storage)).toBe('glass');
  });

  it('keeps the app usable when preference storage is blocked', () => {
    const storage = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    expect(loadDesignPreference(storage)).toBe('glass');
    expect(() => saveDesignPreference('classic', storage)).not.toThrow();
  });
});
