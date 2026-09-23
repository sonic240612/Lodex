import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { McpElicitationBanner } from './McpElicitationBanner';

describe('MCP elicitation banner', () => {
  it('renders bounded primitive fields and keeps the server message as text', () => {
    const html = renderToStaticMarkup(
      <McpElicitationBanner
        busy={false}
        onDecide={vi.fn()}
        onOpen={vi.fn()}
        activity={{
          id: '00000000-0000-4000-8000-000000000001',
          kind: 'tool',
          label: 'MCP 사용자 입력',
          status: 'running',
          text: '',
          elicitation: {
            source: 'mcp_fixture',
            mode: 'form',
            message: '<script>Choose safely</script>',
            status: 'pending',
            requestedAt: '2026-09-23T00:00:00.000Z',
            fields: [
              {
                name: 'name',
                type: 'string',
                title: 'Project name',
                required: true,
                minLength: 1,
                maxLength: 40,
              },
              {
                name: 'kind',
                type: 'select',
                title: 'Kind',
                required: false,
                options: [
                  { value: 'app', title: 'Application' },
                  { value: 'lib', title: 'Library' },
                ],
              },
            ],
          },
        }}
      />,
    );
    expect(html).toContain('MCP 사용자 입력 · mcp_fixture');
    expect(html).toContain('&lt;script&gt;Choose safely&lt;/script&gt;');
    expect(html).not.toContain('<script>');
    expect(html).toContain('aria-label="Project name"');
    expect(html).toContain('Application');
    expect(html).toContain('제출');
  });
});
