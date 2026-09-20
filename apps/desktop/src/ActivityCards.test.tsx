import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ActivityCards } from './ActivityCards';
describe('activity disclosure', () => {
  it('keeps uncertain MCP outcomes visible in the collapsed summary and escapes server text', () => {
    const html = renderToStaticMarkup(
      <ActivityCards
        activities={[
          {
            id: 'mcp',
            kind: 'tool',
            label: 'mcp_fixture',
            status: 'cancelled',
            text: '<script>fixture</script>',
            mcpCall: {
              serverId: 'server',
              serverRevision: '1',
              toolName: 'echo',
              toolRevision: '1',
              status: 'unknown',
              startedAt: '2026-09-12',
              error: 'Check the server result',
            },
          },
        ]}
      />,
    );
    expect(html).toContain('실행 결과 미확인');
    expect(html).toContain('MCP · echo');
    expect(html).not.toMatch(/<details[^>]*\sopen/);
    expect(html).not.toContain('<script>');
  });
  it('shows every grouped diff and partial state inside a collapsed activity', () => {
    const html = renderToStaticMarkup(
      <ActivityCards
        sessionId="preview"
        activities={[
          {
            id: 'set',
            kind: 'tool',
            label: 'propose_changes',
            status: 'completed',
            text: '',
            changes: {
              status: 'partial',
              files: [
                {
                  path: 'a.ts',
                  beforeHash: '',
                  afterHash: '',
                  oldText: '1',
                  newText: '2',
                  diff: '-one\n+two',
                  status: 'proposed',
                },
                {
                  kind: 'create',
                  path: 'new.ts',
                  content: '<script>x</script>',
                  afterHash: '',
                  stagingId: crypto.randomUUID(),
                  diff: '+<script>x</script>',
                },
              ],
              observations: [
                { path: 'a.ts', state: 'after' },
                { path: 'new.ts', state: 'before' },
              ],
            },
          },
        ]}
      />,
    );
    expect(html).toContain('2개 파일 변경');
    expect(html).toContain('일부 파일 적용됨');
    expect(html).toContain('a.ts 변경 비교');
    expect(html).toContain('new.ts 변경 비교');
    expect(html).toContain('남은 변경 적용');
    expect(html).toContain('변경 되돌리기');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
    expect(html).not.toMatch(/<details[^>]*\bopen(?:[=>\s])/);
  });
  it('renders thinking and tool output collapsed, with no HTML execution', () => {
    const html = renderToStaticMarkup(
      <ActivityCards
        activities={[
          {
            id: 'thinking',
            kind: 'thinking',
            label: 'Thinking',
            status: 'running',
            text: '<script>unsafe()</script>',
          },
          {
            id: 'tool',
            kind: 'tool',
            label: 'read_file',
            status: 'completed',
            arguments: '{"path":"a.ts"}',
            text: 'file content',
          },
        ]}
      />,
    );
    expect(html.match(/<details\b/g)).toHaveLength(2);
    expect(html.match(/<summary>/g)).toHaveLength(2);
    expect(html).not.toMatch(/<details[^>]*\bopen(?:[=>\s])/);
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('Lodex');
  });
  it('shows the permission decision and risk reason in the activity audit', () => {
    const html = renderToStaticMarkup(
      <ActivityCards
        activities={[
          {
            id: 'approval',
            kind: 'tool',
            label: 'run_command',
            status: 'completed',
            text: 'rejected',
            approval: {
              kind: 'command',
              target: 'npm install',
              actor: 'desktop',
              mode: 'auto',
              risk: 'high',
              reason: 'Docker 명령이 외부 네트워크에 접근할 수 있습니다.',
              status: 'rejected',
              decidedBy: 'user',
              requestedAt: '2026-09-20T00:00:00.000Z',
              decidedAt: '2026-09-20T00:00:01.000Z',
            },
          },
        ]}
      />,
    );
    expect(html).toContain('권한 · 대신 승인');
    expect(html).toContain('사용자 거절');
    expect(html).toContain('높은 위험');
    expect(html).toContain('외부 네트워크');
  });
});
