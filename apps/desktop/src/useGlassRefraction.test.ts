import { afterEach, describe, expect, it, vi } from 'vitest';
import { attachGlassRefraction } from './useGlassRefraction';

class ElementStub extends EventTarget {
  nodeType = 1;
  children: ElementStub[] = [];
  attributes = new Map<string, string>();
  properties = new Map<string, string>();
  dataset: Record<string, string> = {};
  parent: ElementStub | null = null;
  ownerDocument!: unknown;
  optical = false;
  offsetWidth = 120;
  offsetHeight = 60;
  get clientWidth() {
    return this.offsetWidth;
  }
  get clientHeight() {
    return this.offsetHeight;
  }
  style = {
    cssText: '',
    setProperty: (name: string, value: string) => this.properties.set(name, value),
    removeProperty: (name: string) => this.properties.delete(name),
  };
  constructor(readonly tag: string) {
    super();
  }
  get id() {
    return this.attributes.get('id') ?? '';
  }
  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }
  removeAttribute(name: string) {
    this.attributes.delete(name);
  }
  append(...children: ElementStub[]) {
    children.forEach((child) => {
      child.parent = this;
      this.children.push(child);
    });
  }
  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter((child) => child !== this);
    this.parent = null;
  }
  contains(other: ElementStub): boolean {
    return this === other || this.children.some((child) => child.contains(other));
  }
  matches() {
    return this.optical;
  }
  closest(): ElementStub | null {
    return this.optical ? this : (this.parent?.closest() ?? null);
  }
  querySelectorAll(): ElementStub[] {
    return this.children.flatMap((child) => [
      ...(child.optical ? [child] : []),
      ...child.querySelectorAll(),
    ]);
  }
}

