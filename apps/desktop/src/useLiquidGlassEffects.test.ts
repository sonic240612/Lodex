import { describe, expect, it, vi } from 'vitest';
import { attachLiquidGlassEffects } from './useLiquidGlassEffects';

function fixture(initiallyReduced = false) {
  class Preference extends EventTarget {
    matches = initiallyReduced;
    update(matches: boolean) {
      this.matches = matches;
      this.dispatchEvent(new Event('change'));
    }
  }
  const preferences = [new Preference(), new Preference()];
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;
  const view = {
    matchMedia: (query: string) => preferences[query.includes('transparency') ? 1 : 0]!,
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

  it('immediately honors both accessibility preferences and fully cleans up pending work', () => {
    const f = fixture();
    const cleanup = attachLiquidGlassEffects(f.root);
    f.move();
    f.flush();
    f.move();
    f.preferences[0]!.update(true);
    expect(f.frames.size).toBe(0);
    expect(f.properties.size).toBe(0);
    f.move();
    expect(f.frames.size).toBe(0);
    f.preferences[1]!.update(true);
    f.preferences[0]!.update(false);
    f.move();
    expect(f.frames.size).toBe(0);
    f.preferences[1]!.update(false);
    f.move();
    expect(f.frames.size).toBe(1);
    cleanup();
    expect(f.frames.size).toBe(0);
    f.preferences[0]!.update(true);
    f.preferences[0]!.update(false);
    f.move();
    expect(f.frames.size).toBe(0);
  });

  it('does not track reduced effects or touch pointers', () => {
    const f = fixture(true);
    const cleanup = attachLiquidGlassEffects(f.root);
    f.move();
    expect(f.view.requestAnimationFrame).not.toHaveBeenCalled();
    f.preferences.forEach((preference) => preference.update(false));
    f.move(70, 35, 'touch');
    expect(f.view.requestAnimationFrame).not.toHaveBeenCalled();
    cleanup();
  });
});
