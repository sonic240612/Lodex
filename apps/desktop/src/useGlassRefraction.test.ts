import { afterEach, describe, expect, it, vi } from 'vitest';
import { attachGlassRefraction } from './useGlassRefraction';

class ElementStub {
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
  style = {
    cssText: '',
    setProperty: (name: string, value: string) => this.properties.set(name, value),
    removeProperty: (name: string) => this.properties.delete(name),
  };
  constructor(readonly tag: string) {}
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
  const preferences = [new Preference(), new Preference()];
  const frames = new Map<number, () => void>();
  let nextFrame = 0;
  let resized: (entries: { target: ElementStub }[]) => void = () => {};
  let mutated: (
    entries: { addedNodes: ElementStub[]; removedNodes: ElementStub[] }[],
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
    matchMedia: (query: string) => preferences[query.includes('forced-colors') ? 1 : 0]!,
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
    resizeDisconnect,
    mutationDisconnect,
    unobserve,
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('glass backdrop lifecycle', () => {
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
    expect(filter.children.map((child) => child.tag)).toEqual([
      'feImage',
      'feComponentTransfer',
      'feDisplacementMap',
    ]);
    expect(filter.children[2]!.attributes.get('in')).toBe('SourceGraphic');
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
