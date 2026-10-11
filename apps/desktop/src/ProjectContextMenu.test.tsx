import { describe, expect, it, afterEach } from 'vitest';
import { nativeFileManagerLabel } from './App';

describe('nativeFileManagerLabel', () => {
  const originalNavigator = globalThis.navigator;

  afterEach(() => {
    Object.defineProperty(globalThis, 'navigator', {
      value: originalNavigator,
      configurable: true,
      writable: true,
    });
  });

  it('returns File Explorer label on Windows', () => {
    Object.defineProperty(globalThis, 'navigator', {
      value: { platform: 'Win32', userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
      configurable: true,
      writable: true,
    });
    expect(nativeFileManagerLabel()).toBe('파일 탐색기에서 열기');
  });

  it('returns Finder label on macOS', () => {
    Object.defineProperty(globalThis, 'navigator', {
      value: { platform: 'MacIntel', userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' },
      configurable: true,
      writable: true,
    });
    expect(nativeFileManagerLabel()).toBe('Finder에서 열기');
  });

  it('returns File Manager label on Linux', () => {
    Object.defineProperty(globalThis, 'navigator', {
      value: { platform: 'Linux x86_64', userAgent: 'Mozilla/5.0 (X11; Linux x86_64)' },
      configurable: true,
      writable: true,
    });
    expect(nativeFileManagerLabel()).toBe('파일 관리자에서 열기');
  });
});
