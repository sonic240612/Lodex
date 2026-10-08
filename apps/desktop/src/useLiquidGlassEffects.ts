import { useEffect, type RefObject } from 'react';
import { attachGlassControlGestures } from './glass-control-gestures';

/** Enables material gestures without tracking a cursor spotlight. */
export function attachLiquidGlassEffects(root: HTMLElement, allowMotion?: boolean): () => void {
  const view = root.ownerDocument.defaultView;
  if (!view) return () => {};
  const preferences = [
    view.matchMedia('(prefers-reduced-motion: reduce)'),
    view.matchMedia('(prefers-reduced-transparency: reduce)'),
    view.matchMedia('(forced-colors: active)'),
    view.matchMedia('(prefers-contrast: more)'),
  ];
  let listening = false;
  let stopGestures: (() => void) | undefined;

  function updatePreferences() {
    const enabled =
      (allowMotion ?? !preferences[0]!.matches) &&
      !preferences.slice(1).some((preference) => preference.matches);
    if (enabled === listening) return;
    listening = enabled;
    if (enabled) {
      stopGestures = attachGlassControlGestures(root);
    } else {
      stopGestures?.();
      stopGestures = undefined;
    }
  }

  for (const preference of preferences) preference.addEventListener('change', updatePreferences);
  updatePreferences();
  return () => {
    for (const preference of preferences)
      preference.removeEventListener('change', updatePreferences);
    stopGestures?.();
    stopGestures = undefined;
    listening = false;
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
