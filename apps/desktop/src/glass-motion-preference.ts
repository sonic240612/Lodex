import { useEffect, useState } from 'react';

export type GlassEffectsPreference = 'system' | 'full' | 'reduced';
const storageKey = 'lodex.glass-effects.v1';
const transparencyKey = 'lodex.glass-transparency.v1';
const defaultTransparency = 45;
type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

function availableStorage(): StorageLike | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

export function loadGlassEffectsPreference(storage = availableStorage()): GlassEffectsPreference {
  try {
    const value = storage?.getItem(storageKey);
    return value === 'full' || value === 'reduced' ? value : 'system';
  } catch {
    return 'system';
  }
}

export function saveGlassEffectsPreference(
  preference: GlassEffectsPreference,
  storage = availableStorage(),
): void {
  try {
    storage?.setItem(storageKey, preference);
  } catch {
    // Appearance controls remain usable when storage is unavailable.
  }
}

export function resolveGlassMotion(preference: GlassEffectsPreference, systemReduced: boolean) {
  return preference === 'full' || (preference === 'system' && !systemReduced);
}

export function loadGlassTransparency(storage = availableStorage()): number {
  try {
    const stored = storage?.getItem(transparencyKey);
    if (stored == null || stored.trim() === '') return defaultTransparency;
    const value = Number(stored);
    return Number.isFinite(value)
      ? Math.max(0, Math.min(100, Math.round(value)))
      : defaultTransparency;
  } catch {
    return defaultTransparency;
  }
}

export function useGlassMotionPreference() {
  const [preference, setPreference] = useState(loadGlassEffectsPreference);
  const [transparency, setTransparency] = useState(loadGlassTransparency);
  const [systemReducedMotion, setSystemReducedMotion] = useState(
    () =>
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  );
  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setSystemReducedMotion(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  useEffect(() => saveGlassEffectsPreference(preference), [preference]);
  useEffect(() => {
    try {
      availableStorage()?.setItem(transparencyKey, String(transparency));
    } catch {
      // The slider still works when the preference store is blocked.
    }
  }, [transparency]);
  return {
    preference,
    setPreference,
    transparency,
    setTransparency,
    systemReducedMotion,
    allowMotion: resolveGlassMotion(preference, systemReducedMotion),
  };
}
