import { spawn } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { isAbsolute, relative, resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { setTimeout as delay } from 'node:timers/promises';
import {
  AppError,
  executionConfigSchema,
  runCommandSchema,
  type CommandExecution,
  type ExecutionConfig,
  type Project,
  type ToolDefinition,
} from '@lodex/contracts';
import { z } from 'zod';
import { resolveTarget } from './index';

export const executionTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'run_command',
    description:
      'Execute a shell command in the user-enabled Linux Docker container with the selected project mounted at /workspace. cwd is project-relative. Receives bounded output and an exit code; nonzero means failure. Files in the mounted project can be changed by commands. The image, network and resource limits are fixed by the user. stdin is written once then closed. No interactive terminal or background services. Never assume a proposed edit has been applied; inspect current files before testing.',
    parameters: z.toJSONSchema(runCommandSchema),
  },
};
export const hostExecutionTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'run_host_command',
    description:
      'FULL ACCESS ONLY. Execute a command directly on the user host with the user account, inherited environment, unrestricted filesystem and network. Windows uses PowerShell; macOS and Linux use /bin/sh. cwd may be project-relative or absolute. Output and duration remain bounded and cancellation terminates the owned process tree.',
    parameters: z.toJSONSchema(runCommandSchema),
  },
};

// Only local CLI discovery/configuration variables; model/API secrets never enter the child.
export function dockerEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const allowed = new Set([
    'path',
    'pathext',
    'systemroot',
    'windir',
    'home',
    'userprofile',
    'localappdata',
    'appdata',
    'temp',
    'tmp',
    'tmpdir',
    'xdg_runtime_dir',
  ]);
  return Object.fromEntries(
    Object.entries(source).filter(([key]) => allowed.has(key.toLowerCase())),
  );
}
export interface CliResult {
  code: number | null;
  output: string;
  truncated: boolean;
}
export type DockerCli = (
  args: string[],
  signal: AbortSignal,
  input?: string,
  progress?: (output: string) => void,
) => Promise<CliResult>;

export function runCli(
  executable: string,
  args: string[],
  signal: AbortSignal,
  input = '',
  progress?: (output: string) => void,
): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const child = spawn(executable, args, {
      windowsHide: true,
      shell: false,
      env: dockerEnvironment(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '',
      total = 0,
      truncated = false,
      settled = false;
    const decoders = [new StringDecoder('utf8'), new StringDecoder('utf8')];
    const append = (text: string) => {
      total += Buffer.byteLength(text);
      output += text;
      if (output.length > 24000) {
        output = output.slice(0, 8000) + '\n[output truncated]\n' + output.slice(-15000);
        truncated = true;
      }
      progress?.(output);
      if (total > 1048576) {
        truncated = true;
        child.kill();
      }
    };
    child.stdout.on('data', (chunk: Buffer) => append(decoders[0]!.write(chunk)));
    child.stderr.on('data', (chunk: Buffer) => append(decoders[1]!.write(chunk)));
    child.stdin.on('error', () => {
      /* Command may close stdin before reading. */
    });
    const abort = () => child.kill();
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    child.on('error', () => {
      settled = true;
      signal.removeEventListener('abort', abort);
      reject(
        new AppError(
          'DOCKER_UNAVAILABLE',
          'Docker CLI를 실행할 수 없습니다. 설치와 PATH를 확인하세요.',
        ),
      );
    });
    child.on('close', (code) => {
      signal.removeEventListener('abort', abort);
      if (settled) return;
      append(decoders[0]!.end() + decoders[1]!.end());
      resolve({ code: signal.aborted || total > 1048576 ? null : code, output, truncated });
    });
    child.stdin.end(input);
  });
}
export const dockerCli: DockerCli = (...args) => runCli('docker', ...args);

export type HostCommandRunner = (
  command: string,
  cwd: string,
  signal: AbortSignal,
  input?: string,
  progress?: (output: string) => void,
) => Promise<CliResult>;

