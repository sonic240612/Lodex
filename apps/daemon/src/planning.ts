import { randomUUID } from 'node:crypto';
import {
  AppError,
  planDraftSchema,
  planSchema,
  type Plan,
  type PlanProposal,
  type ToolDefinition,
} from '@lodex/contracts';
import { z } from 'zod';

export const planningTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'propose_plan',
    description:
      'Propose a goal, concrete completion criteria and ordered tasks for user review. Use unique task keys and dependsOn keys without cycles. Does not change the saved plan or execute work. Preserve the user instructions. The user can adopt and edit the plan in the UI.',
    parameters: z.toJSONSchema(planDraftSchema),
  },
};

export function proposePlan(argumentsJson: string, basePlan: Plan): PlanProposal {
  const draft = planDraftSchema.parse(JSON.parse(argumentsJson));
  const ids = new Map(draft.tasks.map((task) => [task.key, randomUUID()]));
  if (ids.size !== draft.tasks.length)
    throw new AppError('PLAN_KEYS', '작업 key가 중복되었습니다.');
  return {
    basePlan,
    status: 'proposed',
    plan: planSchema.parse({
      ...basePlan,
      goal: draft.goal,
      criteria: draft.criteria,
      includeInContext: true,
      tasks: draft.tasks.map((task) => ({
        id: ids.get(task.key),
        title: task.title,
        criteria: task.criteria,
        done: false,
        dependsOn: task.dependsOn.map((key) => ids.get(key) ?? key),
      })),
    }),
  };
}
