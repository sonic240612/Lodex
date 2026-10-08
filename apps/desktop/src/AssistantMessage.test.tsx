import { expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Message } from '@lodex/contracts';
import { AssistantMessage, transcriptParts, workDuration } from './AssistantMessage';

const message = (): Message => ({
  id: 'reply',
  role: 'assistant',
  createdAt: '2026-10-08T00:00:00Z',
  workFinishedAt: '2026-10-08T02:14:03Z',
  status: 'complete',
  usage: null,
  error: null,
  content: '먼저 파일을 확인합니다.\n\n검사를 실행합니다.\n\n수정을 완료했습니다.',
  finalResponseOffset: '먼저 파일을 확인합니다.\n\n검사를 실행합니다.\n\n'.length,
  activities: [
    {
      id: 'a',
      kind: 'tool',
      label: 'read_file',
      arguments: '{"path":"main.ts"}',
      status: 'completed',
      text: 'source',
      contentOffset: '먼저 파일을 확인합니다.'.length,
    },
    {
      id: 'b',
      kind: 'tool',
      label: 'run_host_command',
      arguments: '{"command":"npm test"}',
      status: 'completed',
      text: 'passed',
      contentOffset: '먼저 파일을 확인합니다.\n\n검사를 실행합니다.'.length,
    },
  ],
});
it('folds ordered commentary and tool rows before the final answer, with persisted elapsed time', () => {
  const html = renderToStaticMarkup(
    <AssistantMessage message={message()} sessionId="s" showActivities />,
  );
  expect(html).toContain('2시간 14분 동안 작업');
  expect(html.indexOf('먼저 파일')).toBeLessThan(html.indexOf('main.ts'));
  expect(html.indexOf('main.ts')).toBeLessThan(html.indexOf('검사를 실행'));
  expect(html.indexOf('검사를 실행')).toBeLessThan(html.indexOf('npm test'));
  expect(html.lastIndexOf('</details>')).toBeLessThan(html.indexOf('수정을 완료'));
  expect(html).not.toMatch(/<details[^>]*\sopen/);
  expect(html).not.toContain('Lodex');
});
it('shows streamed commentary and collapsed individual tools without an outer fold', () => {
  const value = message();
  value.status = 'streaming';
  delete value.workFinishedAt;
  const html = renderToStaticMarkup(
    <AssistantMessage message={value} sessionId="s" showActivities />,
  );
  expect(html).not.toContain('class="work-history"');
  expect(html).toContain('째 작업 중');
  expect(html.match(/<details\b/g)).toHaveLength(2);
  expect(html).not.toMatch(/<details[^>]*\sopen/);
});
it('preserves all text and handles legacy messages, hidden tools and nonmonotonic offsets', () => {
  const value = message();
  delete value.finalResponseOffset;
  delete value.workFinishedAt;
  const html = renderToStaticMarkup(
    <AssistantMessage message={value} sessionId="s" showActivities />,
  );
  expect(html.lastIndexOf('</details>')).toBeLessThan(html.indexOf('먼저 파일'));
  const hidden = renderToStaticMarkup(
    <AssistantMessage message={value} sessionId="s" showActivities={false} />,
  );
  expect(hidden).not.toContain('npm test');
  expect(hidden).toContain('수정을 완료');
  const activities = value.activities!;
  activities[0]!.contentOffset = 9000;
  activities[1]!.contentOffset = -2;
  expect(
    transcriptParts(value.content, activities)
      .flatMap((p) => ('text' in p ? [p.text] : []))
      .join(''),
  ).toBe(value.content);
  expect(workDuration(value.createdAt, '2026-10-08T00:00:08Z')).toBe('8초');
});