export const hostCommandRunner: HostCommandRunner = (command, cwd, signal, input = '', progress) =>
  new Promise((resolveResult, reject) => {
    signal.throwIfAborted();
    const windows = process.platform === 'win32';
    const child = spawn(
      windows ? 'powershell.exe' : '/bin/sh',
      windows
        ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command]
        : ['-lc', command],
      {
        cwd,
        windowsHide: true,
        detached: !windows,
        env: process.env,
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    let output = '',
      total = 0,
      truncated = false,
      settled = false;
    let forceKill: NodeJS.Timeout | undefined;
    const decoders = [new StringDecoder('utf8'), new StringDecoder('utf8')];
    const terminate = () => {
      if (!child.pid) return;
      if (windows)
        spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], {
          windowsHide: true,
          stdio: 'ignore',
        }).unref();
      else {
        try {
          process.kill(-child.pid, 'SIGTERM');
          forceKill ??= setTimeout(() => {
            try {
              process.kill(-child.pid!, 'SIGKILL');
            } catch {
              /* The process group already exited. */
            }
          }, 1000);
          forceKill.unref();
        } catch {
          child.kill();
        }
      }
    };
    const append = (text: string) => {
      total += Buffer.byteLength(text);
      output += text;
      if (output.length > 24000) {
        output = output.slice(0, 8000) + '\n[output truncated]\n' + output.slice(-15000);
        truncated = true;
      }
      progress?.(output);
      if (total > 1048576) terminate();
    };
    const abort = () => terminate();
    signal.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', (chunk: Buffer) => append(decoders[0]!.write(chunk)));
    child.stderr.on('data', (chunk: Buffer) => append(decoders[1]!.write(chunk)));
    child.stdin.on('error', () => undefined);
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(forceKill);
      signal.removeEventListener('abort', abort);
      reject(error);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(forceKill);
      signal.removeEventListener('abort', abort);
      append(decoders[0]!.end() + decoders[1]!.end());
      resolveResult({
        code: signal.aborted || total > 1048576 ? null : code,
        output,
        truncated: truncated || total > 1048576,
      });
    });
    child.stdin.end(input);
    if (signal.aborted) terminate();
  });

function localDockerHost(host: string): boolean {
  return (
    /^unix:\/\/\/[^\r\n\0]+$/.test(host) || /^npipe:\/\/\/\/\.\/pipe\/[a-zA-Z0-9_.-]+$/.test(host)
  );
}
export async function inspectDocker(
  image: string,
  cli: DockerCli = dockerCli,
  parent?: AbortSignal,
) {
  const signal = AbortSignal.any([AbortSignal.timeout(15000), ...(parent ? [parent] : [])]);
  const context = await cli(
    ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'],
    signal,
  );
  const host = context.output.trim();
  if (context.code !== 0 || !localDockerHost(host))
    throw new AppError(
      'DOCKER_LOCAL_REQUIRED',
      '로컬 Unix socket 또는 named pipe의 Docker context가 필요합니다. 원격 Docker는 지원하지 않습니다.',
    );
  const version = await cli(['--host', host, 'version', '--format', '{{.Server.Os}}'], signal);
  if (version.code !== 0 || version.output.trim() !== 'linux')
    throw new AppError(
      'DOCKER_UNAVAILABLE',
      'Linux 컨테이너용 Docker 엔진을 실행하세요. 호스트 실행으로 대체하지 않았습니다.',
    );
  const result = await cli(
    ['--host', host, 'image', 'inspect', '--format', '{{.Id}}', image],
    signal,
  );
  if (result.code !== 0 || !/^sha256:[a-f0-9]{64}$/.test(result.output.trim()))
    throw new AppError(
      'DOCKER_IMAGE',
      '선택한 이미지가 로컬에 없습니다. 필요한 개발 도구와 /bin/sh가 포함된 이미지를 먼저 준비하세요. 자동 다운로드하지 않습니다.',
    );
  return { host, imageId: result.output.trim() };
}

