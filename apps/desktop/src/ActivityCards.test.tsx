import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ActivityCards } from './ActivityCards';
describe('activity disclosure', () => {
  it('uses a plain Korean name for new and saved Eco summary activities', () => {
    for (const label of ['Eco 증분 LLM 압축', 'Eco 자동 요약']) {
      const html = renderToStaticMarkup(
        <ActivityCards
          activities={[
            { id: 'eco', kind: 'tool', label, status: 'completed', text: '1000 → 500 토큰' },
          ]}
        />,
      );
      expect(html).toContain('Eco 자동 요약');
      expect(html).not.toContain('증분');
    }
  });
  it('summarizes current work, shows targets, and keeps attention visible without opening the feed', () => {
    const html = renderToStaticMarkup(
      <ActivityCards
        activities={[
          {
            id: 'read',
            kind: 'tool',
            label: 'read_file',
            arguments: '{"path":"src/app.ts"}',
            status: 'running',
            text: '',
          },
          {
            id: 'failure',
            kind: 'tool',
            label: 'run_command',
            arguments: '{"command":"npm test"}',
            status: 'failed',
            text: 'failed',
          },
        ]}
      />,
    );
    expect(html).toContain('activity-feed-summary');
    expect(html).toContain('파일 읽기');
    expect(html).toContain('src/app.ts');
    expect(html).toContain('확인 필요 1');
    expect(html).toContain('명령 실행');
    expect(html).toContain('npm test');
    expect(html).not.toMatch(/<details[^>]*\sopen/);
  });
  it('shows fused execution and observation receipts without claiming a skipped check passed', () => {
    const html = renderToStaticMarkup(
      <ActivityCards
        activities={[
          {
            id: 'fusion',
            kind: 'tool',
            label: 'propose_edit',
            status: 'failed',
            text: 'conflict',
            fusion: { status: 'skipped' },
            observation: { id: 'obs_0123456789abcdef01234567', bytes: 12345 },
          },
        ]}
      />,
    );
    expect(html).toContain('Action Fusion');
    expect(html).toContain('후속 명령을 실행하지 않았습니다.');
    expect(html).toContain('ObservationPack');
    expect(html).toContain('obs_0123456789abcdef01234567');
    expect(html).not.toContain('종료 코드 0으로 완료');
    expect(html).not.toMatch(/<details[^>]*\sopen/);
  });
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
    expect(html.match(/<details\b/g)).toHaveLength(3);
    expect(html.match(/<summary(?:>|\s)/g)).toHaveLength(3);
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
