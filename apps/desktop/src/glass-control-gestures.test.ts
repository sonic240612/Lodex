import { beforeEach, describe, expect, it, vi } from 'vitest';
import { attachGlassControlGestures } from './glass-control-gestures';

const motion = vi.hoisted(() => ({
  animate: vi.fn(),
  motionValue: vi.fn(),
  cancelFrame: vi.fn(),
  frame: { read: vi.fn(), render: vi.fn() },
}));
vi.mock('motion', () => motion);

type NumericValue = {
  get: () => number;
  set: (next: number) => void;
  destroy: ReturnType<typeof vi.fn>;
};
type Spring = {
  value: NumericValue;
  from: number;
  target: number;
  options: {
    type: string;
    stiffness: number;
    damping: number;
    mass: number;
    onUpdate: (value: number) => void;
    onComplete: () => void;
  };
  stop: ReturnType<typeof vi.fn>;
};
let springs: Spring[];
let reads: Set<() => void>;
let renders: Set<() => void>;

beforeEach(() => {
  springs = [];
  reads = new Set();
  renders = new Set();
  motion.frame.read.mockReset().mockImplementation((callback) => reads.add(callback));
  motion.frame.render.mockReset().mockImplementation((callback) => renders.add(callback));
  motion.cancelFrame.mockReset().mockImplementation((callback) => {
    reads.delete(callback);
    renders.delete(callback);
  });
  motion.motionValue.mockReset().mockImplementation((initial: number) => {
    let value = initial;
    return {
      get: () => value,
      set: (next: number) => {
        value = next;
      },
      destroy: vi.fn(),
    };
  });
  motion.animate.mockReset().mockImplementation((value, target, options) => {
    const stop = vi.fn();
    springs.push({ value, from: value.get(), target, options, stop });
    return { stop };
  });
});

function fixture() {
  const frames = renders;
  let clock = 0;
  const view = Object.assign(new EventTarget(), {
    performance: { now: () => clock },
    requestAnimationFrame: vi.fn(() => {
      throw new Error('The gesture should use the existing Motion frame.');
    }),
  });
  const buttons = new Set<ReturnType<typeof button>>();
  const root = Object.assign(new EventTarget(), {
    ownerDocument: { defaultView: view },
    contains: (candidate: unknown) => buttons.has(candidate as ReturnType<typeof button>),
  });
  function button(preview = false) {
    const properties = new Map<string, { value: string; priority: string }>();
    const attributes = new Map<string, string>();
    const capture = new Set<number>();
    const result = Object.assign(new EventTarget(), {
      disabled: false,
      managed: false,
      style: {
        transform: 'rotate(2deg)',
        getPropertyValue: (name: string) => properties.get(name)?.value ?? '',
        getPropertyPriority: (name: string) => properties.get(name)?.priority ?? '',
        setProperty: vi.fn((name: string, value: string, priority = '') =>
          properties.set(name, { value, priority }),
        ),
        removeProperty: (name: string) => properties.delete(name),
      },
      properties,
      closest: (): unknown => result,
      hasAttribute: (name: string): boolean =>
        (name === 'data-motion-managed' && result.managed) || attributes.has(name),
      getAttribute: (name: string) => attributes.get(name) ?? null,
      setAttribute: (name: string, value: string) => attributes.set(name, value),
      removeAttribute: (name: string) => attributes.delete(name),
      matches: (selector: string) => preview && selector === '.glass-optics-preview-lens',
      setPointerCapture: vi.fn((id: number) => capture.add(id)),
      hasPointerCapture: (id: number) => capture.has(id),
      releasePointerCapture: vi.fn((id: number) => capture.delete(id)),
      number: (property: string) => Number.parseFloat(properties.get(property)?.value ?? 'NaN'),
    });
    buttons.add(result);
    return result;
  }
  function dispatch(
    type: string,
    target: EventTarget | null,
    extra: Record<string, unknown> = {},
    destination: EventTarget = root,
  ) {
    const event = new Event(type, { cancelable: true });
    for (const [name, value] of Object.entries({
      target,
      pointerType: 'mouse',
      pointerId: 1,
      button: 0,
      isPrimary: true,
      clientX: 100,
      clientY: 100,
      detail: 1,
      ...extra,
    }))
      Object.defineProperty(event, name, { value });
    destination.dispatchEvent(event);
    return event;
  }
  function flushRead() {
    const callbacks = [...reads];
    reads.clear();
    callbacks.forEach((callback) => callback());
  }
  function flush() {
    flushRead();
    const callbacks = [...frames.values()];
    frames.clear();
    callbacks.forEach((callback) => callback());
  }
  return {
    root: root as unknown as HTMLElement,
    view,
    button,
    dispatch,
    buttons,
    flush,
    flushRead,
    frames,
    advanceClock: (milliseconds: number) => {
      clock += milliseconds;
    },
  };
}

