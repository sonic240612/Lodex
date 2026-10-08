import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { taskListSchema, type TaskList, type ToolDefinition } from '@lodex/contracts';

const draftSchema = z.strictObject({
  tasks: z
    .array(
      z.strictObject({
        title: z.string().trim().min(1).max(500),
        details: z.string().trim().max(2000).optional(),
      }),
    )
    .min(1)
    .max(100),
});
const progressSchema = z.strictObject({
  taskId: z.uuid(),
  status: z.enum(['pending', 'in_progress', 'completed', 'blocked']),
  summary: z.string().trim().max(4000).default(''),
});
export const setTaskListTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'set_task_list',
    description:
      'Save an ordered to-do list from the Plan investigation. Include actionable steps and checks in details. Replaces only the task list, never the Goal. Does not execute work. The user can edit it and continue in Build after this Plan response.',
    parameters: z.toJSONSchema(draftSchema),
  },
};
export const updateTaskTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'update_task',
    description:
      'Update the first unfinished item of the saved task list. Start it with in_progress, check its result then report completed with evidence in summary. Completion advances to the next item. blocked requires a reason and pauses execution; pending pauses when the user changes direction. This records progress, not independently verified Goal completion.',
    parameters: z.toJSONSchema(progressSchema),
  },
};
export function createTaskList(argumentsJson: string, sourceMessageId: string): TaskList {
  const draft = draftSchema.parse(JSON.parse(argumentsJson));
  return taskListSchema.parse({
    sourceMessageId,
    active: false,
    tasks: draft.tasks.map((task) => ({ ...task, id: randomUUID(), status: 'pending' })),
  });
}
export function updateTask(input: TaskList | undefined, argumentsJson: string): TaskList {
  const args = progressSchema.parse(JSON.parse(argumentsJson));
  if (!input) throw new Error('저장된 작업 계획이 없습니다.');
  const list = structuredClone(input);
  const task = list.tasks.find((item) => item.status !== 'completed');
  if (!task || task.id !== args.taskId) throw new Error('첫 번째 미완료 작업부터 진행하세요.');
  if (args.status === 'completed' && task.status !== 'in_progress')
    throw new Error('작업을 시작하고 결과를 확인한 뒤 완료하세요.');
  if (['completed', 'blocked'].includes(args.status) && !args.summary)
    throw new Error('완료 근거 또는 진행할 수 없는 이유를 적어 주세요.');
  task.status = args.status;
  task.summary = args.summary;
  if (args.status === 'completed') {
    const next = list.tasks.find((item) => item.status !== 'completed');
    if (next) next.status = 'in_progress';
    list.active = !!next;
  } else list.active = args.status === 'in_progress';
  return taskListSchema.parse(list);
}
