import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  autopilotLimitsSchema,
  defaultExecutionConfig,
  defaultModelConfig,
  defaultPlan,
  prepareAutopilot,
  prepareGoal,
  readyAutopilotTasks,
  type Session,
} from '@lodex/contracts';
import {
  completeGoal,
  goalResumeEvidence,
  invalidateVerification,
  verifyAutopilot,
} from './autopilot';
import { digest, inspectProject } from '@lodex/tools';
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
  it('restores only the interrupted goal evidence and strips a previous model reasoning state', () => {
    const session = source();
    const state = prepareGoal(
      session,
      'continue',
      autopilotLimitsSchema.parse({}),
      crypto.randomUUID(),
    );
    const id = crypto.randomUUID();
    state.messageId = id;
    session.autopilot = state;
    session.messages = [
      {
        id,
        role: 'assistant',
        content: 'partial',
        createdAt: new Date().toISOString(),
        status: 'failed',
        error: 'interrupted',
        usage: null,
        inferenceConfig: session.config,
        continuation: [
          {
            role: 'assistant',
            content: '',
            reasoningContent: 'opaque prior reasoning',
            toolCalls: [{ id: 'old-call', name: 'mcp_notify', arguments: '{}' }],
          },
          {
            role: 'tool',
            content: 'notification already sent',
            toolCallId: 'old-call',
            toolName: 'mcp_notify',
          },
        ],
      },
      {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: 'unrelated failed conversation',
        createdAt: new Date().toISOString(),
        status: 'failed',
        error: 'other',
        usage: null,
      },
    ];
    const original = JSON.stringify(session.messages);
    expect(JSON.stringify(goalResumeEvidence(session))).toContain('opaque prior reasoning');
    session.config = { ...session.config, model: 'another-model' };
    const evidence = JSON.stringify(goalResumeEvidence(session));
    expect(evidence).toContain('notification already sent');
    expect(evidence).not.toContain('opaque prior reasoning');
    expect(evidence).not.toContain('unrelated failed conversation');
    expect(JSON.stringify(session.messages)).toBe(original);
  });
  const roots: string[] = [];
  afterEach(async () => {
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  });
  it('requires explicit confirmation for prose, even when the model claims success', async () => {
    const state = prepareGoal(source(), 'produce answer', autopilotLimitsSchema.parse({}));
    const runtime = { executions: [], signal: new AbortController().signal };
    await expect(completeGoal(state, '{"evidence":"done"}', runtime)).rejects.toMatchObject({
      code: 'VERIFICATION_REQUIRED',
    });
    expect(state.status).toBe('running');
    expect(
      await completeGoal(state, '{"evidence":"done"}', { ...runtime, confirm: async () => false }),
    ).toMatchObject({ completed: false });
    expect(state.status).toBe('running');
    await completeGoal(state, '{"evidence":"answer provided"}', {
      ...runtime,
      confirm: async () => true,
    });
    expect(state.evidence.at(-1)).toMatchObject({ source: 'user', passed: true, revision: 0 });
  });
  it('checks execution identity, status, cleanup and the latest workspace revision', async () => {
    const state = prepareGoal(source(), 'test', autopilotLimitsSchema.parse({}));
    const id = crypto.randomUUID();
    const execution = {
      id,
      containerName: '',
      command: 'test',
      cwd: '.',
      status: 'completed' as const,
      startedAt: '',
      finishedAt: '',
      exitCode: 0,
      output: '',
      truncated: false,
      cleanupPending: false,
      verificationRevision: 0,
    };
    const input = JSON.stringify({ evidence: 'tests passed', executionIds: [id] });
    for (const executions of [
      [],
      [{ ...execution, exitCode: 1 }],
      [{ ...execution, cleanupPending: true }],
      [{ ...execution, verificationRevision: 1 }],
    ])
      await expect(
        completeGoal(state, input, { executions, signal: new AbortController().signal }),
      ).rejects.toMatchObject({ code: 'VERIFICATION_EXECUTION' });
    await expect(
      completeGoal(state, input, {
        executions: [{ ...execution, projectId: crypto.randomUUID() }],
        project: {
          id: crypto.randomUUID(),
          path: '/source',
          identity: '',
          name: 'source',
          createdAt: '',
        },
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: 'VERIFICATION_EXECUTION' });
    await completeGoal(state, input, {
      executions: [execution],
      signal: new AbortController().signal,
    });
    expect(state.evidence.at(-1)).toMatchObject({ source: 'command', executionIds: [id] });
  });
  it('validates real artifacts, rechecks earlier hashes and invalidates dependent checks after changes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lodex-verification-'));
    roots.push(root);
    const project = {
      ...(await inspectProject(root)),
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
    };
    await writeFile(join(root, 'result.txt'), 'verified 한글', 'utf8');
    const session = source();
    session.plan.verificationCommand = '';
    session.plan.verificationArtifacts = [{ path: 'result.txt', contains: '한글' }];
    for (const task of session.plan.tasks) {
      task.verificationCommand = '';
      task.verificationArtifacts = [{ path: 'result.txt' }];
    }
    const state = prepareAutopilot(session, [], autopilotLimitsSchema.parse({}));
    const base = { state, project, signal: new AbortController().signal };
    for (const task of session.plan.tasks)
      await verifyAutopilot({
        ...base,
        name: 'verify_task',
        argumentsJson: JSON.stringify({ taskId: task.id }),
      });
    expect(state.evidence[0]!.artifacts).toEqual([
      { path: 'result.txt', sha256: digest('verified 한글') },
    ]);
    await writeFile(join(root, 'result.txt'), 'changed 한글', 'utf8');
    await expect(
      verifyAutopilot({ ...base, name: 'verify_goal', argumentsJson: '{}' }),
    ).rejects.toMatchObject({ code: 'VERIFICATION_STALE' });
    expect(state.status).toBe('running');
    expect(state.completedTaskIds).toEqual([]);
    expect(state.workspaceRevision).toBe(1);
    invalidateVerification(state);
    expect(state.completedTaskIds).toEqual([]);
    expect(readyAutopilotTasks(state).map((task) => task.id)).toEqual([session.plan.tasks[0]!.id]);
  });
  it('cannot replace an unavailable saved command with a model explanation', async () => {
    const state = prepareAutopilot(source(), [], autopilotLimitsSchema.parse({}));
    await expect(
      verifyAutopilot({
        state,
        name: 'verify_task',
        argumentsJson: JSON.stringify({
          taskId: state.taskIds[0],
          evidence: 'The model says everything passed.',
        }),
        signal: new AbortController().signal,
        confirm: async () => true,
      }),
    ).rejects.toMatchObject({ code: 'VERIFICATION_UNAVAILABLE' });
    expect(state.completedTaskIds).toEqual([]);
  });
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
    expect(
      prepareAutopilot(
        { ...session, plan: { ...session.plan, verificationCommand: '' } },
        [],
        state.limits,
      ).taskIds,
    ).toEqual(session.plan.tasks.map((task) => task.id));
    expect(() =>
      prepareAutopilot(
        {
          ...session,
          plan: {
            ...session.plan,
            tasks: session.plan.tasks.map((task, index) =>
              index === 0 ? { ...task, criteria: '' } : task,
            ),
          },
        },
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