function fixture(userAgent = 'Chrome/134.0.0.0') {
  class Preference extends EventTarget {
    matches = false;
    update(matches: boolean) {
      this.matches = matches;
      this.dispatchEvent(new Event('change'));
    }
  }
  const preferences = [new Preference(), new Preference(), new Preference(), new Preference()];
  const frames = new Map<number, () => void>();
  let nextFrame = 0;
  let resized: (entries: { target: ElementStub }[]) => void = () => {};
  let mutated: (
    entries: {
      addedNodes: ElementStub[];
      removedNodes: ElementStub[];
      type?: string;
      attributeName?: string;
      target?: ElementStub;
    }[],
  ) => void = () => {};
  const resizeDisconnect = vi.fn();
  const mutationDisconnect = vi.fn();
  const unobserve = vi.fn();
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: typeof resized) {
        resized = callback;
      }
      observe() {}
      unobserve = unobserve;
      disconnect = resizeDisconnect;
    },
  );
  vi.stubGlobal(
    'MutationObserver',
    class {
      constructor(callback: typeof mutated) {
        mutated = callback;
      }
      observe() {}
      disconnect = mutationDisconnect;
    },
  );
  const renderedMaps = vi.fn(() => 'data:image/png;base64,test');
  const body = new ElementStub('body');
  const view = {
    navigator: { userAgent },
    CSS: { supports: () => true },
    matchMedia: (query: string) =>
      preferences[
        query.includes('motion')
          ? 3
          : query.includes('contrast')
            ? 2
            : query.includes('forced-colors')
              ? 1
              : 0
      ]!,
    getComputedStyle: () => ({ borderTopLeftRadius: '12px' }),
    setTimeout: (callback: () => void) => {
      frames.set(++nextFrame, callback);
      return nextFrame;
    },
    clearTimeout: (id: number) => frames.delete(id),
  };
  const document = {
    defaultView: view,
    body,
    createElementNS: (_: string, name: string) => new ElementStub(name),
    createElement: () => ({
      width: 0,
      height: 0,
      getContext: () => ({
        createImageData: (width: number, height: number) => ({
          data: new Uint8ClampedArray(width * height * 4),
        }),
        putImageData: () => {},
      }),
      toDataURL: renderedMaps,
    }),
  };
  const root = new ElementStub('root');
  root.ownerDocument = document;
  const surface = new ElementStub('surface');
  surface.optical = true;
  root.append(surface);
  const flush = () => {
    const callbacks = [...frames.values()];
    frames.clear();
    callbacks.forEach((callback) => callback());
  };
  return {
    root,
    surface,
    body,
    preferences,
    frames,
    flush,
    renderedMaps,
    resize: () => resized([{ target: surface }]),
    mutation: (addedNodes: ElementStub[] = [], removedNodes: ElementStub[] = []) =>
      mutated([{ addedNodes, removedNodes }]),
    marker: (target: ElementStub, active: boolean) => {
      target.optical = active;
      mutated([
        {
          type: 'attributes',
          attributeName: 'data-glass-lens',
          target,
          addedNodes: [],
          removedNodes: [],
        },
      ]);
    },
    interact: (pressure: number, stretchX = 1, stretchY = 1, target = surface) => {
      const event = new Event('lodex:glass-lens');
      Object.defineProperties(event, {
        target: { value: target },
        detail: { value: { pressure, stretchX, stretchY } },
      });
      root.dispatchEvent(event);
    },
    resizeDisconnect,
    mutationDisconnect,
    unobserve,
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('glass backdrop lifecycle', () => {
  it('does not deform an enclosing panel when an unmarked child dispatches an interaction', () => {
    const f = fixture();
    const child = new ElementStub('unmarked-button');
    f.surface.append(child);
    const cleanup = attachGlassRefraction(f.root as unknown as HTMLElement);
    f.flush();
    const panelFilter = f.body.children[0]!.children[0]!.children[0]!;
    const green = panelFilter.children.find(
      (node) => node.attributes.get('result') === 'greenSample',
    )!;
    const originalScale = green.attributes.get('scale');
    f.interact(1, 1.13, 0.9, child);
    expect(green.attributes.get('scale')).toBe(originalScale);
    expect(child.properties.size).toBe(0);
    expect(f.renderedMaps).toHaveBeenCalledOnce();
    cleanup();
  });

  it('bakes a newly marked control on its first gesture without waiting for observer or resize timers', () => {
    const f = fixture();
    const child = new ElementStub('marked-button');
    child.offsetWidth = 48;
    child.offsetHeight = 32;
    f.surface.append(child);
    const cleanup = attachGlassRefraction(f.root as unknown as HTMLElement);
    expect(f.frames.size).toBe(1);
    // The gesture hook sets its marker, then dispatches before the observer runs.
    child.optical = true;
    f.interact(1, 1.1, 0.95, child);
    expect(child.attributes.get('data-glass-optics')).toBe('refractive');
    expect(f.renderedMaps).toHaveBeenCalledOnce();
    expect(f.surface.properties.size).toBe(0);
    // The previous timer is replaced; unrelated larger surfaces stay deferred.
    expect(f.frames.size).toBe(1);
    f.flush();
    expect(f.renderedMaps).toHaveBeenCalledTimes(2);
    expect(f.surface.attributes.get('data-glass-optics')).toBe('refractive');
    f.marker(child, true);
    f.interact(0, 1, 1, child);
    f.flush();
    expect(f.renderedMaps).toHaveBeenCalledTimes(2);
    cleanup();
  });

  it('registers dynamic control markers and releases their maps when markers are removed', () => {
    const f = fixture();
    f.surface.optical = false;
    const cleanup = attachGlassRefraction(f.root as unknown as HTMLElement);
    expect(f.frames.size).toBe(0);
    f.marker(f.surface, true);
    f.flush();
    expect(f.surface.attributes.get('data-glass-optics')).toBe('refractive');
    f.marker(f.surface, false);
    expect(f.surface.properties.size).toBe(0);
    expect(f.body.children[0]!.children[0]!.children).toHaveLength(0);
    expect(f.unobserve).toHaveBeenCalledWith(f.surface);
    cleanup();
  });

  it('changes per-channel optical scales on pressure frames without rebaking maps and resets on release', () => {
    const f = fixture();
    const cleanup = attachGlassRefraction(f.root as unknown as HTMLElement);
    f.flush();
    const filter = f.body.children[0]!.children[0]!.children[0]!;
    const channels = filter.children.filter((child) => child.tag === 'feDisplacementMap');
    const baseline = channels.map((channel) => Number(channel.attributes.get('scale')));
    const axes = filter.children[1]!.children;
    f.interact(1, 1.1, 0.95);
    channels.forEach((channel, index) =>
      expect(Number(channel.attributes.get('scale'))).toBeCloseTo(baseline[index]! * 1.14),
    );
    expect(Number(axes[0]!.attributes.get('slope'))).toBeCloseTo((255 / 256) * 1.1);
    expect(Number(axes[0]!.attributes.get('intercept'))).toBeCloseTo(-0.05);
    expect(Number(axes[1]!.attributes.get('slope'))).toBeCloseTo((255 / 256) * 0.95);
    expect(f.renderedMaps).toHaveBeenCalledOnce();
    f.interact(0);
    expect(channels.map((channel) => Number(channel.attributes.get('scale')))).toEqual(baseline);
    expect(Number(axes[0]!.attributes.get('slope'))).toBe(255 / 256);
    f.interact(1);
    f.preferences[3]!.update(true);
    expect(channels.map((channel) => Number(channel.attributes.get('scale')))).toEqual(baseline);
    f.interact(1);
    expect(channels.map((channel) => Number(channel.attributes.get('scale')))).toEqual(baseline);
    // Explicit full effects can override reduced motion, never reduced transparency.
    f.root.dataset.glassEffects = 'full';
    f.interact(1);
    expect(Number(channels[1]!.attributes.get('scale'))).toBeGreaterThan(baseline[1]!);
    f.preferences[0]!.update(true);
    f.interact(1);
    expect(channels.map((channel) => Number(channel.attributes.get('scale')))).toEqual(baseline);
    cleanup();
    f.interact(1);
    expect(channels.map((channel) => Number(channel.attributes.get('scale')))).toEqual(baseline);
  });

  it('registers only a backdrop filter, coalesces resizing and cleans every resource on design change', () => {
    const f = fixture();
    const cleanup = attachGlassRefraction(f.root as unknown as HTMLElement);
    f.resize();
    f.resize();
    expect(f.frames.size).toBe(1);
    f.flush();
    expect(f.renderedMaps).toHaveBeenCalledTimes(1);
    expect(f.surface.attributes.get('data-glass-optics')).toBe('refractive');
    expect(f.surface.properties.get('--glass-refraction-filter')).toMatch(
      /^url\("#lodex-glass-lens-/,
    );
    expect(f.surface.properties.has('filter')).toBe(false);
    const filter = f.body.children[0]!.children[0]!.children[0]!;
    expect(filter.children.filter((child) => child.tag === 'feDisplacementMap')).toHaveLength(3);
    expect(filter.children.filter((child) => child.tag === 'feColorMatrix')).toHaveLength(3);
    expect(filter.children[2]!.attributes.get('in')).toBe('SourceGraphic');
    const finalComposite = filter.children.at(-1)!;
    expect(finalComposite.attributes.get('operator')).toBe('in');
    expect(finalComposite.attributes.get('in2')).toBe('greenSample');
    f.resize();
    f.flush();
    expect(f.renderedMaps).toHaveBeenCalledTimes(1);
    f.surface.offsetWidth = 160;
    f.resize();
    f.flush();
    expect(f.renderedMaps).toHaveBeenCalledTimes(2);
    f.resize();
    cleanup();
    expect(f.frames.size).toBe(0);
    expect(f.surface.properties.size).toBe(0);
    expect(f.surface.attributes.has('data-glass-optics')).toBe(false);
    expect(f.root.attributes.has('data-glass-refraction')).toBe(false);
    expect(f.body.children).toHaveLength(0);
    expect(f.resizeDisconnect).toHaveBeenCalledOnce();
    expect(f.mutationDisconnect).toHaveBeenCalledOnce();
  });

  it('discovers new popovers, skips hidden dialogs, and removes detached filters', () => {
    const f = fixture();
    f.surface.offsetWidth = 0;
    const cleanup = attachGlassRefraction(f.root as unknown as HTMLElement);
    f.flush();
    expect(f.renderedMaps).not.toHaveBeenCalled();
    f.surface.offsetWidth = 120;
    f.resize();
    f.flush();
    expect(f.renderedMaps).toHaveBeenCalledOnce();
    const menu = new ElementStub('menu');
    menu.optical = true;
    f.root.append(menu);
    f.mutation([menu]);
    f.flush();
    expect(menu.attributes.get('data-glass-optics')).toBe('refractive');
    // Same-sized surfaces share the cached displacement image.
    expect(f.renderedMaps).toHaveBeenCalledOnce();
    menu.remove();
    f.mutation([], [menu]);
    expect(menu.properties.size).toBe(0);
    expect(f.unobserve).toHaveBeenCalledWith(menu);
    cleanup();
  });

  it('reacts to accessibility preferences and does not restart after cleanup', () => {
    const f = fixture();
    const cleanup = attachGlassRefraction(f.root as unknown as HTMLElement);
    f.flush();
    f.preferences[0]!.update(true);
    expect(f.surface.properties.size).toBe(0);
    expect(f.root.attributes.get('data-glass-refraction')).toBe('reduced');
    f.preferences[0]!.update(false);
    f.flush();
    expect(f.surface.attributes.get('data-glass-optics')).toBe('refractive');
    expect(f.renderedMaps).toHaveBeenCalledOnce();
    cleanup();
    f.preferences[1]!.update(true);
    f.preferences[1]!.update(false);
    expect(f.frames.size).toBe(0);
    expect(f.root.attributes.size).toBe(0);
  });

  it('labels unsupported engines honestly without allocating filters or maps', () => {
    const f = fixture('Version/18.3 Safari/605.1.15');
    const cleanup = attachGlassRefraction(f.root as unknown as HTMLElement);
    expect(f.root.attributes.get('data-glass-refraction')).toBe('fallback');
    expect(f.body.children).toHaveLength(0);
    expect(f.frames.size).toBe(0);
    cleanup();
    expect(f.root.attributes.size).toBe(0);
  });
});
