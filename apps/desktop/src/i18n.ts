import { useEffect, useSyncExternalStore } from 'react';
import english from './locales/en.json';
export type Locale = 'ko' | 'en';
const listeners = new Set<() => void>();
let locale: Locale;
function current(): Locale {
  if (locale) return locale;
  try {
    const saved = globalThis.localStorage?.getItem('lodex.language');
    if (saved === 'ko' || saved === 'en') return (locale = saved);
  } catch {
    /* Private storage may be unavailable. */
  }
  return (locale = 'ko');
}
export function setLocale(next: Locale) {
  if (next !== 'ko' && next !== 'en') return;
  locale = next;
  try {
    globalThis.localStorage?.setItem('lodex.language', next);
  } catch {
    /* Keep the in-memory selection. */
  }
  for (const notify of listeners) notify();
}
function subscribe(notify: () => void) {
  listeners.add(notify);
  return () => {
    listeners.delete(notify);
  };
}
export function useLocale() {
  const value = useSyncExternalStore(subscribe, current, current);
  useEffect(() => {
    document.documentElement.lang = value;
  }, [value]);
  useEffect(() => {
    const changed = (event: StorageEvent) => {
      if (event.key === 'lodex.language' && (event.newValue === 'ko' || event.newValue === 'en')) {
        locale = event.newValue;
        for (const notify of listeners) notify();
      }
    };
    window.addEventListener('storage', changed);
    return () => window.removeEventListener('storage', changed);
  }, []);
  return value;
}
/** Translate application copy only. User messages, paths and provider output stay untouched. */
export function t(source: string, ...values: unknown[]): string {
  const key = source.replace(/\s+/g, ' ').trim();
  const translated =
    current() === 'en' ? ((english as Record<string, string>)[key] ?? source) : source;
  return translated.replace(/\{(\d+)\}/g, (match, index: string) =>
    Number(index) < values.length ? String(values[Number(index)]) : match,
  );
}
