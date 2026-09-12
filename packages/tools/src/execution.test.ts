import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { defaultExecutionConfig, type CommandExecution } from '@lodex/contracts';
import { inspectProject } from './index';
import {
  cleanupExecution,
  dockerEnvironment,
  executeCommand,
  inspectDocker,
  runCli,
  type DockerCli,
} from './execution';
const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    if (dirname(resolve(dir)) !== resolve(tmpdir())) throw new Error('Unsafe test directory');
    await rm(dir, { recursive: true, force: true });
  }
});

function fixture(exitCode = 0) {
  const calls: string[][] = [];
  let owner = '';
  const cli: DockerCli = async (args, signal, _input, progress) => {
    signal.throwIfAborted();
    calls.push(args);
    const reply = (output: string, code = 0) => ({ output, code, truncated: false });
    if (args[0] === 'context') return reply('unix:///var/run/docker.sock');
    if (args.includes('version')) return reply('linux');
    if (args.includes('image')) return reply('sha256:' + 'a'.repeat(64));
    if (args.includes('create')) {
      owner = args[args.indexOf('--label') + 1]!.split('=')[1]!;
      return reply('b'.repeat(64));
    }
    if (args.includes('start')) {
      progress?.('test output');
      return reply('test output');
    }
    if (args.includes('{{json .State}}'))
      return reply(JSON.stringify({ Status: 'exited', ExitCode: exitCode }));
    if (args.includes('inspect'))
      return reply(
        JSON.stringify({ Id: 'b'.repeat(64), Config: { Labels: { 'io.lodex.execution': owner } } }),
      );
    if (args.includes('rm')) return reply('removed');
    throw new Error('Unexpected command');
  };
  return { cli, calls };
}
async function project() {
  const dir = await mkdtemp(join(tmpdir(), 'lodex-command 한글-'));
  dirs.push(dir);
  return inspectProject(dir);
}
describe('owned Docker command execution', () => {
  it('uses a sanitized process environment and literal argv with bounded UTF-8 output', async () => {
    expect(
      dockerEnvironment({
        PATH: 'bin',
        OPENROUTER_API_KEY: 'secret',
        NODE_OPTIONS: '--require=attack',
        DOCKER_HOST: 'tcp://remote',
        HOME: '/home',
      }),
    ).toEqual({ PATH: 'bin', HOME: '/home' });
    const argument = '한글 ; $(echo nope) `test`';
    const result = await runCli(
      process.execPath,
      ['-e', 'process.stdout.write(process.argv[1]);', argument],
      AbortSignal.timeout(5000),
    );
    expect(result.output).toBe(argument);
    expect(result.code).toBe(0);
    const output = await runCli(
      process.execPath,
      ['-e', 'process.stdout.write("가".repeat(30000))'],
      AbortSignal.timeout(5000),
    );
    expect(output.truncated).toBe(true);
    expect(output.output.length).toBeLessThanOrEqual(24000);
    expect(output.output).not.toContain('�');
    const cancelled = await runCli(
      process.execPath,
      ['-e', 'setInterval(()=>{},1000)'],
      AbortSignal.timeout(100),
    );
    expect(cancelled.code).toBeNull();
  });
  it.each([0, 7])(
    'persists ownership before effects and uses actual container exit code %s',
    async (exitCode) => {
      const { cli, calls } = fixture(exitCode),
        records: CommandExecution[] = [];
      const result = await executeCommand({
        project: await project(),
        config: { ...defaultExecutionConfig(), backend: 'docker', projectAccess: true },
        argumentsJson: '{"command":"npm test"}',
        signal: AbortSignal.timeout(5000),
        cli,
        record: async (execution) => {
          if (!records.length) expect(calls).toHaveLength(0);
          records.push(structuredClone(execution));
        },
      });
      expect(result.status).toBe(exitCode === 0 ? 'completed' : 'failed');
      expect(result.exitCode).toBe(exitCode);
      expect(result.cleanupPending).toBe(false);
      expect(records.some((r) => r.cleanupPending && !r.containerId)).toBe(true);
      const args = calls.find((c) => c.includes('create'))!;
      expect(args).toContain('--read-only');
      expect(args).toContain('no-new-privileges');
      expect(args[args.indexOf('--network') + 1]).toBe('none');
      expect(args).toContain('--pull=never');
      expect(args).not.toContain('--privileged');
      expect(args.at(-1)).toBe('npm test');
      expect(calls.at(-1)).toContain('--volumes');
      expect(calls.at(-1)!.at(-1)).toBe('b'.repeat(64));
    },
  );
  it('cleans up after cancellation using the recorded ID, and reports cleanup failure', async () => {
    const fake = fixture(),
      controller = new AbortController();
    const cli: DockerCli = async (...args) => {
      if (args[0].includes('start')) {
        controller.abort();
        return { code: null, output: 'partial', truncated: false };
      }
      if (args[0].includes('rm')) return { code: 1, output: 'offline', truncated: false };
      return fake.cli(...args);
    };
    const result = await executeCommand({
      project: await project(),
      config: { ...defaultExecutionConfig(), backend: 'docker', projectAccess: true },
      argumentsJson: '{"command":"sleep 90"}',
      signal: controller.signal,
      cli,
      record: async () => {},
    });
    expect(result.status).toBe('interrupted');
    expect(result.cleanupPending).toBe(true);
    expect(result.exitCode).toBeNull();
  });
  it('reconciles a create that becomes visible after the cancelled CLI has exited', async () => {
    const fake = fixture(),
      controller = new AbortController(),
      records: CommandExecution[] = [];
    let inspections = 0;
    const cli: DockerCli = async (...args) => {
      if (args[0].includes('create')) {
        expect(records.at(-1)?.cleanupPending).toBe(true);
        await fake.cli(...args);
        controller.abort();
        return { code: null, output: '', truncated: false };
      }
      if (args[0].includes('{{json .}}') && inspections++ === 0)
        return { code: 1, output: 'not visible yet', truncated: false };
      if (args[0].includes('ls')) return { code: 0, output: '', truncated: false };
      return fake.cli(...args);
    };
    const result = await executeCommand({
      project: await project(),
      config: { ...defaultExecutionConfig(), backend: 'docker', projectAccess: true },
      argumentsJson: '{"command":"npm test"}',
      signal: controller.signal,
      cli,
      record: async (execution) => {
        records.push(structuredClone(execution));
      },
    });
    expect(inspections).toBe(2);
    expect(result.status).toBe('cancelled');
    expect(result.cleanupPending).toBe(false);
    expect(fake.calls.some((args) => args.includes('start'))).toBe(false);
    expect(fake.calls.at(-1)).toContain('rm');
    expect(fake.calls.at(-1)?.at(-1)).toBe('b'.repeat(64));
  });
  it.each([true, false])(
    'keeps an unacknowledged create pending across explicit cleanup retries (cancelled %s)',
    async (cancelled) => {
      const fake = fixture(),
        controller = new AbortController(),
        records: CommandExecution[] = [];
      let visible = false;
      const cli: DockerCli = async (...args) => {
        if (args[0].includes('create')) {
          await fake.cli(...args);
          if (cancelled) controller.abort();
          return {
            code: cancelled ? null : 1,
            output: 'connection closed before response',
            truncated: false,
          };
        }
        if (args[0].includes('{{json .}}') && !visible)
          return { code: 1, output: 'absent', truncated: false };
        if (args[0].includes('ls')) return { code: 0, output: '', truncated: false };
        return fake.cli(...args);
      };
      const result = await executeCommand({
        project: await project(),
        config: { ...defaultExecutionConfig(), backend: 'docker', projectAccess: true },
        argumentsJson: '{"command":"npm test"}',
        signal: controller.signal,
        cli,
        record: async (execution) => {
          records.push(structuredClone(execution));
        },
      });
      expect(result.status).toBe('interrupted');
      expect(result.cleanupPending).toBe(true);
      expect(records.at(-1)?.cleanupPending).toBe(true);
      expect(await cleanupExecution(result, cli)).toBe(false);
      expect(fake.calls.some((args) => args.includes('rm') || args.includes('start'))).toBe(false);
      visible = true;
      expect(await cleanupExecution(result, cli)).toBe(true);
      expect(fake.calls.at(-1)).toContain('rm');
    },
  );
  it('preserves an acknowledged ID when cancellation wins the CLI exit status', async () => {
    const fake = fixture(),
      controller = new AbortController(),
      records: CommandExecution[] = [];
    const cli: DockerCli = async (...args) => {
      if (args[0].includes('create')) {
        const created = await fake.cli(...args);
        controller.abort();
        return { ...created, code: null };
      }
      if (args[0].includes('{{json .}}')) {
        expect(args[0].at(-1)).toBe('b'.repeat(64));
        expect(records.at(-1)?.containerId).toBe('b'.repeat(64));
        return { code: 1, output: 'already removed', truncated: false };
      }
      if (args[0].includes('ls')) return { code: 0, output: '', truncated: false };
      return fake.cli(...args);
    };
    const result = await executeCommand({
      project: await project(),
      config: { ...defaultExecutionConfig(), backend: 'docker', projectAccess: true },
      argumentsJson: '{"command":"npm test"}',
      signal: controller.signal,
      cli,
      record: async (execution) => {
        records.push(structuredClone(execution));
      },
    });
    expect(result.containerId).toBe('b'.repeat(64));
    expect(result.status).toBe('cancelled');
    expect(result.cleanupPending).toBe(false);
    expect(fake.calls.some((args) => args.includes('start'))).toBe(false);
  });
  it('does not leave an uncertain container when cancelled before create is called', async () => {
    const fake = fixture(),
      controller = new AbortController();
    const result = await executeCommand({
      project: await project(),
      config: { ...defaultExecutionConfig(), backend: 'docker', projectAccess: true },
      argumentsJson: '{"command":"npm test"}',
      signal: controller.signal,
      cli: fake.cli,
      record: async (execution) => {
        if (execution.cleanupPending) controller.abort();
      },
    });
    expect(result.status).toBe('cancelled');
    expect(result.cleanupPending).toBe(false);
    expect(fake.calls.some((args) => args.includes('create') || args.includes('{{json .}}'))).toBe(
      false,
    );
  });
  it('never falls back to a host shell, remote daemon or unowned container', async () => {
    let calls = 0;
    const remote: DockerCli = async () => {
      calls++;
      return { code: 0, output: 'tcp://example.com:2375', truncated: false };
    };
    await expect(inspectDocker('node:24', remote)).rejects.toMatchObject({
      code: 'DOCKER_LOCAL_REQUIRED',
    });
    expect(calls).toBe(1);
    const fake = fixture();
    const execution: CommandExecution = {
      id: crypto.randomUUID(),
      containerName: '',
      dockerHost: 'unix:///var/run/docker.sock',
      command: '',
      cwd: '.',
      status: 'interrupted',
      startedAt: '',
      exitCode: null,
      output: '',
      truncated: false,
      cleanupPending: true,
    };
    execution.containerName = 'lodex-' + execution.id;
    expect(await cleanupExecution(execution, fake.cli)).toBe(false);
    expect(fake.calls.some((c) => c.includes('rm'))).toBe(false);
    await expect(
      executeCommand({
        project: await project(),
        config: defaultExecutionConfig(),
        argumentsJson: '{}',
        signal: AbortSignal.timeout(5000),
        record: async () => {},
        cli: fake.cli,
      }),
    ).rejects.toMatchObject({ code: 'EXECUTION_DISABLED' });
  });
});
