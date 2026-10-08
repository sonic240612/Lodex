import { expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { LspManager } from './LspManager';
it('requires host execution consent and an explicit installed executable before registration', () => {
  const html = renderToStaticMarkup(<LspManager projects={[]} selectedId={null} />);
  expect(html).toContain('aria-label=');
  expect(html).toContain('type="checkbox"');
  expect(html).not.toContain('checked=""');
  expect(html).toContain('JSON');
  expect(html).toMatch(/button[^>]*disabled/);
  expect(html).toContain('Plan');
});
