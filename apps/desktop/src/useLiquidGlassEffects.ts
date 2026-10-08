import { useEffect, type RefObject } from 'react';
import { attachGlassControlGestures } from './glass-control-gestures';

const surfaces =
  '[data-glass-interactive], .composer, .topbar, .sidebar, .plan-panel, .settings-screen, .settings-dialog:not(.settings-section), .design-switch, .glass-effects-menu, .glass-optics-preview-lens';

/** Adds only visual pointer coordinates; clicks, focus and keyboard input remain native. */
export function attachLiquidGlassEffects(root: HTMLElement, allowMotion?: boolean): () => void {
  const view = root.ownerDocument.defaultView;
  if (!view) return () => {};
  const preferences = [
    view.matchMedia('(prefers-reduced-motion: reduce)'),
    view.matchMedia('(prefers-reduced-transparency: reduce)'),
    view.matchMedia('(forced-colors: active)'),
    view.matchMedia('(prefers-contrast: more)'),
  ];
  let active: HTMLElement | null = null;
  let frame: number | null = null;
  let listening = false;
  let stopGestures: (() => void) | undefined;
  let latest: { target: Element; x: number; y: number } | null = null;

  function clearActive() {
    active?.style.removeProperty('--glass-pointer-x');
    active?.style.removeProperty('--glass-pointer-y');
    active?.style.removeProperty('--glass-pointer-active');
    active = null;
  }

  function reset() {
    if (frame !== null) view!.cancelAnimationFrame(frame);
    frame = null;
    latest = null;
    clearActive();
  }

  function paint() {
    frame = null;
    if (!latest) return;
    const surface = latest.target.closest<HTMLElement>(surfaces);
    if (!surface || !root.contains(surface)) {
      clearActive();
      return;
    }
    if (surface !== active) clearActive();
    const bounds = surface.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return;
    active = surface;
    const percent = (position: number, start: number, size: number) =>
      `${Math.min(100, Math.max(0, ((position - start) / size) * 100)).toFixed(1)}%`;
    surface.style.setProperty('--glass-pointer-x', percent(latest.x, bounds.left, bounds.width));
    surface.style.setProperty('--glass-pointer-y', percent(latest.y, bounds.top, bounds.height));
    surface.style.setProperty('--glass-pointer-active', '1');
  }

  function move(event: PointerEvent) {
    if (event.pointerType === 'touch') return;
    const target = event.target as Element | null;
    if (!target || typeof target.closest !== 'function') return;
    latest = { target, x: event.clientX, y: event.clientY };
    if (frame === null) frame = view!.requestAnimationFrame(paint);
  }

  function updatePreferences() {
    const enabled =
      (allowMotion ?? !preferences[0]!.matches) &&
      !preferences.slice(1).some((preference) => preference.matches);
    if (enabled === listening) return;
    listening = enabled;
    if (enabled) {
      stopGestures = attachGlassControlGestures(root);
      root.addEventListener('pointermove', move, { passive: true });
      root.addEventListener('pointerleave', reset, { passive: true });
      root.addEventListener('pointercancel', reset, { passive: true });
    } else {
      stopGestures?.();
      stopGestures = undefined;
      root.removeEventListener('pointermove', move);
      root.removeEventListener('pointerleave', reset);
      root.removeEventListener('pointercancel', reset);
      reset();
    }
  }

  for (const preference of preferences) preference.addEventListener('change', updatePreferences);
  updatePreferences();
  return () => {
    for (const preference of preferences)
      preference.removeEventListener('change', updatePreferences);
    root.removeEventListener('pointermove', move);
    root.removeEventListener('pointerleave', reset);
    root.removeEventListener('pointercancel', reset);
    reset();
    stopGestures?.();
  };
}

export function useLiquidGlassEffects(
  root: RefObject<HTMLElement | null>,
  enabled: boolean,
  allowMotion?: boolean,
) {
  useEffect(() => {
    if (!enabled || !root.current) return;
    return attachLiquidGlassEffects(root.current, allowMotion);
  }, [root, enabled, allowMotion]);
}