export function containerArguments(
  projectPath: string,
  config: ExecutionConfig,
  execution: CommandExecution,
  input: z.infer<typeof runCommandSchema>,
) {
  if (/[\r\n\0,"]/.test(projectPath))
    throw new AppError(
      'MOUNT_PATH',
      '컨테이너 프로젝트 경로에 쉼표·따옴표·제어 문자를 사용할 수 없습니다.',
    );
  return [
    '--host',
    execution.dockerHost!,
    'create',
    '--name',
    execution.containerName,
    '--label',
    'io.lodex.execution=' + execution.id,
    '--pull=never',
    '--init',
    '--interactive',
    '--network',
    config.network,
    '--cpus',
    String(config.cpus),
    '--memory',
    config.memoryMb + 'm',
    '--memory-swap',
    config.memoryMb + 'm',
    '--pids-limit',
    '128',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--read-only',
    '--tmpfs',
    '/tmp:rw,nosuid,nodev,size=256m',
    '--no-healthcheck',
    '--log-driver',
    'local',
    '--log-opt',
    'max-size=2m',
    '--log-opt',
    'max-file=1',
    '--user',
    process.platform === 'linux' && process.getuid
      ? `${process.getuid()}:${process.getgid!()}`
      : '1000:1000',
    '--env',
    'HOME=/tmp',
    '--mount',
    'type=bind,source=' + projectPath + ',target=/workspace',
    '--workdir',
    '/workspace' + (execution.cwd === '.' ? '' : '/' + execution.cwd),
    '--entrypoint',
    '/bin/sh',
    execution.imageId!,
    '-c',
    input.command,
  ];
}

/** Cleanup only the recorded, labelled container. Never kill a host PID or bulk-remove containers. */
export async function cleanupExecution(
  execution: CommandExecution,
  cli: DockerCli = dockerCli,
): Promise<boolean> {
  if (!execution.dockerHost) return true; // No creation could have started yet.
  if (
    !localDockerHost(execution.dockerHost) ||
    execution.containerName !== 'lodex-' + execution.id ||
    !z.uuid().safeParse(execution.id).success
  )
    return false;
  const signal = AbortSignal.timeout(15000);
  try {
    // A cancelled CLI does not acknowledge the daemon's create outcome. Give a late
    // owned container a bounded chance to appear; absence alone cannot settle it.
    for (let attempt = 0; attempt < 3; attempt++) {
      const inspected = await cli(
        [
          '--host',
          execution.dockerHost,
          'container',
          'inspect',
          '--format',
          '{{json .}}',
          execution.containerId ?? execution.containerName,
        ],
        signal,
      );
      if (inspected.code !== 0) {
        // A successful empty listing distinguishes absence from an unavailable
        // engine, but is conclusive only after a create response supplied the ID.
        const list = await cli(
          [
            '--host',
            execution.dockerHost,
            'container',
            'ls',
            '-aq',
            '--filter',
            'name=^/' + execution.containerName + '$',
          ],
          signal,
        );
        if (list.code !== 0) return false;
        if (list.output.trim() === '' && execution.containerId) return true;
        if (attempt < 2) await delay(250, undefined, { signal });
        continue;
      }
      const container = JSON.parse(inspected.output) as {
        Id?: string;
        Config?: { Labels?: Record<string, string> };
      };
      if (
        !container.Id ||
        !/^[a-f0-9]{64}$/.test(container.Id) ||
        container.Config?.Labels?.['io.lodex.execution'] !== execution.id
      )
        return false;
      if (execution.containerId && execution.containerId !== container.Id) return false;
      const result = await cli(
        ['--host', execution.dockerHost, 'container', 'rm', '--force', '--volumes', container.Id],
        signal,
      );
      return result.code === 0;
    }
    return false;
  } catch {
    return false;
  }
}

export async function executeCommand(options: {
  project: Project;
  config: ExecutionConfig;
  argumentsJson: string;
  signal: AbortSignal;
  record: (execution: CommandExecution) => Promise<void>;
  cli?: DockerCli;
}): Promise<CommandExecution> {
  const { project, signal: parent, record, cli = dockerCli } = options;
  const config = executionConfigSchema.parse(options.config);
  if (config.backend !== 'docker')
    throw new AppError('EXECUTION_DISABLED', '명령 실행이 꺼져 있습니다.', 403);
  const input = runCommandSchema.parse(JSON.parse(options.argumentsJson));
  const root = await resolveTarget(project, '.');
  const cwd = await resolveTarget(project, input.cwd);
  if (!cwd.info.isDirectory())
    throw new AppError('COMMAND_CWD', '명령의 작업 경로는 폴더여야 합니다.');
  const id = randomUUID();
  const execution: CommandExecution = {
    id,
    environment: 'docker',
    containerName: 'lodex-' + id,
    command: input.command,
    cwd: relative(root.path, cwd.path).replaceAll('\\', '/') || '.',
    status: 'starting',
    startedAt: new Date().toISOString(),
    exitCode: null,
    output: '',
    truncated: false,
    cleanupPending: false,
  };
  await record(execution);
  let pending: Promise<void> = Promise.resolve(),
    lastSave = 0;
  let creationAttempted = false;
  const signal = AbortSignal.any([parent, AbortSignal.timeout(input.timeoutMs)]);
  try {
    signal.throwIfAborted();
    const runtime = await inspectDocker(config.image, cli, signal);
    signal.throwIfAborted();
    execution.dockerHost = runtime.host;
    execution.imageId = runtime.imageId;
    const args = containerArguments(root.path, config, execution, input);
    execution.cleanupPending = true;
    await record(execution); // Persist ownership before docker create, including the crash-before-ID window.
    signal.throwIfAborted();
    creationAttempted = true;
    const created = await cli(args, signal);
    // Cancellation can win after the daemon's complete response reached stdout.
    // Retain that acknowledged ID even when the CLI exit code was cancelled.
    if (/^[a-f0-9]{64}$/.test(created.output.trim())) execution.containerId = created.output.trim();
    if (created.code !== 0 || !execution.containerId) {
      if (execution.containerId) await record(execution);
      throw new AppError(
        'CONTAINER_CREATE',
        '컨테이너를 만들지 못했습니다. 이미지·폴더 공유·자원 설정을 확인하세요.',
      );
    }
    execution.status = 'running';
    await record(execution);
    signal.throwIfAborted();
    const result = await cli(
      ['--host', runtime.host, 'start', '--attach', '--interactive', execution.containerId],
      signal,
      input.stdin,
      (output) => {
        execution.output = output;
        if (performance.now() - lastSave > 250) {
          lastSave = performance.now();
          const copy = structuredClone(execution);
          pending = pending.then(() => record(copy));
          // The awaited chain below handles persistence failure; stop further effects promptly.
          void pending.catch(() => undefined);
        }
      },
    );
    execution.output = result.output;
    execution.truncated = result.truncated;
    execution.exitCode = result.code;
    if (!signal.aborted && result.code !== null) {
      const stateResult = await cli(
        [
          '--host',
          runtime.host,
          'container',
          'inspect',
          '--format',
          '{{json .State}}',
          execution.containerId,
        ],
        signal,
      );
      if (stateResult.code !== 0)
        throw new AppError('COMMAND_OUTCOME', '컨테이너의 종료 코드를 확인하지 못했습니다.');
      const state = JSON.parse(stateResult.output) as {
        Status?: string;
        ExitCode?: number;
        OOMKilled?: boolean;
      };
      if (state.Status !== 'exited' || !Number.isInteger(state.ExitCode))
        throw new AppError('COMMAND_OUTCOME', '컨테이너 종료가 확인되지 않았습니다.');
      execution.exitCode = state.ExitCode!;
      if (state.OOMKilled) execution.error = '컨테이너 메모리 한도를 초과했습니다.';
    }
    execution.status = signal.aborted
      ? parent.aborted
        ? 'cancelled'
        : 'failed'
      : execution.exitCode === 0
        ? 'completed'
        : 'failed';
    if (signal.aborted)
      execution.error = parent.aborted
        ? '사용자가 명령을 중지했습니다.'
        : '명령 실행 시간이 초과되었습니다.';
    else if (result.code === null)
      execution.error = '출력 한도를 초과했거나 실행 결과가 확인되지 않았습니다.';
  } catch (error) {
    execution.status = parent.aborted ? 'cancelled' : 'failed';
    execution.error = signal.aborted
      ? parent.aborted
        ? '사용자가 명령을 중지했습니다.'
        : '명령 실행 시간이 초과되었습니다.'
      : error instanceof AppError
        ? error.message
        : '명령 실행이 중단되었습니다. 실행 결과를 확인하세요.';
  } finally {
    execution.cleanupPending = creationAttempted && !(await cleanupExecution(execution, cli));
    if (execution.cleanupPending) {
      execution.status = 'interrupted';
      execution.error = execution.containerId
        ? '컨테이너 종료를 확인하지 못했습니다. Docker를 실행한 뒤 정리해야 합니다.'
        : '컨테이너 생성 결과가 확인되지 않았습니다. Docker가 응답하면 정리를 다시 시도하세요. 목록에 없다는 이유만으로 정리가 완료되지는 않습니다.';
    }
    execution.finishedAt = new Date().toISOString();
    await pending;
    await record(execution);
  }
  return execution;
}

export async function executeHostCommand(options: {
  project: Project;
  argumentsJson: string;
  signal: AbortSignal;
  record: (execution: CommandExecution) => Promise<void>;
  runner?: HostCommandRunner;
}): Promise<CommandExecution> {
  const { project, signal: parent, record, runner = hostCommandRunner } = options;
  const input = runCommandSchema.parse(JSON.parse(options.argumentsJson));
  const requestedCwd = isAbsolute(input.cwd) ? input.cwd : resolve(project.path, input.cwd);
  const cwd = await realpath(requestedCwd);
  if (!(await lstat(cwd)).isDirectory())
    throw new AppError('COMMAND_CWD', '명령의 작업 경로는 폴더여야 합니다.');
  const id = randomUUID();
  const execution: CommandExecution = {
    id,
    containerName: 'host-' + id,
    environment: 'host',
    command: input.command,
    cwd,
    status: 'starting',
    startedAt: new Date().toISOString(),
    exitCode: null,
    output: '',
    truncated: false,
    cleanupPending: false,
  };
  await record(execution);
  const signal = AbortSignal.any([parent, AbortSignal.timeout(input.timeoutMs)]);
  let pending: Promise<void> = Promise.resolve(),
    lastSave = 0;
  try {
    execution.status = 'running';
    await record(execution);
    const result = await runner(input.command, cwd, signal, input.stdin, (output) => {
      execution.output = output;
      if (performance.now() - lastSave > 250) {
        lastSave = performance.now();
        const copy = structuredClone(execution);
        pending = pending.then(() => record(copy));
        void pending.catch(() => undefined);
      }
    });
    execution.output = result.output;
    execution.truncated = result.truncated;
    execution.exitCode = result.code;
    execution.status = signal.aborted
      ? parent.aborted
        ? 'cancelled'
        : 'failed'
      : result.code === 0
        ? 'completed'
        : 'failed';
    if (signal.aborted)
      execution.error = parent.aborted
        ? '사용자가 명령을 중지했습니다.'
        : '명령 실행 시간이 초과되었습니다.';
    else if (result.code === null)
      execution.error = '출력 한도를 초과했거나 실행 결과를 확인하지 못했습니다.';
  } catch (error) {
    execution.status = parent.aborted ? 'cancelled' : 'failed';
    execution.error = signal.aborted
      ? parent.aborted
        ? '사용자가 명령을 중지했습니다.'
        : '명령 실행 시간이 초과되었습니다.'
      : error instanceof AppError
        ? error.message
        : '호스트 명령 실행이 중단되었습니다. 결과를 확인하세요.';
  } finally {
    execution.finishedAt = new Date().toISOString();
    await pending;
    await record(execution);
  }
  return execution;
}
