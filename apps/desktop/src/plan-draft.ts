import type { Plan } from '@lodex/contracts';

export function appendPlanTask(plan: Plan, title: string, id: string): Plan {
  const normalized = title.trim();
  if (!normalized || plan.tasks.length >= 100 || plan.tasks.some((task) => task.id === id))
    return plan;
  return { ...plan, tasks: [...plan.tasks, { id, title: normalized, done: false }] };
}

export function removePlanTask(plan: Plan, id: string): Plan {
  return {
    ...plan,
    tasks: plan.tasks
      .filter((task) => task.id !== id)
      .map((task) => ({
        ...task,
        dependsOn: task.dependsOn?.filter((dependency) => dependency !== id),
      })),
  };
}

/** Removes unsavable transient rows and repairs dependencies before crossing the command boundary. */
export function normalizePlanDraft(plan: Plan): Plan {
  const ids = new Set<string>();
  const tasks = plan.tasks.filter((task) => {
    if (!task.title.trim() || ids.has(task.id)) return false;
    ids.add(task.id);
    return true;
  });
  return {
    ...plan,
    tasks: tasks.map((task) => {
      const dependencies = [...new Set(task.dependsOn ?? [])].filter(
        (dependency) => dependency !== task.id && ids.has(dependency),
      );
      const { dependsOn, ...rest } = task;
      return {
        ...rest,
        title: task.title.trim(),
        ...(dependsOn ? { dependsOn: dependencies } : {}),
      };
    }),
  };
}
