import { useEffect, type RefObject } from 'react';
import {
  createDisplacementPixels,
  createGlassLens,
  glassChannelMasks,
  glassOpticalResponse,
  supportsGlassRefraction,
  type GlassLensInteraction,
} from './liquid-glass-optics';

export const glassOpticalSurfaces =
  '.topbar, .composer, .glass-optics-preview-lens, [data-glass-lens]';
const opticalContainers =
  '.main, .composer-area, .glass-effects-control, .glass-effects-menu, .glass-optics-preview';
const immediateLensArea = 32_768;
const resizeSettleDelay = 160;
const cachedMapsLimit = 8;
const svgNamespace = 'http://www.w3.org/2000/svg';
let nextLens = 0;

/** Owns only a hidden filter registry and CSS custom properties. The CSS
 * applies each filter to a separate backdrop layer, never to text or controls.
 */
export function attachGlassRefraction(root: HTMLElement): () => void {
  const doc = root.ownerDocument;
  const view = doc.defaultView;
  if (!view) return () => {};
  const preferences = [
    view.matchMedia('(prefers-reduced-transparency: reduce)'),
    view.matchMedia('(forced-colors: active)'),
    view.matchMedia('(prefers-contrast: more)'),
  ];
  const reducedMotion = view.matchMedia('(prefers-reduced-motion: reduce)');
  const supported = supportsGlassRefraction(
    view.navigator.userAgent,
    view.CSS?.supports('backdrop-filter', 'url("#lodex-glass-support")') ?? false,
  );
  if (
    !supported ||
    typeof ResizeObserver === 'undefined' ||
    typeof MutationObserver === 'undefined'
  ) {
    root.setAttribute('data-glass-refraction', 'fallback');
    return () => root.removeAttribute('data-glass-refraction');
  }

  const svg = doc.createElementNS(svgNamespace, 'svg');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('width', '0');
  svg.setAttribute('height', '0');
  svg.style.cssText = 'position:absolute;pointer-events:none;overflow:hidden';
  svg.dataset.glassFilterRegistry = '';
  const defs = doc.createElementNS(svgNamespace, 'defs');
  svg.append(defs);
  doc.body.append(svg);
  type Surface = {
    filter: SVGFilterElement;
    image: SVGFEImageElement;
    channels: Record<keyof typeof glassChannelMasks, SVGFEDisplacementMapElement>;
    axes: { x: SVGFEFuncRElement; y: SVGFEFuncGElement };
    scale: number;
    interaction: GlassLensInteraction;
    size: string;
    response: ReturnType<typeof glassOpticalResponse> | null;
    applied: boolean;
  };
  const surfaces = new Map<HTMLElement, Surface>();
  const pending = new Set<HTMLElement>();
  const cache = new Map<string, { href: string; scale: number }>();
  let timer: number | undefined;
  let stopped = false;
  let disabled = preferences.some((preference) => preference.matches);
  root.setAttribute('data-glass-refraction', disabled ? 'reduced' : 'active');

  function clearSurface(element: HTMLElement) {
    const state = surfaces.get(element);
    if (state) state.applied = false;
    element.removeAttribute('data-glass-optics');
    element.style.removeProperty('--glass-refraction-filter');
  }

  function release(element: HTMLElement) {
    resize.unobserve(element);
    surfaces.get(element)?.filter.remove();
    surfaces.delete(element);
    pending.delete(element);
    clearSurface(element);
  }

  function make<K extends keyof SVGElementTagNameMap>(name: K, attributes: Record<string, string>) {
    const element = doc.createElementNS(svgNamespace, name);
    for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, value);
    return element;
  }

  function updateLens(state: Surface) {
    const response = glassOpticalResponse(state.scale, state.interaction);
    for (const channel of ['red', 'green', 'blue'] as const)
      if (state.response?.[channel] !== response[channel])
        state.channels[channel].setAttribute('scale', String(response[channel]));
    for (const axis of ['x', 'y'] as const) {
      if (state.response?.[axis].slope !== response[axis].slope)
        state.axes[axis].setAttribute('slope', String(response[axis].slope));
      if (state.response?.[axis].intercept !== response[axis].intercept)
        state.axes[axis].setAttribute('intercept', String(response[axis].intercept));
    }
    state.response = response;
  }

  function motionAllowed() {
    return (
      root.dataset.glassEffects !== 'reduced' &&
      (!reducedMotion.matches || root.dataset.glassEffects === 'full')
    );
  }

  function layoutMoving() {
    return root.dataset.glassLayoutMoving !== undefined;
  }

  function resetInteractions() {
    surfaces.forEach((state) => {
      state.interaction = {};
      updateLens(state);
    });
  }

  function lensInteraction(event: Event) {
    if (disabled || !motionAllowed()) return;
    // Gestures dispatch from the control itself. Never reinterpret an unknown
    // control as its enclosing panel and deform the entire panel instead.
    const element = event.target as HTMLElement | null;
    if (!element?.matches?.(glassOpticalSurfaces) || !root.contains(element)) return;
    const detail = (event as CustomEvent<GlassLensInteraction>).detail;
    if (!detail || typeof detail !== 'object') return;
    // A marker may have just been added in the same pointer event, before the
    // MutationObserver callback. Bake only this control before its first frame.
    register(element);
    const state = surfaces.get(element)!;
    state.interaction = detail;
    if (!state.size && element.clientWidth * element.clientHeight <= immediateLensArea)
      paint(element);
    else if (!state.size) schedule(true);
    else updateLens(state);
  }

  function register(element: HTMLElement) {
    if (surfaces.has(element) || !element.matches(glassOpticalSurfaces)) return;
    const filter = make('filter', {
      id: `lodex-glass-lens-${++nextLens}`,
      filterUnits: 'userSpaceOnUse',
      primitiveUnits: 'userSpaceOnUse',
      'color-interpolation-filters': 'sRGB',
      x: '0',
      y: '0',
    });
    const image = make('feImage', {
      result: 'lensMap',
      preserveAspectRatio: 'none',
      x: '0',
      y: '0',
    });
    const neutral = make('feComponentTransfer', { in: 'lensMap', result: 'neutralMap' });
    const axes = {
      x: make('feFuncR', { type: 'linear' }),
      y: make('feFuncG', { type: 'linear' }),
    };
    neutral.append(axes.x, axes.y);
    filter.append(image, neutral);
    const channels = {} as Surface['channels'];
    for (const channel of ['red', 'green', 'blue'] as const) {
      const displacement = make('feDisplacementMap', {
        in: 'SourceGraphic',
        in2: 'neutralMap',
        xChannelSelector: 'R',
        yChannelSelector: 'G',
        result: `${channel}Sample`,
      });
      channels[channel] = displacement;
      filter.append(
        displacement,
        make('feColorMatrix', {
          in: `${channel}Sample`,
          type: 'matrix',
          values: glassChannelMasks[channel],
          result: `${channel}Channel`,
        }),
      );
    }
    filter.append(
      make('feComposite', {
        in: 'redChannel',
        in2: 'greenChannel',
        operator: 'arithmetic',
        k2: '1',
        k3: '1',
        result: 'redGreenChannels',
      }),
      make('feComposite', {
        in: 'redGreenChannels',
        in2: 'blueChannel',
        operator: 'arithmetic',
        k2: '1',
        k3: '1',
        result: 'colorChannels',
      }),
      make('feComposite', { in: 'colorChannels', in2: 'greenSample', operator: 'in' }),
    );
    defs.append(filter);
    const state: Surface = {
      filter,
      image,
      channels,
      axes,
      scale: 0,
      interaction: {},
      size: '',
      response: null,
      applied: false,
    };
    surfaces.set(element, state);
    updateLens(state);
    resize.observe(element);
    pending.add(element);
  }

  function paint(only?: HTMLElement) {
    if (only && timer !== undefined) view!.clearTimeout(timer);
    timer = undefined;
    if (stopped || disabled || (!only && layoutMoving())) return;
    for (const element of only ? [only] : pending) {
      const state = surfaces.get(element);
      if (!state || !root.contains(element)) continue;
      // The absolute backdrop's inset:0 spans the padding box, excluding the
      // parent's border. Client dimensions ignore spring transforms, avoiding
      // map rebakes on animation frames and 1–2px rim shifts on small controls.
      const width = element.clientWidth;
      const height = element.clientHeight;
      if (width < 2 || height < 2) continue;
      const radius = Number.parseFloat(view!.getComputedStyle(element).borderTopLeftRadius) || 0;
      const key = `${width}:${height}:${Math.round(radius)}`;
      if (state.size !== key) {
        let map = cache.get(key);
        if (!map) {
          const generated = createDisplacementPixels(createGlassLens(width, height, radius));
          const canvas = doc.createElement('canvas');
          canvas.width = generated.width;
          canvas.height = generated.height;
          const context = canvas.getContext('2d');
          if (!context) {
            clearSurface(element);
            continue;
          }
          const pixels = context.createImageData(generated.width, generated.height);
          pixels.data.set(generated.pixels);
          context.putImageData(pixels, 0, 0);
          map = { href: canvas.toDataURL('image/png'), scale: generated.scale };
          cache.set(key, map);
          if (cache.size > cachedMapsLimit) cache.delete(cache.keys().next().value!);
        } else {
          // Recently pressed controls keep their maps when the active filter is
          // removed at release; reopening them does not run canvas generation.
          cache.delete(key);
          cache.set(key, map);
        }
        state.image.setAttribute('href', map.href);
        state.image.setAttribute('width', String(width));
        state.image.setAttribute('height', String(height));
        state.filter.setAttribute('width', String(width));
        state.filter.setAttribute('height', String(height));
        state.scale = map.scale;
        updateLens(state);
        state.size = key;
      }
      if (!state.applied) {
        element.style.setProperty('--glass-refraction-filter', `url("#${state.filter.id}")`);
        element.setAttribute('data-glass-optics', 'refractive');
        state.applied = true;
      }
    }
    if (only) {
      pending.delete(only);
      schedule();
    } else pending.clear();
  }

  function schedule(settleResize = false, delay = resizeSettleDelay) {
    if (disabled || stopped || pending.size === 0 || layoutMoving()) return;
    if (timer !== undefined) {
      if (!settleResize) return;
      view!.clearTimeout(timer);
    }
    timer = view!.setTimeout(paint, delay);
  }

  const resize = new ResizeObserver((entries) => {
    for (const entry of entries) pending.add(entry.target as HTMLElement);
    schedule(true);
  });
  const mutations = new MutationObserver((records) => {
    let changed = false;
    for (const record of records) {
      if (record.type === 'attributes') {
        const element = record.target as HTMLElement;
        if (record.attributeName === 'data-glass-lens') {
          if (element.matches(glassOpticalSurfaces)) register(element);
          else if (surfaces.has(element)) release(element);
          changed = true;
        } else if (element === root && record.attributeName === 'data-glass-layout-moving') {
          if (layoutMoving()) {
            if (timer !== undefined) view!.clearTimeout(timer);
            timer = undefined;
          } else schedule(true, 16);
        } else if (element === root && !motionAllowed()) resetInteractions();
        continue;
      }
      for (const node of record.addedNodes) {
        if (node.nodeType !== 1) continue;
        const element = node as HTMLElement;
        register(element);
        // Streaming markdown/activity nodes cannot contain persistent lenses.
        // Scan descendants only when an optical component's known wrapper is
        // mounted, not on every paragraph or tool output appended to the chat.
        if (record.target === root || element.matches(opticalContainers))
          element.querySelectorAll<HTMLElement>(glassOpticalSurfaces).forEach(register);
        if (pending.size) changed = true;
      }
      for (const node of record.removedNodes) {
        if (node.nodeType !== 1) continue;
        for (const element of surfaces.keys())
          if (node.contains(element) && !root.contains(element)) release(element);
      }
    }
    if (!changed) return;
    schedule();
  });
  function updatePreferences() {
    disabled = preferences.some((preference) => preference.matches);
    root.setAttribute('data-glass-refraction', disabled ? 'reduced' : 'active');
    if (disabled || !motionAllowed()) resetInteractions();
    if (disabled) {
      if (timer !== undefined) view!.clearTimeout(timer);
      timer = undefined;
      surfaces.forEach((_, element) => clearSurface(element));
    } else {
      surfaces.forEach((_, element) => pending.add(element));
      schedule();
    }
  }
  root.querySelectorAll<HTMLElement>(glassOpticalSurfaces).forEach(register);
  mutations.observe(root, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['data-glass-lens', 'data-glass-effects', 'data-glass-layout-moving'],
  });
  preferences.forEach((preference) => preference.addEventListener('change', updatePreferences));
  reducedMotion.addEventListener('change', updatePreferences);
  root.addEventListener('lodex:glass-lens', lensInteraction);
  schedule();
  return () => {
    stopped = true;
    if (timer !== undefined) view.clearTimeout(timer);
    mutations.disconnect();
    resize.disconnect();
    preferences.forEach((preference) =>
      preference.removeEventListener('change', updatePreferences),
    );
    reducedMotion.removeEventListener('change', updatePreferences);
    root.removeEventListener('lodex:glass-lens', lensInteraction);
    surfaces.forEach((_, element) => clearSurface(element));
    surfaces.clear();
    pending.clear();
    cache.clear();
    svg.remove();
    root.removeAttribute('data-glass-refraction');
  };
}

export function useGlassRefraction(root: RefObject<HTMLElement | null>, enabled: boolean) {
  useEffect(() => {
    if (!enabled || !root.current) return;
    return attachGlassRefraction(root.current);
  }, [root, enabled]);
}
