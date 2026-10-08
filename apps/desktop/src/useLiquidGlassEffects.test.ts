import { beforeEach, describe, expect, it, vi } from 'vitest';
import { attachLiquidGlassEffects } from './useLiquidGlassEffects';

const gestures = vi.hoisted(() => ({ attach: vi.fn(), cleanup: vi.fn() }));
vi.mock('./glass-control-gestures', () => ({ attachGlassControlGestures: gestures.attach }));

beforeEach(() => {
  gestures.attach.mockReset().mockImplementation(() => gestures.cleanup);
  gestures.cleanup.mockReset();
});

function fixture(initiallyReduced = false) {
  class Preference extends EventTarget {
    matches = false;
    update(matches: boolean) {
      this.matches = matches;
      this.dispatchEvent(new Event('change'));
    }
  }
  const preferences = {
    motion: new Preference(),
    transparency: new Preference(),
    forcedColors: new Preference(),
    contrast: new Preference(),
  };
  preferences.motion.matches = initiallyReduced;
  const view = {
    matchMedia: (query: string) => {
      switch (query) {
        case '(prefers-reduced-motion: reduce)':
          return preferences.motion;
        case '(prefers-reduced-transparency: reduce)':
          return preferences.transparency;
        case '(forced-colors: active)':
          return preferences.forcedColors;
        case '(prefers-contrast: more)':
          return preferences.contrast;
        default:
          throw new Error(`Unexpected media query: ${query}`);
      }
    },
    requestAnimationFrame: vi.fn(),
  };
  const root = Object.assign(new EventTarget(), { ownerDocument: { defaultView: view } });
  const subscribe = vi.spyOn(root, 'addEventListener');
  return { root: root as unknown as HTMLElement, preferences, view, subscribe };
}

describe('Liquid Glass material effects lifecycle', () => {
  it('follows changes in system motion settings without duplicating gesture handlers', () => {
    const f = fixture(true);
    const cleanup = attachLiquidGlassEffects(f.root);
    expect(gestures.attach).not.toHaveBeenCalled();
    f.preferences.motion.update(false);
    f.preferences.motion.update(false);
    expect(gestures.attach).toHaveBeenCalledExactlyOnceWith(f.root);
    f.preferences.motion.update(true);
    expect(gestures.cleanup).toHaveBeenCalledOnce();
    f.preferences.transparency.update(true);
    f.preferences.motion.update(false);
    expect(gestures.attach).toHaveBeenCalledOnce();
    f.preferences.transparency.update(false);
    expect(gestures.attach).toHaveBeenCalledTimes(2);
    cleanup();
    expect(gestures.cleanup).toHaveBeenCalledTimes(2);
  });

  it('allows explicit full motion to override only the motion preference', () => {
    const f = fixture(true);
    const cleanup = attachLiquidGlassEffects(f.root, true);
    expect(gestures.attach).toHaveBeenCalledOnce();
    for (const [index, preference] of [
      f.preferences.transparency,
      f.preferences.forcedColors,
      f.preferences.contrast,
    ].entries()) {
      preference.update(true);
      expect(gestures.cleanup).toHaveBeenCalledTimes(index + 1);
      preference.update(false);
      expect(gestures.attach).toHaveBeenCalledTimes(index + 2);
    }
    cleanup();
    expect(gestures.cleanup).toHaveBeenCalledTimes(4);
  });

  it('keeps gestures disabled when reduced effects are explicitly selected', () => {
    const f = fixture();
    const cleanup = attachLiquidGlassEffects(f.root, false);
    Object.values(f.preferences).forEach((preference) => {
      preference.update(true);
      preference.update(false);
    });
    expect(gestures.attach).not.toHaveBeenCalled();
    cleanup();
    expect(gestures.cleanup).not.toHaveBeenCalled();
  });

  it('stops gestures once and removes preference listeners on cleanup', () => {
    const f = fixture();
    const cleanup = attachLiquidGlassEffects(f.root);
    cleanup();
    cleanup();
    expect(gestures.cleanup).toHaveBeenCalledOnce();
    Object.values(f.preferences).forEach((preference) => {
      preference.update(true);
      preference.update(false);
    });
    expect(gestures.attach).toHaveBeenCalledOnce();
  });

  it('does not add cursor tracking or animation-frame work, including full effects', () => {
    const f = fixture();
    const cleanup = attachLiquidGlassEffects(f.root, true);
    f.root.dispatchEvent(new Event('pointermove'));
    expect(f.subscribe).not.toHaveBeenCalled();
    expect(f.view.requestAnimationFrame).not.toHaveBeenCalled();
    expect(gestures.attach).toHaveBeenCalledOnce();
    cleanup();
  });

  it('does nothing when there is no browser view', () => {
    const root = { ownerDocument: { defaultView: null } } as unknown as HTMLElement;
    expect(() => attachLiquidGlassEffects(root)()).not.toThrow();
    expect(gestures.attach).not.toHaveBeenCalled();
  });
});
