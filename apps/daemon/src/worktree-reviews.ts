import { createHash, randomUUID } from 'node:crypto';
import { writeFile, unlink } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createTwoFilesPatch } from 'diff';
import { AppError, type Project, type WorktreePreview, type ChangeSet } from '@lodex/contracts';
import { readText, resolveTarget, runProjectTool, writeChanges, checkChanges } from '@lodex/tools';
import type { Store } from '@lodex/storage';
import type { Worktrees } from './worktrees';
import { z } from 'zod';
import type { ToolDefinition } from '@lodex/contracts';
export const worktreeReviewSchema = z.strictObject({ worktreeId: z.uuid() });
export const worktreeMergeSchema = z.strictObject({
  previewId: z.uuid(),
  resolutions: z.record(z.string().max(4096), z.string().max(32768).nullable()).default({}),
});
export const worktreeTools: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'review_worktree',
      description:
        "Compare an isolated worktree against its base and the current selected source project. Returns a review ID, diffs, and three-way conflicts. Never applies files. Only this project's worktrees can be inspected.",
      parameters: z.toJSONSchema(worktreeReviewSchema),
    },
  },
  {
    type: 'function',
    function: {
      name: 'merge_worktree',
      description:
        'Apply an exact prior review to the selected source project under its permission policy. Resolve every conflicting path with the desired complete UTF-8 text (null means deletion). Refuses changed source/worktree files and unresolved conflict markers. Leaves the Git index and commits untouched. Review actual outcomes; a partial merge is not a pass.',
      parameters: z.toJSONSchema(worktreeMergeSchema),
    },
  },
];
const run = promisify(execFile);
const hash = (text: string | null) =>
  text === null ? null : createHash('sha256').update(text).digest('hex');
