import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, realpath, lstat, open, readFile, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { AppError, type Project, type WorktreeRecord } from '@lodex/contracts';
import { inspectProject, resolveTarget } from '@lodex/tools';
import type { Store } from '@lodex/storage';
import { byteHash, readWorktreeFile, MAX_WORKTREE_BYTES } from './worktree-files';

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
      if (record.merge?.status === 'applying') {
        record.merge.status = 'interrupted';
        changed = true;
      }
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
  readGit(cwd: string, args: string[], signal: AbortSignal) {
    return this.git(cwd, args, signal);
  }
  async readBlob(cwd: string, object: string, signal: AbortSignal) {
    const size = Number((await this.git(cwd, ['cat-file', '-s', object], signal)).trim());
    if (!Number.isSafeInteger(size) || size > MAX_WORKTREE_BYTES)
      throw new AppError('WORKTREE_FILE', 'Git 파일이 16 MiB를 초과합니다.');
    return Buffer.from(
      await this.git(cwd, ['cat-file', 'blob', object], signal, [], {}, 'latin1'),
      'latin1',
    );
  }
  private async checkedRoot() {
    if ((await realpath(this.root)) !== this.root || (await lstat(this.root)).isSymbolicLink())
      throw new AppError('WORKTREE_PATH', '관리 Worktree 폴더가 이동되거나 링크로 바뀌었습니다.');
    return this.root;
  }
  async verifyOwnership(record: WorktreeRecord, signal: AbortSignal) {
    await this.checkedRoot();
    if (
      !/^[0-9a-f-]{36}$/.test(record.id) ||
      record.path !== join(this.root, record.id) ||
      !record.projectId
    )
      throw new AppError('WORKTREE_PATH', '등록된 관리 Worktree 경로가 아닙니다.');
    const source = await this.store.project(record.sourceProjectId),
      child = await this.store.project(record.projectId);
    await resolveTarget(source, '.');
    await resolveTarget(child, '.');
    if (
      child.path !== record.path ||
      child.path === source.path ||
      child.id === source.id ||
      record.branch !== 'lodex/work-' + record.id ||
      (record.ownership && child.identity !== record.ownership.projectIdentity)
    )
      throw new AppError('WORKTREE_OWNERSHIP', 'Worktree 소유권을 확인할 수 없습니다.');
    const gitPath = join(child.path, '.git'),
      info = await lstat(gitPath);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 4096)
      throw new AppError('WORKTREE_OWNERSHIP', 'Worktree Git 연결이 변경되었습니다.');
    const gitFileHash = createHash('sha256')
      .update(await readFile(gitPath))
      .digest('hex');
    if (record.ownership && gitFileHash !== record.ownership.gitFileHash)
      throw new AppError('WORKTREE_OWNERSHIP', 'Worktree Git 연결이 변경되었습니다.');
    const exactProject = await lstat(child.path, { bigint: true }),
      exactGit = await lstat(gitPath, { bigint: true });
    const projectExactIdentity = exactProject.dev + ':' + exactProject.ino,
      gitFileIdentity = exactGit.dev + ':' + exactGit.ino;
    if (
      (record.ownership?.projectExactIdentity &&
        record.ownership.projectExactIdentity !== projectExactIdentity) ||
      (record.ownership?.gitFileIdentity && record.ownership.gitFileIdentity !== gitFileIdentity)
    )
      throw new AppError('WORKTREE_OWNERSHIP', 'Worktree 폴더나 Git 연결 파일이 교체되었습니다.');
    const listed = await this.git(source.path, ['worktree', 'list', '--porcelain', '-z'], signal);
    if (
      !listed
        .split('\0\0')
        .some(
          (block) =>
            block.split('\0').includes('worktree ' + child.path.replaceAll('\\', '/')) &&
            block.split('\0').includes('branch refs/heads/' + record.branch),
        )
    )
      throw new AppError('WORKTREE_OWNERSHIP', '원본 저장소의 Worktree 등록과 일치하지 않습니다.');
    if (!record.ownership?.projectExactIdentity || !record.ownership.gitFileIdentity) {
      // Upgrade legacy records only after exact managed path, registered inode,
      // branch and Git worktree registration have all been verified.
      record.ownership = {
        projectIdentity: child.identity,
        gitFileHash,
        projectExactIdentity,
        gitFileIdentity,
      };
      const saved = this.records.find((item) => item.id === record.id)!;
      saved.ownership = record.ownership;
      await this.save();
    }
    return { source, child };
  }
  async saveBackup(id: string, document: unknown) {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new AppError('WORKTREE_BACKUP', '잘못된 백업 ID입니다.');
    const root = await this.checkedRoot(),
      path = join(root, 'merge-backups');
    await mkdir(path, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error;
    });
    if ((await lstat(path)).isSymbolicLink() || (await realpath(path)) !== path)
      throw new AppError('WORKTREE_BACKUP', '백업 경로가 변경되었습니다.');
    const handle = await open(join(path, id + '.json'), 'wx', 0o600);
    try {
      await handle.writeFile(JSON.stringify(document));
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
  async loadBackup(id: string): Promise<unknown> {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new AppError('WORKTREE_BACKUP', '잘못된 백업 ID입니다.');
    const root = await this.checkedRoot(),
      folder = join(root, 'merge-backups'),
      path = join(folder, id + '.json');
    if ((await lstat(folder)).isSymbolicLink() || (await realpath(folder)) !== folder)
      throw new AppError('WORKTREE_BACKUP', '백업 경로가 변경되었습니다.');
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 64 * 1024 * 1024)
      throw new AppError('WORKTREE_BACKUP', '백업 파일을 확인할 수 없습니다.');
    return JSON.parse(await readFile(path, 'utf8'));
  }
  async markMerge(id: string, merge: NonNullable<WorktreeRecord['merge']>) {
    const work = this.queue.then(async () => {
      const record = this.records.find((record) => record.id === id);
      if (!record) throw new AppError('WORKTREE_NOT_FOUND', 'Worktree를 찾을 수 없습니다.');
      record.merge = structuredClone(merge);
      await this.save();
    });
    this.queue = work.catch(() => undefined);
    await work;
  }
  async markReviewed(id: string, files: NonNullable<WorktreeRecord['reviewed']>) {
    const work = this.queue.then(async () => {
      const record = this.records.find((record) => record.id === id);
      if (!record) throw new AppError('WORKTREE_NOT_FOUND', 'Worktree를 찾을 수 없습니다.');
      record.reviewed = { ...record.reviewed, ...files };
      await this.save();
    });
    this.queue = work.catch(() => undefined);
    await work;
  }
  private async save() {
    this.version = await this.store.saveIntegration('worktrees', this.version, this.records);
  }
  private async git(
    cwd: string,
    args: string[],
    signal: AbortSignal,
    filters: string[] = [],
    extraEnv: NodeJS.ProcessEnv = {},
    encoding: 'utf8' | 'latin1' = 'utf8',
  ) {
    const env: NodeJS.ProcessEnv = {
      GIT_CONFIG_NOSYSTEM: '1',
      // Git for Windows does not consistently accept the NUL device as a
      // config file. Use the checked empty regular file on every platform.
      GIT_CONFIG_GLOBAL: join(this.root, 'disabled-hooks'),
      GIT_TERMINAL_PROMPT: '0',
      GIT_OPTIONAL_LOCKS: '0',
      ...extraEnv,
    };
    for (const key of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP'])
      if (process.env[key]) env[key] = process.env[key];
    if (args[0] !== 'config' && filters.length === 0) {
      const keys = (
        await this.git(cwd, ['config', '--name-only', '--get-regexp', '^filter[.]'], signal)
      )
        .trim()
        .split(/\r?\n/)
        .filter(Boolean);
      filters = [];
      for (const prefix of new Set(keys.map((key) => key.slice(0, key.lastIndexOf('.'))))) {
        if (!/^filter\.[A-Za-z0-9_.-]+$/.test(prefix))
          throw new AppError('WORKTREE_FILTER', 'Git 필터 이름을 확인하세요.');
        for (const field of ['clean', 'smudge', 'process'])
          filters.push('-c', prefix + '.' + field + '=');
        filters.push('-c', prefix + '.required=false');
      }
    }
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
          {
            cwd,
            env,
            signal,
            timeout: 60000,
            maxBuffer: encoding === 'latin1' ? MAX_WORKTREE_BYTES + 1 : 4 * 1024 * 1024,
            windowsHide: true,
            encoding,
          },
        )
      ).stdout;
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      // Config probes return 1 when no matching settings exist.
      if (args[0] === 'config' && (error as { code?: number }).code === 1) return '';
      const failure = new AppError(
        'WORKTREE_GIT',
        'Git 작업에 실패했습니다. 저장소·Git 설치·경로·잠금 상태를 확인하세요. 생성 중인 폴더는 자동 삭제하지 않았습니다.',
      );
      // Preserve diagnostic causes internally; the API returns only code/message.
      Object.defineProperty(failure, 'cause', { value: error, enumerable: false });
      throw failure;
    }
  }
  create(
    source: Project,
    signal: AbortSignal,
  ): Promise<{ record: WorktreeRecord; project: Project }> {
    const work = this.queue.then(async () => {
      signal.throwIfAborted();
      if (this.records.filter((record) => record.status !== 'archived').length >= 50)
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
      if (!hookInfo.isFile() || hookInfo.isSymbolicLink() || hookInfo.size !== 0)
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
        const exactProject = await lstat(path, { bigint: true }),
          exactGit = await lstat(join(path, '.git'), { bigint: true });
        record.ownership = {
          projectIdentity: project.identity,
          projectExactIdentity: exactProject.dev + ':' + exactProject.ino,
          gitFileIdentity: exactGit.dev + ':' + exactGit.ino,
          gitFileHash: createHash('sha256')
            .update(await readFile(join(path, '.git')))
            .digest('hex'),
        };
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
  archive(id: string, signal: AbortSignal): Promise<WorktreeRecord> {
    const work = this.queue.then(async () => {
      const record = this.records.find((item) => item.id === id);
      if (!record || record.status !== 'ready')
        throw new AppError('WORKTREE_NOT_READY', '정리할 Worktree를 찾을 수 없습니다.');
      if (record.merge && ['applying', 'partial', 'interrupted'].includes(record.merge.status))
        throw new AppError(
          'WORKTREE_PARTIAL',
          '적용이 중단된 변경을 확인하거나 되돌린 뒤 정리하세요.',
          409,
        );
      const { source, child } = await this.verifyOwnership(record, signal);
      const ignored = await this.git(
        child.path,
        ['ls-files', '--others', '--ignored', '--exclude-standard', '-z'],
        signal,
      );
      if (ignored)
        throw new AppError(
          'WORKTREE_IGNORED',
          'Git에서 제외된 파일이 있습니다. 필요한 파일을 다른 폴더에 보관한 뒤 정리하세요.',
          409,
        );
      const gitlinks = await this.git(child.path, ['ls-files', '--stage', '-z'], signal);
      if (
        gitlinks
          .split('\0')
          .some((line) => line.startsWith('160000 ') || line.startsWith('120000 '))
      )
        throw new AppError(
          'WORKTREE_SPECIAL',
          '하위 모듈이나 심볼릭 링크가 있는 Worktree는 자동 정리하지 않습니다.',
        );
      const paths = async () =>
        [
          ...new Set(
            (
              await this.git(
                child.path,
                ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
                signal,
              )
            )
              .split('\0')
              .filter(Boolean),
          ),
        ].sort();
      const fingerprint = async () => {
        const entries = [];
        for (const path of await paths())
          entries.push([path, byteHash((await readWorktreeFile(child, path, signal)).bytes)]);
        return createHash('sha256').update(JSON.stringify(entries)).digest('hex');
      };
      const changed = [
        ...new Set(
          [
            ...(
              await this.git(
                child.path,
                [
                  'diff',
                  '--no-ext-diff',
                  '--no-textconv',
                  '--no-renames',
                  '--name-only',
                  '-z',
                  record.baseCommit,
                  '--',
                ],
                signal,
              )
            ).split('\0'),
            ...(
              await this.git(
                child.path,
                ['ls-files', '--others', '--exclude-standard', '-z'],
                signal,
              )
            ).split('\0'),
          ].filter(Boolean),
        ),
      ];
      for (const path of changed) {
        const theirsHash = byteHash((await readWorktreeFile(child, path, signal)).bytes),
          sourceHash = byteHash((await readWorktreeFile(source, path, signal)).bytes),
          reviewed = record.reviewed?.[path];
        if (
          theirsHash !== sourceHash &&
          !(reviewed?.theirsHash === theirsHash && reviewed.sourceHash === sourceHash)
        )
          throw new AppError(
            'WORKTREE_UNMERGED',
            '검토하거나 원본에 반영하지 않은 변경이 있습니다: ' + path,
            409,
          );
      }
      const before = await fingerprint(),
        head = (await this.git(child.path, ['rev-parse', 'HEAD'], signal)).trim();
      const keys = (
          await this.git(
            child.path,
            ['config', '--name-only', '--get-regexp', '^filter[.]'],
            signal,
          )
        )
          .trim()
          .split(/\r?\n/)
          .filter(Boolean),
        filters: string[] = [];
      for (const prefix of new Set(keys.map((key) => key.slice(0, key.lastIndexOf('.'))))) {
        if (!/^filter\.[A-Za-z0-9_.-]+$/.test(prefix))
          throw new AppError('WORKTREE_FILTER', 'Git 필터 이름을 확인하세요.');
        for (const field of ['clean', 'smudge', 'process'])
          filters.push('-c', prefix + '.' + field + '=');
        filters.push('-c', prefix + '.required=false');
      }
      const index = join(await this.checkedRoot(), '.archive-index-' + randomUUID());
      const env = {
        GIT_INDEX_FILE: index,
        GIT_AUTHOR_NAME: 'Lodex',
        GIT_AUTHOR_EMAIL: 'snapshot@lodex.local',
        GIT_COMMITTER_NAME: 'Lodex',
        GIT_COMMITTER_EMAIL: 'snapshot@lodex.local',
      };
      try {
        await this.git(child.path, ['read-tree', 'HEAD'], signal, filters, env);
        await this.git(child.path, ['add', '--all', '--', '.'], signal, filters, env);
        const tree = (await this.git(child.path, ['write-tree'], signal, filters, env)).trim();
        const commit = (
          await this.git(
            child.path,
            ['commit-tree', tree, '-p', head, '-m', 'Lodex archived worktree ' + id],
            signal,
            filters,
            env,
          )
        ).trim();
        if (!/^[0-9a-f]{40,64}$/.test(commit))
          throw new AppError('WORKTREE_ARCHIVE', '복구 스냅샷을 확인할 수 없습니다.');
        const ref = 'refs/lodex/archive/' + id;
        await this.git(child.path, ['update-ref', ref, commit], signal, filters, env);
        record.archive = { commit, ref, createdAt: new Date().toISOString() };
        await this.save();
        await this.verifyOwnership(record, signal);
        if (
          before !== (await fingerprint()) ||
          head !== (await this.git(child.path, ['rev-parse', 'HEAD'], signal)).trim() ||
          (await this.git(
            child.path,
            ['ls-files', '--others', '--ignored', '--exclude-standard', '-z'],
            signal,
          ))
        )
          throw new AppError(
            'WORKTREE_STALE',
            '스냅샷 저장 중 Worktree가 변경되어 폴더를 보존했습니다.',
            409,
          );
        // Git performs removal only for this verified registered child checkout.
        // Never recursively delete a computed directory or the source project.
        await this.git(
          source.path,
          ['worktree', 'remove', '--force', '--', record.path],
          signal,
          filters,
        );
        record.status = 'archived';
        await this.save();
        return structuredClone(record);
      } finally {
        if ((await this.checkedRoot()) === this.root) {
          await unlink(index).catch(() => undefined);
          await unlink(index + '.lock').catch(() => undefined);
        }
      }
    });
    this.queue = work.catch(() => undefined);
    return work;
  }
  async close() {
    await this.queue;
  }
}
