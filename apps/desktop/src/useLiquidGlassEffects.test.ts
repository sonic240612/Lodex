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
    matches = initiallyReduced;
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
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;
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
    requestAnimationFrame: vi.fn((callback: FrameRequestCallback) => {
      frames.set(++nextFrame, callback);
      return nextFrame;
    }),
    cancelAnimationFrame: vi.fn((id: number) => frames.delete(id)),
  };
  const properties = new Map<string, string>();
  const surface = {
    style: {
      setProperty: (name: string, value: string) => properties.set(name, value),
      removeProperty: (name: string) => properties.delete(name),
    },
    closest: () => surface,
    getBoundingClientRect: () => ({ left: 20, top: 10, width: 200, height: 100 }),
  };
  const root = Object.assign(new EventTarget(), {
    ownerDocument: { defaultView: view },
    contains: (element: unknown) => element === surface,
  });
  const move = (x = 70, y = 35, pointerType = 'mouse') => {
    const event = new Event('pointermove');
    Object.defineProperties(event, {
      target: { value: surface },
      clientX: { value: x },
      clientY: { value: y },
      pointerType: { value: pointerType },
    });
    root.dispatchEvent(event);
  };
  const flush = () => {
    const callbacks = [...frames.values()];
    frames.clear();
    callbacks.forEach((callback) => callback(0));
  };
  return {
    root: root as unknown as HTMLElement,
    properties,
    preferences,
    frames,
    view,
    move,
    flush,
  };
}

describe('Liquid Glass pointer effects', () => {
  it('coalesces movement into one frame and clears reflections when the pointer leaves', () => {
    const f = fixture();
    const cleanup = attachLiquidGlassEffects(f.root);
    f.move();
    f.move(170, 35);
    expect(f.frames.size).toBe(1);
    expect(f.properties.size).toBe(0);
    f.flush();
    expect(f.properties.get('--glass-pointer-x')).toBe('75.0%');
    expect(f.properties.get('--glass-pointer-y')).toBe('25.0%');
    f.root.dispatchEvent(new Event('pointerleave'));
    expect(f.properties.size).toBe(0);
    cleanup();
  });

  it('immediately honors accessibility preferences and fully cleans up pending work', () => {
    const f = fixture();
    const cleanup = attachLiquidGlassEffects(f.root);
    f.move();
    f.flush();
    f.move();
    f.preferences.motion.update(true);
    expect(f.frames.size).toBe(0);
    expect(f.properties.size).toBe(0);
    f.move();
    expect(f.frames.size).toBe(0);
    f.preferences.transparency.update(true);
    f.preferences.motion.update(false);
    f.move();
    expect(f.frames.size).toBe(0);
    f.preferences.transparency.update(false);
    f.move();
    expect(f.frames.size).toBe(1);
    cleanup();
    expect(f.frames.size).toBe(0);
    f.preferences.motion.update(true);
    f.preferences.motion.update(false);
    f.move();
    expect(f.frames.size).toBe(0);
  });

  it('does not track reduced effects or touch pointers', () => {
    const f = fixture(true);
    const cleanup = attachLiquidGlassEffects(f.root);
    f.move();
    expect(f.view.requestAnimationFrame).not.toHaveBeenCalled();
    Object.values(f.preferences).forEach((preference) => preference.update(false));
    f.move(70, 35, 'touch');
    expect(f.view.requestAnimationFrame).not.toHaveBeenCalled();
    cleanup();
  });

  it('allows explicit full motion to override only reduced motion', () => {
    const f = fixture();
    f.preferences.motion.update(true);
    const cleanup = attachLiquidGlassEffects(f.root, true);
    f.move();
    f.flush();
    expect(f.properties.get('--glass-pointer-active')).toBe('1');
    expect(gestures.attach).toHaveBeenCalledOnce();
    for (const preference of [
      f.preferences.transparency,
      f.preferences.forcedColors,
      f.preferences.contrast,
    ]) {
      preference.update(true);
      expect(f.properties.size).toBe(0);
      f.move();
      expect(f.frames.size).toBe(0);
      preference.update(false);
      f.move();
      f.flush();
      expect(f.properties.get('--glass-pointer-active')).toBe('1');
    }
    cleanup();
    expect(gestures.cleanup).toHaveBeenCalledTimes(4);
  });

  it('never starts pointer or control effects when explicitly disabled', () => {
    const f = fixture();
    const cleanup = attachLiquidGlassEffects(f.root, false);
    f.move();
    f.preferences.motion.update(true);
    f.preferences.motion.update(false);
    f.move();
    expect(f.frames.size).toBe(0);
    expect(gestures.attach).not.toHaveBeenCalled();
    cleanup();
  });

  it('stops control springs and removes preference listeners when cleaned up', () => {
    const f = fixture();
    const cleanup = attachLiquidGlassEffects(f.root);
    f.move();
    cleanup();
    expect(f.frames.size).toBe(0);
    expect(gestures.cleanup).toHaveBeenCalledOnce();
    Object.values(f.preferences).forEach((preference) => {
      preference.update(true);
      preference.update(false);
    });
    f.move();
    expect(f.frames.size).toBe(0);
    expect(gestures.attach).toHaveBeenCalledOnce();
  });
});
