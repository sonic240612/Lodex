import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { mkdir, realpath, lstat, open } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { AppError, type Project, type WorktreeRecord } from '@lodex/contracts';
import { inspectProject, resolveTarget } from '@lodex/tools';
import type { Store } from '@lodex/storage';

const run = promisify(execFile);
export class Worktrees {
  private records: WorktreeRecord[] = [];
  private version = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private constructor(
    private store: Store,
    private root: string,
  ) {}
  static async open(store: Store, root: string) {
    const requested = resolve(root);
    await mkdir(requested, { recursive: true, mode: 0o700 });
    if ((await lstat(requested)).isSymbolicLink())
      throw new AppError('WORKTREE_PATH', 'worktree 저장 폴더는 링크일 수 없습니다.');
    // Canonicalize platform parent aliases (for example macOS /var -> /private/var).
    const manager = new Worktrees(store, await realpath(requested));
    const saved = await store.integration('worktrees');
    if (saved) {
      manager.version = saved.version;
      manager.records = saved.document as WorktreeRecord[];
    }
    if (!Array.isArray(manager.records))
      throw new AppError('WORKTREE_STATE', 'worktree 기록 형식이 올바르지 않습니다.');
    let changed = false;
    for (const record of manager.records)
      if (record.status === 'creating') {
        record.status = 'interrupted';
        record.error = '생성 중 앱이 종료되었습니다. 자동 삭제·재실행하지 않았습니다.';
        changed = true;
      }
    if (changed) await manager.save();
    return manager;
  }
  list() {
    return structuredClone(this.records);
  }
  private async save() {
    this.version = await this.store.saveIntegration('worktrees', this.version, this.records);
  }
  private async git(cwd: string, args: string[], signal: AbortSignal, filters: string[] = []) {
    const env: NodeJS.ProcessEnv = {
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
      GIT_OPTIONAL_LOCKS: '0',
    };
    for (const key of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP'])
      if (process.env[key]) env[key] = process.env[key];
    try {
      return (
        await run(
          'git',
          [
            '-c',
            'core.hooksPath=' + join(this.root, 'disabled-hooks'),
            '-c',
            'core.fsmonitor=false',
            '-c',
            'core.autocrlf=false',
            '-c',
            'core.symlinks=false',
            '-c',
            'core.sparseCheckout=false',
            ...filters,
            ...args,
          ],
          { cwd, env, signal, timeout: 60000, maxBuffer: 1048576, windowsHide: true },
        )
      ).stdout;
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      // Config probes return 1 when no matching settings exist.
      if (args[0] === 'config' && (error as { code?: number }).code === 1) return '';
      throw new AppError(
        'WORKTREE_GIT',
        'Git 작업에 실패했습니다. 저장소·Git 설치·경로·잠금 상태를 확인하세요. 생성 중인 폴더는 자동 삭제하지 않았습니다.',
      );
    }
  }
  create(
    source: Project,
    signal: AbortSignal,
  ): Promise<{ record: WorktreeRecord; project: Project }> {
    const work = this.queue.then(async () => {
      signal.throwIfAborted();
      if (this.records.length >= 50)
        throw new AppError('WORKTREE_LIMIT', '관리 worktree 50개 한도입니다.');
      await resolveTarget(source, '.');
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      if ((await realpath(this.root)) !== this.root || (await lstat(this.root)).isSymbolicLink())
        throw new AppError('WORKTREE_PATH', 'worktree 저장 폴더가 이동되거나 링크로 바뀌었습니다.');
      const hooks = join(this.root, 'disabled-hooks');
      try {
        await (await open(hooks, 'wx', 0o600)).close();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      const hookInfo = await lstat(hooks);
      if (!hookInfo.isFile() || hookInfo.isSymbolicLink())
        throw new AppError('WORKTREE_HOOKS', 'Git 훅 비활성 경로가 변경되었습니다.');
      const top = (await this.git(source.path, ['rev-parse', '--show-toplevel'], signal)).trim();
      if ((await realpath(top)) !== source.path)
        throw new AppError('WORKTREE_ROOT', 'Git 저장소의 최상위 폴더를 프로젝트로 연결하세요.');
      const baseCommit = (
        await this.git(source.path, ['rev-parse', '--verify', 'HEAD^{commit}'], signal)
      ).trim();
      if (!/^[0-9a-f]{40,64}$/.test(baseCommit))
        throw new AppError('WORKTREE_HEAD', '커밋이 있는 Git 저장소가 필요합니다.');
      const filterKeys = (
        await this.git(source.path, ['config', '--name-only', '--get-regexp', '^filter[.]'], signal)
      )
        .trim()
        .split(/\r?\n/)
        .filter(Boolean);
      const filters: string[] = [];
      for (const prefix of new Set(filterKeys.map((key) => key.slice(0, key.lastIndexOf('.'))))) {
        if (!/^filter\.[A-Za-z0-9_.-]+$/.test(prefix))
          throw new AppError('WORKTREE_FILTER', '이 저장소의 Git 필터 이름은 지원하지 않습니다.');
        for (const field of ['clean', 'smudge', 'process'])
          filters.push('-c', prefix + '.' + field + '=');
        filters.push('-c', prefix + '.required=false');
      }
      const id = randomUUID(),
        path = join(this.root, id),
        branch = 'lodex/work-' + id;
      const record: WorktreeRecord = {
        id,
        sourceProjectId: source.id,
        baseCommit,
        branch,
        path,
        createdAt: new Date().toISOString(),
        status: 'creating',
      };
      this.records.push(record);
      await this.save();
      try {
        await this.git(
          source.path,
          ['worktree', 'add', '--no-checkout', '-b', branch, path, baseCommit],
          signal,
          filters,
        );
        await this.git(path, ['checkout', '--force', 'HEAD', '--', '.'], signal, filters);
        signal.throwIfAborted();
        const project = await this.store.registerProject({
          ...(await inspectProject(path)),
          name: source.name + ' · ' + id.slice(0, 8),
        });
        record.projectId = project.id;
        record.status = 'ready';
        await this.save();
        return { record: structuredClone(record), project };
      } catch (error) {
        record.status = 'interrupted';
        record.error =
          error instanceof AppError ? error.message : '생성이 중단되었습니다. 경로를 확인하세요.';
        await this.save();
        throw error;
      }
    });
    this.queue = work.catch(() => undefined);
    return work;
  }
  async close() {
    await this.queue;
  }
}
