import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { Activity, PermissionDecision } from '@lodex/contracts';
import { ApprovalBanner } from './ApprovalBanner';

function activity(kind: PermissionDecision['kind']): Activity {
  return {
    id: 'activity',
    kind: 'tool',
    label: 'tool',
    status: 'running',
    text: '',
    approval: {
      kind,
      target: 'https://example.com/docs?q=api',
      actor: 'desktop',
      mode: 'ask',
      risk: 'high',
      reason: '외부 URL로 GET 요청을 보냅니다.',
      status: 'pending',
      requestedAt: '2026-10-01T00:00:00.000Z',
    },
  };
}

describe('approval banner', () => {
  it('shows the exact URL and enables web approval in Plan', () => {
    const html = renderToStaticMarkup(
      <ApprovalBanner activity={activity('web')} mode="plan" busy={false} onDecide={vi.fn()} />,
    );
    expect(html).toContain('웹 조회 권한 요청');
    expect(html).toContain('https://example.com/docs?q=api');
    expect(html).toContain('aria-labelledby=');
    expect(html).toContain('aria-describedby=');
    expect(html).not.toContain('disabled');
  });

  it.each(['file', 'command', 'fusion', 'mcp'] as const)(
    'blocks %s approval in Plan while allowing rejection',
    (kind) => {
      const html = renderToStaticMarkup(
        <ApprovalBanner activity={activity(kind)} mode="plan" busy={false} onDecide={vi.fn()} />,
      );
      expect(html).toContain('<button>거절</button>');
      expect(html).toMatch(/class="permission-allow" disabled=""/);
    },
  );

  it('disables both decisions while a request is being submitted', () => {
    const html = renderToStaticMarkup(
      <ApprovalBanner activity={activity('web')} mode="build" busy onDecide={vi.fn()} />,
    );
    expect(html.match(/disabled=""/g)).toHaveLength(2);
  });
});
