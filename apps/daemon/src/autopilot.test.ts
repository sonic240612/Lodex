import { describe, expect, it } from 'vitest';
import {
  autopilotLimitsSchema,
  defaultExecutionConfig,
  defaultModelConfig,
  defaultPlan,
  prepareAutopilot,
  readyAutopilotTasks,
  type Session,
} from '@lodex/contracts';
import { verifyAutopilot } from './autopilot';
import type { executeCommand } from '@lodex/tools';
function source(): Session {
  const first = crypto.randomUUID(),
    second = crypto.randomUUID();
  return {
    id: crypto.randomUUID(),
    version: 1,
    title: '',
    createdAt: '',
    updatedAt: '',
    mode: 'build',
    projectId: crypto.randomUUID(),
    execution: { ...defaultExecutionConfig(), backend: 'docker', projectAccess: true },
    config: defaultModelConfig(),
    messages: [],
    run: null,
    plan: {
      ...defaultPlan(),
      goal: 'Fix bug',
      criteria: 'Regression passes',
      verificationCommand: 'npm test',
      includeInContext: true,
      tasks: [
        {
          id: first,
          title: 'Fix',
          done: true,
          criteria: 'Fixed',
          verificationCommand: 'npm run test:unit',
        },
        {
          id: second,
          title: 'Review',
          done: false,
          criteria: 'Regression',
          verificationCommand: 'npm run test:regression',
          dependsOn: [first],
        },
      ],
    },
  };
}
describe('goal verification and scheduling', () => {
  it('includes dependencies and never treats a manual checkbox as verification', () => {
    const session = source();
    const state = prepareAutopilot(
      session,
      [session.plan.tasks[1]!.id],
      autopilotLimitsSchema.parse({}),
    );
    expect(state.taskIds).toEqual(session.plan.tasks.map((t) => t.id));
    expect(state.completedTaskIds).toEqual([]);
    expect(readyAutopilotTasks(state).map((t) => t.id)).toEqual([session.plan.tasks[0]!.id]);
    expect(() => prepareAutopilot({ ...session, mode: 'plan' }, [], state.limits)).toThrow();
    expect(
      prepareAutopilot(
        { ...session, config: { ...session.config, provider: 'openrouter' } },
        [],
        state.limits,
      ).limits.costUsd,
    ).toBe(1);
    expect(state).toMatchObject({
      spentCostUsd: 0,
      reservedCostUsd: 0,
      costUnconfirmed: false,
    });
    expect(() =>
      prepareAutopilot(
        { ...session, plan: { ...session.plan, verificationCommand: '' } },
        [],
        state.limits,
      ),
    ).toThrow();
    expect(() => prepareAutopilot(session, [crypto.randomUUID()], state.limits)).toThrow();
  });
  it('runs the saved check, rejects unready tasks and requires all task checks before final verification', async () => {
    const session = source(),
      state = prepareAutopilot(session, [], autopilotLimitsSchema.parse({}));
    const commands: string[] = [];
    let code = 5;
    const executor: typeof executeCommand = async (options) => {
      const command = JSON.parse(options.argumentsJson).command as string;
      commands.push(command);
      const id = crypto.randomUUID();
      return {
        id,
        containerName: 'lodex-' + id,
        command,
        cwd: '.',
        status: code === 0 ? 'completed' : 'failed',
        startedAt: '',
        exitCode: code,
        output: 'fixture',
        truncated: false,
        cleanupPending: false,
      };
    };
    const base = {
      state,
      project: { id: session.projectId!, path: '/fixture', identity: '', name: '', createdAt: '' },
      config: session.execution!,
      signal: AbortSignal.timeout(5000),
      record: async () => {},
      executor,
    };
    await expect(
      verifyAutopilot({
        ...base,
        name: 'verify_task',
        argumentsJson: JSON.stringify({ taskId: session.plan.tasks[1]!.id }),
      }),
    ).rejects.toMatchObject({ code: 'TASK_NOT_READY' });
    await expect(
      verifyAutopilot({ ...base, name: 'verify_goal', argumentsJson: '{}' }),
    ).rejects.toMatchObject({ code: 'GOAL_PENDING' });
    const failed = await verifyAutopilot({
      ...base,
      name: 'verify_task',
      argumentsJson: JSON.stringify({ taskId: session.plan.tasks[0]!.id }),
    });
    expect(failed.passed).toBe(false);
    expect(state.completedTaskIds).toEqual([]);
    code = 0;
    for (const task of session.plan.tasks)
      await verifyAutopilot({
        ...base,
        name: 'verify_task',
        argumentsJson: JSON.stringify({ taskId: task.id }),
      });
    expect(state.status).toBe('running');
    await verifyAutopilot({ ...base, name: 'verify_goal', argumentsJson: '{}' });
    expect(state.status).toBe('completed');
    expect(commands).toEqual([
      'npm run test:unit',
      'npm run test:unit',
      'npm run test:regression',
      'npm test',
    ]);
    expect(state.evidence.map((e) => e.passed)).toEqual([false, true, true, true]);
  });
});
