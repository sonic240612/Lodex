import { expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { defaultModelConfig, defaultPlan, taskListSchema, type Session } from '@lodex/contracts';
import { TaskListPanel } from './TaskListPanel';

it('shows ordered progress separately from Goal and locks editing while running', () => {
  const session: Session = {
    id: crypto.randomUUID(),
    version: 1,
    title: '',
    createdAt: '',
    updatedAt: '',
    config: defaultModelConfig(),
    plan: { ...defaultPlan(), goal: 'SEPARATE_GOAL' },
    messages: [],
    run: {
      id: crypto.randomUUID(),
      messageId: crypto.randomUUID(),
      status: 'running',
      startedAt: '',
      finishedAt: null,
    },
    taskList: taskListSchema.parse({
      active: true,
      tasks: [
        {
          id: crypto.randomUUID(),
          title: 'Finished task',
          status: 'completed',
          summary: 'Checked',
        },
        { id: crypto.randomUUID(), title: 'Current task', status: 'in_progress' },
      ],
    }),
  };
  const html = renderToStaticMarkup(
    <TaskListPanel session={session} ensureSession={vi.fn()} onError={vi.fn()} />,
  );
  expect(html).toContain('1 / 2');
  expect(html).toContain('진행 중');
  expect(html).toContain('계속 실행');
  expect(html).not.toContain('SEPARATE_GOAL');
  expect(html).toMatch(/aria-label="작업 2 제목" disabled=""/);
});
