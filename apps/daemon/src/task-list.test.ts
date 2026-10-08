import { expect, it } from 'vitest';
import { startTaskList, taskListPrompt } from '@lodex/contracts';
import { createTaskList, updateTask } from './task-list';

it('keeps ordered progress, completion evidence, blockers and pause separate from Goal', () => {
  const list = createTaskList(
    JSON.stringify({
      tasks: [{ title: 'Implement', details: 'Reuse Plan evidence' }, { title: 'Test' }],
    }),
    crypto.randomUUID(),
  );
  expect(list.active).toBe(false);
  expect(() =>
    updateTask(list, JSON.stringify({ taskId: list.tasks[1]!.id, status: 'in_progress' })),
  ).toThrow();
  expect(() =>
    updateTask(
      list,
      JSON.stringify({ taskId: list.tasks[0]!.id, status: 'completed', summary: 'Claim' }),
    ),
  ).toThrow();
  const started = startTaskList(list);
  expect(() =>
    updateTask(started, JSON.stringify({ taskId: list.tasks[0]!.id, status: 'completed' })),
  ).toThrow();
  const next = updateTask(
    started,
    JSON.stringify({
      taskId: list.tasks[0]!.id,
      status: 'completed',
      summary: 'File updated and diff reviewed',
    }),
  );
  expect(next.tasks.map((task) => task.status)).toEqual(['completed', 'in_progress']);
  const blocked = updateTask(
    next,
    JSON.stringify({
      taskId: list.tasks[1]!.id,
      status: 'blocked',
      summary: 'Required service unavailable',
    }),
  );
  expect(blocked.active).toBe(false);
  const paused = updateTask(
    startTaskList(blocked),
    JSON.stringify({
      taskId: list.tasks[1]!.id,
      status: 'pending',
      summary: 'User changed direction',
    }),
  );
  expect(paused.active).toBe(false);
  const done = updateTask(
    startTaskList(paused),
    JSON.stringify({ taskId: list.tasks[1]!.id, status: 'completed', summary: 'Tests passed' }),
  );
  expect(done.active).toBe(false);
  expect(() => startTaskList(done)).toThrow();
  expect(taskListPrompt(next)).toContain('Test');
  expect(list.tasks[0]!.status).toBe('pending');
});
