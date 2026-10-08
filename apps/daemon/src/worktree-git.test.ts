import { beforeEach, describe, expect, it, vi } from 'vitest';
import { access, lstat, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import {
  gitInstallationCandidates,
  resolveGitExecutable,
  worktreeGitArguments,
  worktreeGitEnvironment,
} from './worktree-git';

vi.mock('node:fs/promises', () => ({ access: vi.fn(), lstat: vi.fn(), realpath: vi.fn() }));
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(realpath).mockImplementation(async (path) => String(path));
  vi.mocked(lstat).mockResolvedValue({ isFile: () => true } as Awaited<ReturnType<typeof lstat>>);
  vi.mocked(access).mockResolvedValue(undefined);
});

describe('trusted Git resolution and offline execution policy', () => {
  it('ignores PATH, empty entries, relative entries and repository binaries on Windows', async () => {
    const env = { ProgramFiles: 'C:\\Program Files', Path: '.;C:\\repo;relative;' };
    expect(gitInstallationCandidates('win32', env)).toEqual([
      'C:\\Program Files\\Git\\cmd\\git.exe',
      'C:\\Program Files\\Git\\bin\\git.exe',
    ]);
    expect(await resolveGitExecutable('C:\\repo', 'win32', env)).toBe(
      'C:\\Program Files\\Git\\cmd\\git.exe',
    );
    expect(vi.mocked(realpath).mock.calls.flat()).not.toContain('C:\\repo\\git.exe');
    expect(vi.mocked(access)).not.toHaveBeenCalled();
  });
  it('resolves installed Linux and macOS Git and checks Unix executable permissions', async () => {
    expect(await resolveGitExecutable('/project', 'linux', { PATH: '.:/project' })).toBe(
      '/usr/bin/git',
    );
    expect(await resolveGitExecutable('/project', 'darwin', { PATH: '.:/project' })).toBe(
      '/opt/homebrew/bin/git',
    );
    expect(access).toHaveBeenCalledWith('/usr/bin/git', constants.X_OK);
    expect(access).toHaveBeenCalledWith('/opt/homebrew/bin/git', constants.X_OK);
  });
  it('rejects installed paths or symlink targets inside the project instead of falling back to PATH', async () => {
    vi.mocked(realpath).mockImplementation(async (path) =>
      String(path) === '/project' ? '/project' : '/project/git',
    );
    await expect(
      resolveGitExecutable('/project', 'linux', { PATH: '/attacker' }),
    ).rejects.toMatchObject({ code: 'WORKTREE_GIT_INSTALLATION' });
    expect(lstat).not.toHaveBeenCalled();
    expect(vi.mocked(realpath).mock.calls.flat()).not.toContain('/attacker/git');
    vi.mocked(realpath).mockImplementation(async (path) => String(path));
    await expect(
      resolveGitExecutable('C:\\Program Files', 'win32', { ProgramFiles: 'C:\\Program Files' }),
    ).rejects.toMatchObject({ code: 'WORKTREE_GIT_INSTALLATION' });
  });
  it('enforces no lazy fetch and no transports even when additional environment asks for them', () => {
    const env = worktreeGitEnvironment('/private/empty', {
      GIT_INDEX_FILE: '/private/index',
      GIT_NO_LAZY_FETCH: '0',
      GIT_ALLOW_PROTOCOL: 'https:file:ext',
      GIT_CONFIG_GLOBAL: '/project/config',
      GIT_TERMINAL_PROMPT: '1',
    });
    expect(env).toMatchObject({
      GIT_INDEX_FILE: '/private/index',
      GIT_NO_LAZY_FETCH: '1',
      GIT_ALLOW_PROTOCOL: '',
      GIT_CONFIG_GLOBAL: '/private/empty',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
      GIT_PROTOCOL_FROM_USER: '0',
    });
    expect(worktreeGitArguments('/private/empty')).toEqual(
      expect.arrayContaining([
        'protocol.allow=never',
        'core.hooksPath=/private/empty',
        'core.fsmonitor=false',
      ]),
    );
  });
});
