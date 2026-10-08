import { z } from 'zod';

export const taskListSchema = z
  .strictObject({
    sourceMessageId: z.uuid().optional(),
    active: z.boolean().default(false),
    tasks: z
      .array(
        z.strictObject({
          id: z.uuid(),
          title: z.string().trim().min(1).max(500),
          details: z.string().trim().max(2000).default(''),
          status: z.enum(['pending', 'in_progress', 'completed', 'blocked']).default('pending'),
          summary: z.string().trim().max(4000).default(''),
        }),
      )
      .max(100),
  })
  .superRefine((list, ctx) => {
    if (new Set(list.tasks.map((task) => task.id)).size !== list.tasks.length)
      ctx.addIssue({ code: 'custom', message: '작업 ID가 중복되었습니다.' });
    const open = list.tasks.filter((task) => task.status !== 'completed');
    if (open.slice(1).some((task) => task.status === 'in_progress' || task.status === 'blocked'))
      ctx.addIssue({ code: 'custom', message: '첫 번째 미완료 작업부터 순서대로 진행하세요.' });
    if (list.active !== (open[0]?.status === 'in_progress'))
      ctx.addIssue({ code: 'custom', message: '작업 실행 상태가 일치하지 않습니다.' });
  });
export type TaskList = z.infer<typeof taskListSchema>;
export const emptyTaskList = (): TaskList => ({ active: false, tasks: [] });
export function pauseTaskList(input: TaskList): TaskList {
  return {
    ...input,
    active: false,
    tasks: input.tasks.map((task) =>
      task.status === 'in_progress' ? { ...task, status: 'pending' } : task,
    ),
  };
}
export function startTaskList(input: TaskList | undefined): TaskList {
  const list = structuredClone(input ?? emptyTaskList());
  const next = list.tasks.find((task) => task.status !== 'completed');
  if (!next) throw new Error('진행할 작업 계획이 없습니다.');
  next.status = 'in_progress';
  next.summary = '';
  list.active = true;
  return taskListSchema.parse(list);
}

/** This is progress reported by the agent, separate from Goal's verified completion. */
export function taskListPrompt(list: TaskList) {
  const first = list.tasks.findIndex((task) => task.status !== 'completed');
  const start = Math.max(0, first < 0 ? list.tasks.length - 1 : first);
  const visible = list.tasks.slice(start, start + 5).map((task) => ({
    ...task,
    title: task.title.slice(0, 200),
    summary: task.summary.slice(0, 300),
    details: task.id === list.tasks[start]?.id ? task.details : task.details.slice(0, 200),
  }));
  return (
    'Saved ordered task list (progress records, not proof of correctness):\n' +
    JSON.stringify({
      active: list.active,
      total: list.tasks.length,
      completed: list.tasks.filter((task) => task.status === 'completed').length,
      tasks: visible,
    }) +
    '\nUse the saved investigation. For implementation, call update_task before working and after checking each result. Continue one task at a time. Mark blocked with a concrete reason when unable to proceed; pending pauses the list when the user changes direction. Do not create a Goal for this list.'
  );
}
