import { access, lstat, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { posix, win32 } from 'node:path';
import { AppError } from '@lodex/contracts';

/** Search installation locations, never cwd, a relative PATH entry, or a repository shim. */
export function gitInstallationCandidates(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  if (platform === 'win32') {
    const roots = [env.ProgramW6432, env.ProgramFiles, env['ProgramFiles(x86)']].filter(
      (root): root is string => !!root && win32.isAbsolute(root),
    );
    const installations = roots.map((root) => win32.join(root, 'Git'));
    if (env.LOCALAPPDATA && win32.isAbsolute(env.LOCALAPPDATA))
      installations.push(win32.join(env.LOCALAPPDATA, 'Programs', 'Git'));
    return [...new Set(installations)].flatMap((root) =>
      ['cmd', 'bin'].map((folder) => win32.join(root, folder, 'git.exe')),
    );
  }
  return platform === 'darwin'
    ? ['/opt/homebrew/bin/git', '/usr/local/bin/git', '/usr/bin/git']
    : ['/usr/bin/git', '/bin/git', '/usr/local/bin/git'];
}

export async function resolveGitExecutable(
  cwd: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const paths = platform === 'win32' ? win32 : posix;
  const folder = await realpath(cwd);
  const contains = (file: string) => {
    const relative = paths.relative(folder, file);
    return (
      relative === '' ||
      (!paths.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + paths.sep))
    );
  };
  for (const candidate of gitInstallationCandidates(platform, env)) {
    if (contains(candidate)) continue;
    try {
      const executable = await realpath(candidate);
      // Homebrew/system symlinks are valid only when their target is outside the project.
      if (contains(executable) || !(await lstat(executable)).isFile()) continue;
      if (platform !== 'win32') await access(executable, constants.X_OK);
      return executable;
    } catch {
      // Try another known installation without executing discovery commands.
    }
  }
  throw new AppError(
    'WORKTREE_GIT_INSTALLATION',
    '표준 설치 위치에서 Git 실행 파일을 찾을 수 없습니다. Git을 설치하고 다시 시도하세요.',
  );
}

export function worktreeGitEnvironment(
  emptyConfigPath: string,
  extra: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP'])
    if (process.env[key]) env[key] = process.env[key];
  return {
    ...env,
    ...extra,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: emptyConfigPath,
    GIT_ATTR_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    // Missing promisor objects must fail locally. Older Git versions are also
    // protected by denying every transport, including file and external helpers.
    GIT_NO_LAZY_FETCH: '1',
    GIT_ALLOW_PROTOCOL: '',
    GIT_PROTOCOL_FROM_USER: '0',
  };
}

export function worktreeGitArguments(emptyConfigPath: string): string[] {
  return [
    '-c',
    'core.hooksPath=' + emptyConfigPath,
    '-c',
    'core.fsmonitor=false',
    '-c',
    'core.autocrlf=false',
    '-c',
    'core.symlinks=false',
    '-c',
    'core.sparseCheckout=false',
    '-c',
    'protocol.allow=never',
  ];
}
