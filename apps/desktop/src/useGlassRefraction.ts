import { useEffect, type RefObject } from 'react';
import {
  createDisplacementPixels,
  createGlassLens,
  supportsGlassRefraction,
} from './liquid-glass-optics';

export const glassOpticalSurfaces =
  '.topbar, .composer, .sidebar, .plan-panel, .settings-screen, dialog.settings-dialog:not(.settings-section), .permission-menu, .slash-menu, .context-popover, .glass-effects-menu, .glass-optics-preview-lens';
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
  ];
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
    displacement: SVGFEDisplacementMapElement;
    size: string;
  };
  const surfaces = new Map<HTMLElement, Surface>();
  const pending = new Set<HTMLElement>();
  const cache = new Map<string, { href: string; scale: number }>();
  let timer: number | undefined;
  let stopped = false;
  let disabled = preferences.some((preference) => preference.matches);
  root.setAttribute('data-glass-refraction', disabled ? 'reduced' : 'active');

  function clearSurface(element: HTMLElement) {
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
    neutral.append(
      make('feFuncR', { type: 'linear', slope: String(255 / 256) }),
      make('feFuncG', { type: 'linear', slope: String(255 / 256) }),
    );
    const displacement = make('feDisplacementMap', {
      in: 'SourceGraphic',
      in2: 'neutralMap',
      xChannelSelector: 'R',
      yChannelSelector: 'G',
    });
    filter.append(image, neutral, displacement);
    defs.append(filter);
    surfaces.set(element, { filter, image, displacement, size: '' });
    resize.observe(element);
    pending.add(element);
  }

  function paint() {
    timer = undefined;
    if (stopped || disabled) return;
    for (const element of pending) {
      const state = surfaces.get(element);
      if (!state || !root.contains(element)) continue;
      // offset dimensions ignore spring transforms and avoid re-baking a map
      // on animation frames. Hidden dialogs are resized when they become visible.
      const width = element.offsetWidth;
      const height = element.offsetHeight;
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
          if (cache.size > 12) cache.delete(cache.keys().next().value!);
        }
        state.image.setAttribute('href', map.href);
        state.image.setAttribute('width', String(width));
        state.image.setAttribute('height', String(height));
        state.filter.setAttribute('width', String(width));
        state.filter.setAttribute('height', String(height));
        state.displacement.setAttribute('scale', String(map.scale));
        state.size = key;
      }
      element.style.setProperty('--glass-refraction-filter', `url("#${state.filter.id}")`);
      element.setAttribute('data-glass-optics', 'refractive');
    }
    pending.clear();
  }

  function schedule(settleResize = false) {
    if (disabled || stopped || pending.size === 0) return;
    if (timer !== undefined) {
      if (!settleResize) return;
      view!.clearTimeout(timer);
    }
    timer = view!.setTimeout(paint, 96);
  }

  const resize = new ResizeObserver((entries) => {
    for (const entry of entries) pending.add(entry.target as HTMLElement);
    schedule(true);
  });
  const mutations = new MutationObserver((records) => {
    let changed = false;
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node.nodeType !== 1) continue;
        const element = node as HTMLElement;
        register(element);
        element.querySelectorAll<HTMLElement>(glassOpticalSurfaces).forEach(register);
        changed = true;
      }
      if (record.removedNodes.length) changed = true;
    }
    if (!changed) return;
    for (const element of surfaces.keys()) if (!root.contains(element)) release(element);
    schedule();
  });
  function updatePreferences() {
    disabled = preferences.some((preference) => preference.matches);
    root.setAttribute('data-glass-refraction', disabled ? 'reduced' : 'active');
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
  mutations.observe(root, { childList: true, subtree: true });
  preferences.forEach((preference) => preference.addEventListener('change', updatePreferences));
  schedule();
  return () => {
    stopped = true;
    if (timer !== undefined) view.clearTimeout(timer);
    mutations.disconnect();
    resize.disconnect();
    preferences.forEach((preference) =>
      preference.removeEventListener('change', updatePreferences),
    );
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
