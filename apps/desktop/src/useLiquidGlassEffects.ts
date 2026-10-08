import { useEffect, type RefObject } from 'react';

const surfaces =
  '[data-glass-interactive], .composer, .topbar, .sidebar, .plan-panel, .settings-screen, .settings-dialog:not(.settings-section), .design-switch';

/** Adds only visual pointer coordinates; clicks, focus and keyboard input remain native. */
export function attachLiquidGlassEffects(root: HTMLElement): () => void {
  const view = root.ownerDocument.defaultView;
  if (!view) return () => {};
  const preferences = [
    view.matchMedia('(prefers-reduced-motion: reduce)'),
    view.matchMedia('(prefers-reduced-transparency: reduce)'),
  ];
  let active: HTMLElement | null = null;
  let frame: number | null = null;
  let listening = false;
  let latest: { target: Element; x: number; y: number } | null = null;

  function clearActive() {
    active?.style.removeProperty('--glass-pointer-x');
    active?.style.removeProperty('--glass-pointer-y');
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
  }

  function move(event: PointerEvent) {
    if (event.pointerType === 'touch') return;
    const target = event.target as Element | null;
    if (!target || typeof target.closest !== 'function') return;
    latest = { target, x: event.clientX, y: event.clientY };
    if (frame === null) frame = view!.requestAnimationFrame(paint);
  }

  function updatePreferences() {
    const enabled = !preferences.some((preference) => preference.matches);
    if (enabled === listening) return;
    listening = enabled;
    if (enabled) {
      root.addEventListener('pointermove', move, { passive: true });
      root.addEventListener('pointerleave', reset, { passive: true });
      root.addEventListener('pointercancel', reset, { passive: true });
    } else {
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
  };
}

export function useLiquidGlassEffects(root: RefObject<HTMLElement | null>, enabled: boolean) {
  useEffect(() => {
    if (!enabled || !root.current) return;
    return attachLiquidGlassEffects(root.current);
  }, [root, enabled]);
}
