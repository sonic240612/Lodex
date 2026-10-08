import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { defaultModelConfig, defaultPlan, type Session } from '@lodex/contracts';
import { validateConfig, type McpRegistration } from '@lodex/mcp';
import { McpResourceUpdates } from './McpResourceUpdates';

it('exposes explicit subscription controls only for reviewed resources and explains content review', () => {
  const registration: McpRegistration = {
    id: crypto.randomUUID(),
    revision: 'a'.repeat(64),
    config: validateConfig({
      name: 'Fixture',
      transport: 'http',
      url: 'http://127.0.0.1:8888/mcp',
    }),
    tools: [],
    server: null,
    protocol: null,
    inspectedAt: new Date().toISOString(),
    supportsResourceSubscriptions: true,
  };
  const session: Session = {
    run: null,
    id: crypto.randomUUID(),
    title: 'Fixture',
    version: 1,
    createdAt: '',
    updatedAt: '',
    config: defaultModelConfig(),
    plan: defaultPlan(),
    messages: [],
    mcpAttachments: [
      {
        id: crypto.randomUUID(),
        serverId: registration.id,
        serverRevision: registration.revision,
        kind: 'resource',
        entryKey: 'fixture://reviewed',
        entryRevision: 'b'.repeat(64),
        sha256: 'c'.repeat(64),
        text: 'Reviewed',
        bytes: 8,
        readAt: '',
      },
    ],
  };
  const html = renderToStaticMarkup(
    <McpResourceUpdates session={session} servers={[registration]} disabled={false} />,
  );
  expect(html).toContain('기존 첨부를 제거한 뒤 다시 첨부');
  expect(html).toContain('앱을 재시작하면 알림 연결이 꺼집니다');
  expect(html).toContain('fixture://reviewed');
  expect(html).toMatch(/button[^>]*type="button"[^>]*>변경 알림 받기/);
  const unsupported = renderToStaticMarkup(
    <McpResourceUpdates session={session} servers={[]} disabled={false} />,
  );
  expect(unsupported).toContain('변경 알림 지원이 없습니다');
  expect(unsupported).toMatch(/button[^>]*disabled=""/);
  expect(
    renderToStaticMarkup(
      <McpResourceUpdates
        session={{
          ...session,
          mcpAttachments: [{ ...session.mcpAttachments![0]!, kind: 'prompt' }],
        }}
        servers={[registration]}
        disabled={false}
      />,
    ),
  ).toBe('');
});
