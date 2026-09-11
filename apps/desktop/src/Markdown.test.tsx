import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Markdown } from './Markdown';

describe('chat Markdown', () => {
  it('renders headings, emphasis, fenced code, lists and GFM tables/tasks', () => {
    const html = renderToStaticMarkup(
      <Markdown
        text={
          '## 제목\n\n**강조**와 `code`\n\n- 항목\n- [x] 완료\n\n```ts\nconst a = 1;\n```\n\n| 열 | 값 |\n| --- | --- |\n| A | ~~B~~ |'
        }
      />,
    );
    for (const tag of [
      '<h2>',
      '<strong>',
      '<code>',
      '<ul ',
      '<pre>',
      '<table>',
      '<del>',
      'type="checkbox"',
    ])
      expect(html).toContain(tag);
  });
  it('does not execute HTML, unsafe links or fetch remote images', () => {
    const html = renderToStaticMarkup(
      <Markdown
        text={
          '<script>alert(1)</script>\n\n[bad](javascript:alert%281%29)\n\n![secret](https://example.com/tracker)\n\n[good](https://example.com)'
        }
      />,
    );
    expect(html).not.toMatch(/<script|<img|javascript:/);
    expect(html).toContain('rel="noreferrer noopener"');
    expect(html).toContain('href="https://example.com"');
  });
  it('renders partial streamed code without losing its text', () => {
    expect(renderToStaticMarkup(<Markdown text={'```ts\nconst 값 ='} />)).toContain('const 값 =');
  });
});
