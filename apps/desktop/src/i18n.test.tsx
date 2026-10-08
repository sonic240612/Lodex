import { afterEach, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFile, readdir } from 'node:fs/promises';
import { parse } from '@babel/parser';
import { setLocale, t } from './i18n';
import english from './locales/en.json';
import { SettingsScreen } from './SettingsScreen';

afterEach(() => {
  setLocale('ko');
  vi.unstubAllGlobals();
});

it('switches application labels while preserving dynamic user content', () => {
  expect(t('설정')).toBe('설정');
  const storage = { setItem: vi.fn() };
  vi.stubGlobal('localStorage', storage);
  setLocale('en');
  expect(storage.setItem).toHaveBeenCalledWith('lodex.language', 'en');
  expect(t('설정')).toBe('Settings');
  expect(t('도구 호출 {0}', '<my project>')).toBe('Tool calls: <my project>');
  expect(t('user content without a translation')).toBe('user content without a translation');
  const html = renderToStaticMarkup(
    <SettingsScreen selected="data" onSelect={() => {}} onClose={() => {}}>
      <p>사용자 내용</p>
    </SettingsScreen>,
  );
  expect(html).toContain('Data &amp; backups');
  expect(html).toContain('aria-label="Display language"');
  expect(html).toContain('value="en" selected');
  expect(html).toContain('사용자 내용');
  setLocale('ko');
  expect(t('설정')).toBe('설정');
});

it('keeps language switching usable when local storage is unavailable', () => {
  vi.stubGlobal('localStorage', {
    setItem() {
      throw new Error('blocked');
    },
  });
  expect(() => setLocale('en')).not.toThrow();
  expect(t('설정')).toBe('Settings');
});

it('restores the selected language on the next application load', async () => {
  vi.stubGlobal('localStorage', { getItem: () => 'en', setItem: vi.fn() });
  vi.resetModules();
  const restarted = await import('./i18n');
  expect(restarted.t('설정')).toBe('Settings');
  restarted.setLocale('ko');
});

it('provides translations and matching placeholders for every literal UI translation key', async () => {
  const dictionary = english as Record<string, string>;
  const missing = new Set<string>();
  for (const filename of await readdir(new URL('.', import.meta.url))) {
    if (!/\.tsx?$/.test(filename) || filename.includes('.test.')) continue;
    const source = await readFile(new URL(filename, import.meta.url), 'utf8');
    const ast = parse(source, { sourceType: 'module', plugins: ['typescript', 'jsx'] });
    function walk(value: unknown): void {
      if (!value || typeof value !== 'object') return;
      const node = value as Record<string, any>;
      if (
        node.type === 'CallExpression' &&
        node.callee?.name === 'localize' &&
        node.arguments?.[0]?.type === 'StringLiteral'
      ) {
        const key = (node.arguments[0].value as string).replace(/\s+/g, ' ').trim();
        if (/[가-힣]/.test(key) && !dictionary[key]) missing.add(`${filename}: ${key}`);
      }
      for (const [key, child] of Object.entries(node))
        if (!['loc', 'comments', 'tokens'].includes(key)) {
          if (Array.isArray(child)) child.forEach(walk);
          else walk(child);
        }
    }
    walk(ast.program);
  }
  expect([...missing]).toEqual([]);
  for (const [key, translation] of Object.entries(dictionary)) {
    expect(translation.trim(), key).not.toBe('');
    expect([...translation.matchAll(/\{\d+\}/g)].map((match) => match[0]).sort(), key).toEqual(
      [...key.matchAll(/\{\d+\}/g)].map((match) => match[0]).sort(),
    );
  }
});
