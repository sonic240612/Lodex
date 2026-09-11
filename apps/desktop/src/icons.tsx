import type { CSSProperties } from 'react';
const paths = {
  plus: 'M12 5v14M5 12h14',
  folder: 'M3 7V4h6l3 3h9v13H3V7Z',
  arrow: 'M12 19V5m-6 6 6-6 6 6',
  chat: 'M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8v.5Z',
  settings: 'M4 7h16M4 17h16M8 4v6m8 4v6',
  goal: 'M21 12a9 9 0 1 1-9-9m8-1-8 10m3-10h5v5M16 12a4 4 0 1 1-4-4',
  panel: 'M3 4h18v16H3zM15 4v16',
  check: 'm5 12 4 4L19 6',
  close: 'm6 6 12 12M6 18 18 6',
  chevron: 'm9 5 7 7-7 7',
  down: 'm6 9 6 6 6-6',
  stop: 'M6 6h12v12H6z',
  bolt: 'm13 2-9 12h7l-1 8 10-12h-7l1-8Z',
  cloud: 'M7 18a5 5 0 1 1 .6-10A7 7 0 0 1 21 11a3.5 3.5 0 0 1-1 7H7Z',
  chip: 'M7 7h10v10H7zM9 1v4m6-4v4M9 19v4m6-4v4M1 9h4m-4 6h4m14-6h4m-4 6h4',
  trash: 'M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7',
  leaf: 'M20 3C9 2 3 7 5 14c2 7 13 8 15-11ZM3 21l11-11',
  info: 'M12 11v6m0-10v.1M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z',
  moon: 'M21 13a9 9 0 0 1-10-10 9 9 0 1 0 10 10Z',
};
export function Icon({
  name,
  size = 20,
  style,
}: {
  name: keyof typeof paths;
  size?: number;
  style?: CSSProperties;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={style}
    >
      <path d={paths[name]} />
    </svg>
  );
}
export function Logo({ size = 32 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" fill="none" aria-hidden="true">
      <rect width="40" height="40" rx="12" fill="currentColor" opacity=".12" />
      <path d="M11 10h5v17h12v5H11z" fill="currentColor" />
      <rect x="23" y="10" width="6" height="6" rx="1.5" fill="currentColor" />
    </svg>
  );
}