async function text(project: Project, path: string, signal: AbortSignal) {
  try {
    return await readText(project, path, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}
async function mergeText(
  current: string,
  base: string,
  theirs: string,
  folder: string,
  signal: AbortSignal,
) {
  const names = [0, 1, 2].map((index) => join(folder, `.lodex-merge-${randomUUID()}-${index}.tmp`));
  try {
    for (const [index, value] of [current, base, theirs].entries())
      await writeFile(names[index]!, value, { flag: 'wx', mode: 0o600 });
    const args = [
      'merge-file',
      '--diff3',
      '-p',
      '-L',
      'Current project',
      '-L',
      'Base',
      '-L',
      'Subagent worktree',
      ...names,
    ];
    try {
      return {
        merged: (
          await run('git', args, {
            cwd: folder,
            signal,
            windowsHide: true,
            maxBuffer: 1048576,
            timeout: 30000,
          })
        ).stdout,
        conflict: false,
      };
    } catch (error) {
      const result = error as { code?: number; stdout?: string };
      if (
        typeof result.code === 'number' &&
        result.code > 0 &&
        result.code < 128 &&
        typeof result.stdout === 'string'
      )
        return { merged: result.stdout, conflict: true };
      throw error;
    }
  } finally {
    for (const name of names) await unlink(name).catch(() => undefined);
  }
}
export class WorktreeReviews {
  private previews = new Map<string, WorktreePreview>();
  private queue: Promise<unknown> = Promise.resolve();
  constructor(
    private store: Store,
    private worktrees: Worktrees,
  ) {}
  private async projects(id: string) {
    const record = this.worktrees.list().find((record) => record.id === id);
    if (!record?.projectId || record.status !== 'ready')
      throw new AppError('WORKTREE_NOT_READY', '검토할 Worktree를 찾을 수 없습니다.');
    const source = await this.store.project(record.sourceProjectId),
      child = await this.store.project(record.projectId);
    if (child.path !== record.path)
      throw new AppError('WORKTREE_PATH', 'Worktree 경로가 변경되었습니다.');
    return { record, source, child };
  }
  async preview(id: string, signal: AbortSignal): Promise<WorktreePreview> {
    const { record, source, child } = await this.projects(id);
    const tracked = (
      await this.worktrees.readGit(
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
    )
      .split('\0')
      .filter(Boolean);
    const untracked = (
      await this.worktrees.readGit(
        child.path,
        ['ls-files', '--others', '--exclude-standard', '-z', '--'],
        signal,
      )
    )
      .split('\0')
      .filter(Boolean);
    const paths = [...new Set([...tracked, ...untracked])];
    if (paths.length > 8)
      throw new AppError(
        'WORKTREE_REVIEW_LIMIT',
        '한 번에 최대 8개 파일을 검토합니다. 큰 변경은 작업을 나누세요.',
      );
    const basePaths = new Set(
      (
        await this.worktrees.readGit(
          child.path,
          ['ls-tree', '-r', '--name-only', '-z', record.baseCommit, '--'],
          signal,
        )
      ).split('\0'),
    );
    const preview: WorktreePreview = {
      id: randomUUID(),
      worktreeId: id,
      sourceProjectId: source.id,
      createdAt: new Date().toISOString(),
      files: [],
    };
    let bytes = 0;
    for (const path of paths) {
      signal.throwIfAborted();
      const before = await text(source, path, signal),
        theirs = await text(child, path, signal);
      const base = basePaths.has(path)
        ? await this.worktrees.readGit(child.path, ['show', `${record.baseCommit}:${path}`], signal)
        : null;
      bytes += Buffer.byteLength((before ?? '') + (theirs ?? '') + (base ?? ''));
      if (
        bytes > 131072 ||
        [before, theirs, base].some(
          (value) => value !== null && (Buffer.byteLength(value) > 32768 || value.includes('\0')),
        )
      )
        throw new AppError(
          'WORKTREE_TEXT_LIMIT',
          'UTF-8 텍스트 파일당 32 KiB, 검토당 128 KiB 이하의 변경을 지원합니다.',
        );
      if (before === theirs) continue;
      let merged = theirs,
        conflict = false;
      if (before !== base) {
        if (theirs === base) merged = before;
        else if (before !== null && theirs !== null && base !== null) {
          const result = await mergeText(before, base, theirs, child.path, signal);
          merged = result.merged;
          conflict = result.conflict;
        } else conflict = true;
      }
      const diff = createTwoFilesPatch(
        'a/' + path,
        'b/' + path,
        before ?? '',
        merged ?? '',
        '',
        '',
        { context: 3, timeout: 500 },
      );
      if (diff === undefined)
        throw new AppError('WORKTREE_DIFF_LIMIT', '파일 비교 시간이 초과되었습니다.');
      preview.files.push({
        path,
        before,
        theirs,
        merged,
        beforeHash: hash(before),
        theirsHash: hash(theirs),
        conflict,
        diff,
      });
    }
    if (this.previews.size >= 64) this.previews.delete(this.previews.keys().next().value!);
    this.previews.set(preview.id, preview);
    return structuredClone(preview);
  }
  get(previewId: string) {
    const preview = this.previews.get(previewId);
    if (!preview)
      throw new AppError('WORKTREE_REVIEW_EXPIRED', '변경 검토를 다시 불러오세요.', 409);
    return preview;
  }
  async apply(previewId: string, resolutions: Record<string, string | null>, signal: AbortSignal) {
    const work = this.queue.then(async () => {
      const preview = this.get(previewId),
        { record, source, child } = await this.projects(preview.worktreeId);
      if (
        Object.keys(resolutions).some(
          (path) => !preview.files.some((file) => file.path === path && file.conflict),
        )
      )
        throw new AppError('WORKTREE_RESOLUTION', '검토한 충돌 파일만 해결할 수 있습니다.');
      const files = preview.files.map((file) => ({
        ...file,
        next: file.conflict ? resolutions[file.path] : file.merged,
      }));
      for (const file of files) {
        if (
          file.next === undefined ||
          (file.conflict &&
            typeof file.next === 'string' &&
            /^(?:<{7}|={7}|>{7}|\|{7})(?: |$)/m.test(file.next))
        )
          throw new AppError('WORKTREE_CONFLICT', '충돌 내용을 해결한 뒤 적용하세요.', 409);
        if (
          file.next !== null &&
          (Buffer.byteLength(file.next) > 32768 || file.next.includes('\0'))
        )
          throw new AppError(
            'WORKTREE_TEXT_LIMIT',
            '해결한 파일은 32 KiB 이하의 UTF-8 텍스트여야 합니다.',
          );
        if (
          hash(await text(source, file.path, signal)) !== file.beforeHash ||
          hash(await text(child, file.path, signal)) !== file.theirsHash
        )
          throw new AppError(
            'WORKTREE_STALE',
            '검토 후 파일이 변경되었습니다. 다시 비교하세요.',
            409,
          );
      }
      record.merge = {
        status: 'applying',
        previewId,
        files: files.map((file) => ({
          path: file.path,
          beforeHash: file.beforeHash,
          afterHash: hash(file.next!),
          applied: false,
        })),
      };
      await this.worktrees.markMerge(record.id, record.merge);
      try {
        for (const [index, file] of files.entries()) {
          signal.throwIfAborted();
          if (
            hash(await text(source, file.path, signal)) !== file.beforeHash ||
            hash(await text(child, file.path, signal)) !== file.theirsHash
          )
            throw new AppError('WORKTREE_STALE', '적용 도중 파일이 변경되었습니다.', 409);
          if (file.next === file.before) {
            record.merge.files[index]!.applied = true;
            continue;
          }
          if (file.next === null) {
            const inspected = JSON.parse(
              await runProjectTool(
                source,
                'inspect_path',
                JSON.stringify({ path: file.path }),
                signal,
              ),
            );
            if (inspected.error) throw new AppError('WORKTREE_DELETE', inspected.message);
            const deleted = JSON.parse(
              await runProjectTool(
                source,
                'delete_path',
                JSON.stringify({ path: file.path, expectedFingerprint: inspected.fingerprint }),
                signal,
                undefined,
                undefined,
                async () => true,
              ),
            );
            if (deleted.error) throw new AppError('WORKTREE_DELETE', deleted.message);
          } else {
            const parent = dirname(file.path).replaceAll('\\', '/');
            let current = '';
            if (parent !== '.')
              for (const part of parent.split('/')) {
                current = current ? current + '/' + part : part;
                try {
                  await resolveTarget(source, current);
                } catch (error) {
                  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
                  const made = JSON.parse(
                    await runProjectTool(
                      source,
                      'make_directory',
                      JSON.stringify({ path: current }),
                      signal,
                      undefined,
                      undefined,
                      async () => true,
                    ),
                  );
                  if (made.error) throw new AppError('WORKTREE_DIRECTORY', made.message);
                }
              }
            const changes: ChangeSet = {
              status: 'proposed',
              files: [
                file.before === null
                  ? {
                      kind: 'create',
                      path: file.path,
                      content: file.next!,
                      afterHash: hash(file.next!)!,
                      stagingId: randomUUID(),
                      diff: file.diff,
                    }
                  : {
                      path: file.path,
                      oldText: file.before,
                      newText: file.next!,
                      beforeHash: file.beforeHash!,
                      afterHash: hash(file.next!)!,
                      diff: file.diff,
                      status: 'proposed',
                      offset: 0,
                    },
              ],
            };
            const inspected = await checkChanges(source, changes, signal);
            if (['conflict', 'uncertain'].includes(inspected.status))
              throw new AppError(
                'WORKTREE_FILE_CONFLICT',
                `파일 경로·내용·소유권을 확인하세요: ${file.path} (${inspected.observations?.[0]?.state})`,
                409,
              );
            await writeChanges(source, changes, 'apply', signal);
          }
          if (hash(await text(source, file.path, signal)) !== hash(file.next!))
            throw new AppError('WORKTREE_OUTCOME', '적용 결과가 예상 파일 내용과 다릅니다.');
          record.merge.files[index]!.applied = true;
          await this.worktrees.markMerge(record.id, record.merge);
        }
        record.merge.status = 'applied';
        await this.worktrees.markMerge(record.id, record.merge);
        this.previews.delete(previewId);
        return record;
      } catch (error) {
        record.merge.status = 'partial';
        await this.worktrees.markMerge(record.id, record.merge);
        throw error;
      }
    });
    this.queue = work.catch(() => undefined);
    return work;
  }
}