function latestSpring() {
  return springs.slice(-6);
}
function sample(group: Spring[], progress: number) {
  for (const spring of group) {
    const next = spring.from + (spring.target - spring.from) * progress;
    spring.value.set(next);
    spring.options.onUpdate(next);
  }
}
function complete(group: Spring[]) {
  sample(group, 1);
  group.forEach((spring) => spring.options.onComplete());
}

describe('glass material gestures', () => {
  it('retargets a high-frequency drag only once per Motion frame using the newest coordinates', () => {
    const f = fixture();
    const button = f.button();
    const cleanup = attachGlassControlGestures(f.root);
    f.dispatch('pointerdown', button);
    sample(latestSpring(), 1);
    f.flush();
    const count = springs.length;
    for (let x = 101; x <= 200; x++) f.dispatch('pointermove', button, { clientX: x }, f.view);
    expect(springs.length).toBe(count);
    expect(reads.size).toBe(1);
    f.flushRead();
    expect(springs.length).toBe(count + 6);
    sample(latestSpring(), 1);
    expect(f.frames.size).toBe(1);
    f.flush();
    expect(button.number('--glass-lens-x')).toBeCloseTo(12 * Math.tanh(2), 4);
    expect(f.view.requestAnimationFrame).not.toHaveBeenCalled();
    f.dispatch('pointermove', button, { clientX: 200 }, f.view);
    f.flushRead();
    expect(springs.length).toBe(count + 6); // No restart when the target has not changed.
    cleanup();
  });

  it('does not rewrite CSS or SVG inputs when a spring update rounds to the already painted state', () => {
    const f = fixture();
    const button = f.button();
    const optical = vi.fn();
    button.addEventListener('lodex:glass-lens', optical);
    const cleanup = attachGlassControlGestures(f.root);
    f.dispatch('pointerdown', button);
    const press = latestSpring();
    sample(press, 1);
    f.flush();
    const writes = button.style.setProperty.mock.calls.length;
    const events = optical.mock.calls.length;
    sample(press, 1);
    f.flush();
    expect(button.style.setProperty).toHaveBeenCalledTimes(writes);
    expect(optical).toHaveBeenCalledTimes(events);
    const x = press[0]!;
    x.value.set(2);
    x.options.onUpdate(2);
    f.flush();
    expect(button.style.setProperty).toHaveBeenCalledTimes(writes + 1);
    expect(optical).toHaveBeenCalledTimes(events); // Translation does not change SVG thickness.
    cleanup();
  });

  it.each(['pointerup', 'blur', 'cleanup'])(
    'discards a queued drag on %s before it can restart a spring',
    (type) => {
      const f = fixture();
      const button = f.button();
      const cleanup = attachGlassControlGestures(f.root);
      f.dispatch('pointerdown', button);
      f.dispatch('pointermove', button, { clientX: 200 }, f.view);
      expect(reads.size).toBe(1);
      if (type === 'cleanup') cleanup();
      else f.dispatch(type, button, {}, f.view);
      expect(reads.size).toBe(0);
      const count = springs.length;
      f.flush();
      expect(springs.length).toBe(count);
      cleanup();
    },
  );

  it.each(['pointerout', 'pointerleave'])(
    'leaves hover and %s to CSS without allocating lenses, springs or frames',
    (type) => {
      const f = fixture();
      const button = f.button();
      const cleanup = attachGlassControlGestures(f.root);
      f.dispatch('pointerover', button);
      f.dispatch(type, button, { relatedTarget: null });
      expect(springs.length).toBe(0);
      expect(motion.motionValue).not.toHaveBeenCalled();
      expect(button.properties.size).toBe(0);
      expect(button.hasAttribute('data-glass-lens')).toBe(false);
      expect(f.frames.size).toBe(0);
      expect(reads.size).toBe(0);
      expect(button.style.transform).toBe('rotate(2deg)');
      cleanup();
    },
  );

  it('keeps the release spring only until the pointer leaves the clicked control', () => {
    const f = fixture();
    const button = f.button();
    const cleanup = attachGlassControlGestures(f.root);
    f.dispatch('pointerover', button);
    f.dispatch('pointerdown', button);
    sample(latestSpring(), 1);
    f.flush();
    f.dispatch('pointerup', button, {}, f.view);
    const release = latestSpring();
    const count = springs.length;
    sample(release, 0.5);
    f.flush();
    expect(button.number('--glass-pressure')).toBeGreaterThan(0);
    f.dispatch('pointerout', button, { relatedTarget: null });
    f.dispatch('pointerleave', null);
    expect(springs.length).toBe(count);
    expect(release.every((spring) => spring.stop.mock.calls.length === 1)).toBe(true);
    expect(button.properties.size).toBe(0);
    expect(button.hasAttribute('data-glass-lens')).toBe(false);
    sample(release, 0.8);
    f.flush();
    expect(button.properties.size).toBe(0);
    cleanup();
  });

  it('keeps a held drag active outside the control but clears it immediately when released outside', () => {
    const f = fixture();
    const button = f.button();
    const cleanup = attachGlassControlGestures(f.root);
    f.dispatch('pointerover', button);
    f.dispatch('pointerdown', button);
    f.dispatch('pointerout', button, { relatedTarget: null });
    f.dispatch('pointerleave', null);
    f.dispatch('pointermove', null, { clientX: 200 }, f.view);
    f.flushRead();
    sample(latestSpring(), 1);
    f.flush();
    expect(button.number('--glass-pressure')).toBe(1);
    expect(button.number('--glass-lens-x')).toBeGreaterThan(0);
    const count = springs.length;
    f.dispatch('pointerup', null, {}, f.view);
    expect(springs.length).toBe(count);
    expect(button.properties.size).toBe(0);
    expect(button.hasAttribute('data-glass-lens')).toBe(false);
    cleanup();
  });

  it.each([null, '', 'permanent'])(
    'restores the original lens marker (%s) after resetting the same target',
    (original) => {
      const f = fixture();
      const button = f.button();
      if (original !== null) button.setAttribute('data-glass-lens', original);
      const eventMarkers: Array<string | null> = [];
      button.addEventListener('lodex:glass-lens', () =>
        eventMarkers.push(button.getAttribute('data-glass-lens')),
      );
      const cleanup = attachGlassControlGestures(f.root);
      f.dispatch('pointerdown', button);
      expect(button.hasAttribute('data-glass-lens')).toBe(true);
      sample(latestSpring(), 1);
      f.flush();
      f.dispatch('pointerup', button, {}, f.view);
      complete(latestSpring());
      expect(eventMarkers.every((marker) => marker !== null)).toBe(true);
      expect(button.getAttribute('data-glass-lens')).toBe(original);
      f.dispatch('pointerdown', button);
      cleanup();
      expect(eventMarkers.at(-1)).not.toBeNull();
      expect(button.getAttribute('data-glass-lens')).toBe(original);
    },
  );

  it('springs the lens while text and native hit targets stay fixed, including inertial release frames', () => {
    const f = fixture();
    const button = f.button();
    const events: CustomEvent[] = [];
    button.addEventListener('lodex:glass-lens', (event) => events.push(event as CustomEvent));
    const cleanup = attachGlassControlGestures(f.root);
    const hover = f.dispatch('pointerover', button);
    expect(springs.length).toBe(0);
    const down = f.dispatch('pointerdown', button);
    const press = latestSpring();
    sample(press, 1);
    expect(f.frames.size).toBe(1); // Six channels share Motion's current render phase.
    f.flush();
    expect(button.number('--glass-pressure')).toBe(1);
    expect(button.number('--glass-lens-scale-x')).toBeLessThan(1);
    const move = f.dispatch('pointermove', null, { clientX: 230 }, f.view);
    f.flushRead();
    const drag = latestSpring();
    // Retarget the same MotionValues so Motion can preserve instantaneous spring velocity.
    expect(drag[0]?.value).toBe(press[0]?.value);
    sample(drag, 1);
    f.flush();
    expect(button.number('--glass-lens-x')).toBeGreaterThan(0);
    expect(button.number('--glass-lens-x')).toBeLessThanOrEqual(12);
    expect(button.number('--glass-lens-scale-x')).toBeCloseTo(1.13);
    expect(button.number('--glass-lens-scale-y')).toBeLessThan(1);
    const up = f.dispatch('pointerup', button, {}, f.view);
    const release = latestSpring();
    expect(release[0]?.options.damping! ** 2).toBeLessThan(
      4 * release[0]!.options.stiffness * release[0]!.options.mass,
    );
    sample(release, 0.5);
    f.flush();
    expect(button.number('--glass-lens-x')).toBeGreaterThan(0);
    sample(release, 1.08); // A damped spring may overshoot the resting position.
    f.flush();
    expect(button.number('--glass-lens-x')).toBeLessThan(0);
    expect(button.number('--glass-pressure')).toBe(0);
    expect(button.style.transform).toBe('rotate(2deg)');
    expect([hover, down, move, up].every((event) => !event.defaultPrevented)).toBe(true);
    expect(
      events.every(
        (event) => event.bubbles && event.detail.pressure >= 0 && event.detail.pressure <= 1,
      ),
    ).toBe(true);
    complete(release);
    expect(button.properties.size).toBe(0);
    expect(events.at(-1)?.detail).toEqual({ pressure: 0, stretchX: 1, stretchY: 1 });
    cleanup();
  });

  it('does no material work when moving directly between adjacent controls', () => {
    const f = fixture();
    const first = f.button();
    const next = f.button();
    const cleanup = attachGlassControlGestures(f.root);
    f.dispatch('pointerover', first);
    f.dispatch('pointerout', first, { relatedTarget: next });
    f.dispatch('pointerover', next, { relatedTarget: first });
    f.flush();
    expect(springs.length).toBe(0);
    expect(first.properties.size + next.properties.size).toBe(0);
    cleanup();
  });

  it('preserves ordinary pointer clicks, and suppresses only the matching click after a genuine drag', () => {
    const f = fixture();
    const button = f.button();
    const other = f.button();
    const cleanup = attachGlassControlGestures(f.root);
    f.dispatch('pointerdown', button);
    f.dispatch('pointermove', button, { clientX: 107 }, f.view);
    f.dispatch('pointerup', button, {}, f.view);
    expect(f.dispatch('click', button).defaultPrevented).toBe(false);
    f.dispatch('pointerdown', button);
    f.dispatch('pointermove', button, { clientX: 180 }, f.view);
    f.dispatch('pointerup', button, {}, f.view);
    expect(f.dispatch('click', other).defaultPrevented).toBe(false);
    expect(f.dispatch('click', button, { detail: 0 }).defaultPrevented).toBe(false); // Keyboard activation.
    expect(f.dispatch('click', button, { pointerId: 9 }).defaultPrevented).toBe(false);
    expect(f.dispatch('click', button).defaultPrevented).toBe(true);
    expect(f.dispatch('click', button).defaultPrevented).toBe(false);
    f.dispatch('pointerdown', button);
    f.dispatch('pointermove', button, { clientY: 180 }, f.view);
    f.dispatch('pointerup', button, {}, f.view);
    f.advanceClock(1000);
    expect(f.dispatch('click', button).defaultPrevented).toBe(false);
    cleanup();
  });

  it('keeps Enter and Space activation native, and releases when focus moves away', () => {
    const f = fixture();
    const button = f.button(true);
    const cleanup = attachGlassControlGestures(f.root);
    for (const key of ['Enter', ' ']) {
      const down = f.dispatch('keydown', button, { key, repeat: false });
      sample(latestSpring(), 1);
      f.flush();
      expect(button.number('--glass-pressure')).toBe(1);
      const count = springs.length;
      f.dispatch('keydown', button, { key, repeat: true });
      expect(springs.length).toBe(count);
      expect(f.dispatch('click', button, { detail: 0 }).defaultPrevented).toBe(false);
      const up = f.dispatch('keyup', null, { key }, f.view);
      complete(latestSpring());
      expect(down.defaultPrevented || up.defaultPrevented).toBe(false);
      expect(button.properties.size).toBe(0);
    }
    const count = springs.length;
    f.dispatch('keydown', button, { key: 'Tab' });
    expect(springs.length).toBe(count);
    f.dispatch('keydown', button, { key: 'Enter' });
    f.dispatch('focusout', button, { relatedTarget: null });
    complete(latestSpring());
    expect(button.properties.size).toBe(0);
    cleanup();
  });

  it('captures only the explicit preview lens and releases it outside the app', () => {
    const f = fixture();
    const button = f.button();
    const preview = f.button(true);
    const cleanup = attachGlassControlGestures(f.root);
    f.dispatch('pointerdown', button);
    expect(button.setPointerCapture).not.toHaveBeenCalled();
    f.dispatch('pointerup', null, {}, f.view);
    f.dispatch('pointerdown', preview);
    expect(preview.setPointerCapture).toHaveBeenCalledWith(1);
    f.dispatch('pointermove', null, { clientY: -500 }, f.view);
    f.flushRead();
    sample(latestSpring(), 1);
    f.flush();
    expect(preview.number('--glass-lens-y')).toBe(-12);
    expect(preview.number('--glass-lens-scale-y')).toBeCloseTo(1.13);
    f.dispatch('pointerup', null, {}, f.view);
    expect(preview.releasePointerCapture).toHaveBeenCalledWith(1);
    expect(preview.properties.size).toBe(0);
    cleanup();
  });

  it('allows native touch panning on controls while supporting deliberate preview touch dragging', () => {
    const f = fixture();
    const button = f.button();
    const preview = f.button(true);
    const cleanup = attachGlassControlGestures(f.root);
    f.dispatch('pointerover', button, { pointerType: 'touch' });
    expect(springs.length).toBe(0);
    f.dispatch('pointerdown', button, { pointerType: 'touch' });
    const count = springs.length;
    const move = f.dispatch('pointermove', button, { clientX: 200, pointerType: 'touch' }, f.view);
    expect(springs.length).toBe(count);
    expect(move.defaultPrevented).toBe(false);
    f.dispatch('pointerup', button, {}, f.view);
    expect(f.dispatch('click', button).defaultPrevented).toBe(false);
    f.dispatch('pointerdown', preview, { pointerType: 'touch' });
    f.dispatch('pointermove', null, { clientX: 200, pointerType: 'touch' }, f.view);
    f.flushRead();
    sample(latestSpring(), 1);
    f.flush();
    expect(preview.number('--glass-lens-x')).toBeGreaterThan(0);
    cleanup();
  });

  it.each(['pointercancel', 'lostpointercapture', 'blur'])(
    'cleans up %s without stuck pressure or suppressed native clicks',
    (type) => {
      const f = fixture();
      const button = f.button(true);
      const cleanup = attachGlassControlGestures(f.root);
      f.dispatch('pointerdown', button);
      f.dispatch('pointermove', null, { clientX: 200 }, f.view);
      f.flushRead();
      sample(latestSpring(), 1);
      f.flush();
      f.dispatch(type, button, {}, type === 'lostpointercapture' ? f.root : f.view);
      if (type !== 'blur') complete(latestSpring());
      expect(button.properties.size).toBe(0);
      expect(button.hasPointerCapture(1)).toBe(false);
      expect(f.dispatch('click', button).defaultPrevented).toBe(false);
      cleanup();
    },
  );

  it('ignores disabled, separately managed, and outside controls and secondary pointers', () => {
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
    f.dispatch('pointerdown', normal, { isPrimary: false });
    expect(motion.animate).not.toHaveBeenCalled();
    cleanup();
  });

  it('restores inline variables and filter state on cleanup and rejects stale animation callbacks', () => {
    const f = fixture();
    const button = f.button();
    button.style.setProperty('--glass-pressure', '0.125', 'important');
    const events: CustomEvent[] = [];
    button.addEventListener('lodex:glass-lens', (event) => events.push(event as CustomEvent));
    const cleanup = attachGlassControlGestures(f.root);
    f.dispatch('pointerdown', button);
    const press = latestSpring();
    sample(press, 1);
    f.flush();
    f.dispatch('pointerup', button, {}, f.view);
    const staleReset = latestSpring();
    f.dispatch('pointerdown', button);
    sample(latestSpring(), 1);
    staleReset.forEach((spring) => spring.options.onComplete());
    expect(button.number('--glass-pressure')).toBe(1);
    cleanup();
    expect(button.style.getPropertyValue('--glass-pressure')).toBe('0.125');
    expect(button.style.getPropertyPriority('--glass-pressure')).toBe('important');
    expect(button.properties.size).toBe(1);
    expect(f.frames.size).toBe(0);
    expect(events.at(-1)?.detail).toEqual({ pressure: 0, stretchX: 1, stretchY: 1 });
    expect(press.every((spring) => spring.value.destroy.mock.calls.length === 1)).toBe(true);
    const count = springs.length;
    sample(staleReset, 0.5);
    f.dispatch('pointerdown', button);
    f.dispatch('pointermove', null, { clientX: 200 }, f.view);
    f.dispatch('keydown', button, { key: 'Enter' });
    expect(springs.length).toBe(count);
    expect(f.frames.size).toBe(0);
    expect(button.style.transform).toBe('rotate(2deg)');
  });
});
