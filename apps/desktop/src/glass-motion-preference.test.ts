import { describe, expect, it } from 'vitest';
import {
  loadGlassEffectsPreference,
  resolveGlassMotion,
  saveGlassEffectsPreference,
} from './glass-motion-preference';
import { glassPanelLayout } from './GlassMotion';

describe('glass motion preferences', () => {
  it('follows accessibility settings by default and only overrides motion on explicit opt-in', () => {
    expect(loadGlassEffectsPreference({ getItem: () => null, setItem() {} })).toBe('system');
    expect(resolveGlassMotion('system', true)).toBe(false);
    expect(resolveGlassMotion('system', false)).toBe(true);
    expect(resolveGlassMotion('full', true)).toBe(true);
    expect(resolveGlassMotion('reduced', false)).toBe(false);
  });

  it('persists all three choices and tolerates blocked storage', () => {
    let stored: string | null = null;
    const storage = {
      getItem: () => stored,
      setItem: (_key: string, value: string) => {
        stored = value;
      },
    };
    for (const choice of ['full', 'reduced', 'system'] as const) {
      saveGlassEffectsPreference(choice, storage);
      expect(loadGlassEffectsPreference(storage)).toBe(choice);
    }
    stored = 'invalid';
    expect(loadGlassEffectsPreference(storage)).toBe('system');
    const blocked = {
      getItem() {
        throw Error('blocked');
      },
      setItem() {
        throw Error('blocked');
      },
    };
    expect(loadGlassEffectsPreference(blocked)).toBe('system');
    expect(() => saveGlassEffectsPreference('full', blocked)).not.toThrow();
  });
});

describe('glass panel layout', () => {
  it('keeps the reading column stable while desktop side tracks open and close', () => {
    expect(glassPanelLayout(1440, true, true)).toMatchObject({ sidebarTrack: 246, planTrack: 300 });
    expect(glassPanelLayout(1440, false, true)).toMatchObject({ sidebarTrack: 0, planTrack: 300 });
    expect(glassPanelLayout(1700, true, true)).toMatchObject({ sidebarTrack: 260, planTrack: 320 });
    expect(glassPanelLayout(1440, false, false)).toMatchObject({ sidebarTrack: 0, planTrack: 0 });
  });
  it('uses overlays without taking chat width on small windows', () => {
    expect(glassPanelLayout(1000, true, true)).toMatchObject({ sidebarTrack: 220, planTrack: 0 });
    expect(glassPanelLayout(600, true, true)).toEqual({
      sidebarTrack: 0,
      planTrack: 0,
      sidebarWidth: undefined,
      planWidth: undefined,
    });
  });
});
