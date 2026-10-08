import { beforeEach, describe, expect, it, vi } from 'vitest';
import { attachGlassControlGestures } from './glass-control-gestures';

const animation = vi.hoisted(() => ({ animate: vi.fn() }));
vi.mock('motion', () => ({ animate: animation.animate }));

type TestButton = {
  disabled: boolean;
  managed: boolean;
  style: { transform: string };
  closest: () => TestButton;
  hasAttribute: (name: string) => boolean;
};
type Spring = {
  button: TestButton;
  values: { scale: number; y: number };
  options: { type: string; onComplete: () => void };
  stop: ReturnType<typeof vi.fn>;
};
let springs: Spring[];

beforeEach(() => {
  springs = [];
  animation.animate.mockReset().mockImplementation((button, values, options) => {
    const stop = vi.fn();
    springs.push({ button, values, options, stop });
    // Emulate Motion owning the inline transform while an animation is in flight.
    button.style.transform = `translateY(${values.y}px) scale(${values.scale})`;
    return { stop };
  });
});

function fixture() {
  const buttons = new Set<TestButton>();
  const root = Object.assign(new EventTarget(), {
    contains: (button: TestButton) => buttons.has(button),
  });
  function button(transform = ''): TestButton {
    const result: TestButton = {
      disabled: false,
      managed: false,
      style: { transform },
      closest: () => result,
      hasAttribute: (name) => name === 'data-motion-managed' && result.managed,
    };
    buttons.add(result);
    return result;
  }
  function dispatch(type: string, target: TestButton | null, extra: Record<string, unknown> = {}) {
    const event = new Event(type, { cancelable: true });
    for (const [name, value] of Object.entries({
      target,
      pointerType: 'mouse',
      button: 0,
      ...extra,
    })) {
      Object.defineProperty(event, name, { value });
    }
    root.dispatchEvent(event);
    return event;
  }
  return { root: root as unknown as HTMLElement, button, dispatch, buttons };
}

describe('glass control gestures', () => {
  it('lifts on hover, compresses on press, and springs back without intercepting native events', () => {
    const f = fixture();
    const button = f.button();
    const cleanup = attachGlassControlGestures(f.root);
    const over = f.dispatch('pointerover', button);
    expect(springs.at(-1)?.values.scale).toBeGreaterThan(1);
    expect(springs.at(-1)?.values.y).toBeLessThan(0);
    const down = f.dispatch('pointerdown', button);
    expect(springs.at(-1)?.values.scale).toBeLessThan(1);
    expect(springs[0]?.stop).toHaveBeenCalledOnce();
    const up = f.dispatch('pointerup', button);
    expect(springs.at(-1)?.values.scale).toBeGreaterThan(1);
    expect(springs.every((spring) => spring.options.type === 'spring')).toBe(true);
    expect([over, down, up].every((event) => !event.defaultPrevented)).toBe(true);
    f.dispatch('pointerout', button, { relatedTarget: null });
    expect(springs.at(-1)?.values).toEqual({ scale: 1, y: 0 });
    springs.at(-1)?.options.onComplete();
    expect(button.style.transform).toBe('');
    cleanup();
  });

  it('animates the next control when moving directly between adjacent buttons', () => {
    const f = fixture();
    const first = f.button();
    const next = f.button();
    const cleanup = attachGlassControlGestures(f.root);
    f.dispatch('pointerover', first);
    f.dispatch('pointerout', first, { relatedTarget: next });
    f.dispatch('pointerover', next, { relatedTarget: first });
    expect(springs.at(-1)?.button).toBe(next);
    expect(springs.at(-1)?.values.scale).toBeGreaterThan(1);
    cleanup();
  });

  it('keeps Enter and Space activation native while animating press and release', () => {
    const f = fixture();
    const button = f.button();
    const cleanup = attachGlassControlGestures(f.root);
    for (const key of ['Enter', ' ']) {
      const down = f.dispatch('keydown', button, { key, repeat: false });
      expect(springs.at(-1)?.values.scale).toBeLessThan(1);
      const count = springs.length;
      f.dispatch('keydown', button, { key, repeat: true });
      expect(springs.length).toBe(count);
      const up = f.dispatch('keyup', button, { key });
      expect(springs.at(-1)?.values).toEqual({ scale: 1, y: 0 });
      expect(down.defaultPrevented || up.defaultPrevented).toBe(false);
      springs.at(-1)?.options.onComplete();
    }
    const count = springs.length;
    f.dispatch('keydown', button, { key: 'Tab', repeat: false });
    f.dispatch('keyup', button, { key: 'Tab' });
    expect(springs.length).toBe(count);
    cleanup();
  });

  it('ignores disabled, externally managed, and out-of-root controls and right clicks', () => {
    const f = fixture();
    const disabled = f.button();
    disabled.disabled = true;
    const managed = f.button();
    managed.managed = true;
    const outside = f.button();
    f.buttons.delete(outside);
    const normal = f.button();
    const cleanup = attachGlassControlGestures(f.root);
    for (const button of [disabled, managed, outside]) {
      f.dispatch('pointerover', button);
      f.dispatch('pointerdown', button);
    }
    f.dispatch('pointerdown', normal, { button: 2 });
    f.dispatch('pointerover', normal, { pointerType: 'touch' });
    expect(animation.animate).not.toHaveBeenCalled();
    cleanup();
  });

  it('resets cancellation and preserves original styles after completion or cleanup', () => {
    const f = fixture();
    const button = f.button('rotate(2deg)');
    const cleanup = attachGlassControlGestures(f.root);
    f.dispatch('pointerover', button);
    f.dispatch('pointerdown', button);
    f.dispatch('pointercancel', button);
    expect(springs.at(-1)?.values).toEqual({ scale: 1, y: 0 });
    springs.at(-1)?.options.onComplete();
    expect(button.style.transform).toBe('rotate(2deg)');
    f.dispatch('pointerover', button);
    const interrupted = springs.at(-1)!;
    cleanup();
    expect(interrupted.stop).toHaveBeenCalledOnce();
    expect(button.style.transform).toBe('rotate(2deg)');
    const count = springs.length;
    f.dispatch('pointerover', button);
    f.dispatch('pointerdown', button);
    f.dispatch('keydown', button, { key: 'Enter' });
    expect(springs.length).toBe(count);
  });

  it('does not let completion of an interrupted reset overwrite a newer animation', () => {
    const f = fixture();
    const button = f.button();
    const cleanup = attachGlassControlGestures(f.root);
    f.dispatch('pointerover', button);
    f.dispatch('pointerout', button, { relatedTarget: null });
    const staleReset = springs.at(-1)!;
    f.dispatch('pointerover', button);
    const currentTransform = button.style.transform;
    staleReset.options.onComplete();
    expect(button.style.transform).toBe(currentTransform);
    cleanup();
    expect(button.style.transform).toBe('');
  });
});
