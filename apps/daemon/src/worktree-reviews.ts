import { createHash, randomUUID } from 'node:crypto';
import { writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createTwoFilesPatch } from 'diff';
import {
  AppError,
  type WorktreePreview,
  type WorktreeResolution,
  type ToolDefinition,
} from '@lodex/contracts';
import { withProjectWrite } from '@lodex/tools';
import type { Store } from '@lodex/storage';
import type { Worktrees } from './worktrees';
import { z } from 'zod';
import {
  byteHash,
  decodeText,
  readWorktreeFile,
  replaceWorktreeFile,
  MAX_WORKTREE_TEXT,
} from './worktree-files';

export const worktreeReviewSchema = z.strictObject({
  worktreeId: z.uuid(),
  offset: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(50).default(20),
  paths: z.array(z.string().min(1).max(4096)).min(1).max(50).optional(),
  reviewVersion: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
});
export const worktreeMergeSchema = z.strictObject({
  previewId: z.uuid(),
  resolutions: z
    .record(
      z.string().max(4096),
      z.union([
        z.string().max(MAX_WORKTREE_TEXT),
        z.null(),
        z.strictObject({ choice: z.enum(['ours', 'theirs']) }),
      ]),
    )
    .default({}),
});
export const worktreeTools: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'review_worktree',
      description:
        'Review one page or selected paths of an isolated worktree against its base and current source. Follow nextOffset with reviewVersion to inspect all changes. Each review ID applies only its returned files; other pages remain untouched. Binary files require explicit ours/theirs choices. Never changes files.',
      parameters: z.toJSONSchema(worktreeReviewSchema),
    },
  },
  {
    type: 'function',
    function: {
      name: 'merge_worktree',
      description:
        'Apply one exact prior reviewed page under the permission policy. Resolve conflicting UTF-8 paths using complete text, null for deletion, or {choice:"ours"|"theirs"}; binary files require a choice. Refuses changed files or review version. Durable originals allow undo, Git index remains untouched. Review other pages separately.',
      parameters: z.toJSONSchema(worktreeMergeSchema),
    },
  },
];
const run = promisify(execFile),
  PAGE_BYTES = 6 * 1024 * 1024;
const markers = /^(?:<{7}|={7}|>{7}|\|{7})(?: |$)/m;
type SavedPreview = {
  preview: WorktreePreview;
  identities: Map<string, { before: string | null; theirs: string | null }>;
};
const backupSchema = z.strictObject({
  worktreeId: z.uuid(),
  sourceProjectId: z.uuid(),
  previewId: z.uuid(),
  files: z.array(
    z.strictObject({
      path: z.string(),
      before: z.string().nullable(),
      beforeHash: z.string().nullable(),
      afterHash: z.string().nullable(),
    }),
  ),
});
async function mergeText(
  current: string,
  base: string,
  theirs: string,
  folder: string,
  signal: AbortSignal,
  worktrees: Worktrees,
) {
  const names = [0, 1, 2].map((index) => join(folder, `.lodex-merge-${randomUUID()}-${index}.tmp`));
  try {
    for (const [index, value] of [current, base, theirs].entries())
      await writeFile(names[index]!, value, { flag: 'wx', mode: 0o600 });
    const context = await worktrees.gitContext(folder);
    try {
      return {
        merged: (
          await run(
            context.executable,
            [
              ...context.args,
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
            ],
            {
              cwd: folder,
              env: context.env,
              signal,
              windowsHide: true,
              maxBuffer: MAX_WORKTREE_TEXT * 4,
              timeout: 30000,
            },
          )
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
  private previews = new Map<string, SavedPreview>();
  private queue: Promise<unknown> = Promise.resolve();
  constructor(
    _store: Store,
    private worktrees: Worktrees,
  ) {}
  private async projects(id: string, signal: AbortSignal) {
    const record = this.worktrees.list().find((record) => record.id === id);
    if (!record?.projectId || record.status !== 'ready')
      throw new AppError('WORKTREE_NOT_READY', '검토할 Worktree를 찾을 수 없습니다.');
    const { source, child } = await this.worktrees.verifyOwnership(record, signal);
    return { record, source, child };
  }
  private async inventory(id: string, signal: AbortSignal) {
    const context = await this.projects(id, signal),
      { record, child } = context;
    const tracked = await this.worktrees.readGit(
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
    );
    const untracked = await this.worktrees.readGit(
      child.path,
      ['ls-files', '--others', '--exclude-standard', '-z', '--'],
      signal,
    );
    const paths = [...new Set((tracked + '\0' + untracked).split('\0').filter(Boolean))].sort();
    const digest = createHash('sha256')
      .update(record.baseCommit)
      .update((await this.worktrees.readGit(child.path, ['rev-parse', 'HEAD'], signal)).trim());
    for (const path of paths) {
      const file = await readWorktreeFile(child, path, signal);
      digest.update(JSON.stringify([path, byteHash(file.bytes), file.identity]));
    }
    return { ...context, paths, version: digest.digest('hex') };
  }
  async preview(
    id: string,
    signal: AbortSignal,
    options: {
      offset?: number;
      limit?: number;
      paths?: string[] | undefined;
      reviewVersion?: string | undefined;
    } = {},
  ): Promise<WorktreePreview> {
    const input = worktreeReviewSchema.parse({ worktreeId: id, ...options });
    const { record, source, child, paths, version } = await this.inventory(id, signal);
    if (input.reviewVersion && input.reviewVersion !== version)
      throw new AppError(
        'WORKTREE_STALE',
        'Worktree 변경 목록이 달라졌습니다. 첫 페이지부터 다시 검토하세요.',
        409,
      );
    if (input.paths?.some((path) => !paths.includes(path)))
      throw new AppError('WORKTREE_PATH', '현재 변경 목록에 있는 파일만 선택하세요.');
    const selected = input.paths
      ? [...new Set(input.paths)]
      : paths.slice(input.offset, input.offset + input.limit);
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
      reviewVersion: version,
      totalPaths: paths.length,
      offset: input.offset,
      nextOffset: null,
      paths,
      files: [],
    };
    const identities: SavedPreview['identities'] = new Map();
    let bytes = 0,
      scanned = 0;
    for (const path of selected) {
      signal.throwIfAborted();
      const beforeFile = await readWorktreeFile(source, path, signal),
        theirsFile = await readWorktreeFile(child, path, signal);
      const baseBytes = basePaths.has(path)
        ? await this.worktrees.readBlob(child.path, `${record.baseCommit}:${path}`, signal)
        : null;
      const before = decodeText(beforeFile.bytes),
        theirs = decodeText(theirsFile.bytes),
        base = decodeText(baseBytes);
      const binary =
        [before, theirs, base].includes(undefined) ||
        [beforeFile.bytes, theirsFile.bytes, baseBytes].some(
          (value) => value !== null && value.length > MAX_WORKTREE_TEXT,
        );
      const cost =
        (beforeFile.bytes?.length ?? 0) +
        (theirsFile.bytes?.length ?? 0) +
        (baseBytes?.length ?? 0);
      if (scanned && bytes + cost > PAGE_BYTES) break;
      bytes += cost;
      scanned++;
      const beforeHash = byteHash(beforeFile.bytes),
        theirsHash = byteHash(theirsFile.bytes),
        baseHash = byteHash(baseBytes);
      if (beforeHash === theirsHash) continue;
      let merged = theirs ?? null,
        conflict = binary;
      if (!binary && beforeHash !== baseHash) {
        if (theirsHash === baseHash) merged = before ?? null;
        else if (before !== null && theirs !== null && base !== null) {
          const result = await mergeText(
            before!,
            base!,
            theirs!,
            child.path,
            signal,
            this.worktrees,
          );
          merged = result.merged;
          conflict = result.conflict;
        } else conflict = true;
      }
      const fullDiff = binary
        ? '바이트 파일 또는 2 MiB 초과 파일: 해시와 크기를 확인하고 원본 또는 Worktree를 선택하세요.'
        : createTwoFilesPatch('a/' + path, 'b/' + path, before ?? '', merged ?? '', '', '', {
            context: 3,
            timeout: 500,
          });
      const diffTruncated = fullDiff === undefined || fullDiff.length > 256 * 1024;
      const diff =
        fullDiff === undefined
          ? '비교 시간이 길어 차이를 생략했습니다. 전체 파일 내용을 확인하세요.'
          : fullDiff.slice(0, 256 * 1024);
      preview.files.push({
        path,
        before: binary ? null : before!,
        theirs: binary ? null : theirs!,
        merged: binary ? null : merged,
        beforeHash,
        theirsHash,
        conflict,
        diff,
        binary,
        beforeBytes: beforeFile.bytes?.length ?? 0,
        theirsBytes: theirsFile.bytes?.length ?? 0,
        diffTruncated,
      });
      identities.set(path, { before: beforeFile.identity, theirs: theirsFile.identity });
    }
    if (input.paths && scanned !== selected.length)
      throw new AppError(
        'WORKTREE_PAGE_LIMIT',
        '선택한 텍스트가 한 페이지에 너무 큽니다. 파일을 나눠 선택하세요.',
      );
    if (!input.paths && input.offset + scanned < paths.length)
      preview.nextOffset = input.offset + scanned;
    if ((await this.inventory(id, signal)).version !== version)
      throw new AppError('WORKTREE_STALE', '검토 중 Worktree 파일이 변경되었습니다.', 409);
    // Bound retained text while allowing independently reviewed pages.
    while (
      this.previews.size >= 16 ||
      [...this.previews.values()].reduce(
        (total, value) => total + JSON.stringify(value.preview).length * 2,
        0,
      ) >
        64 * 1024 * 1024
    )
      this.previews.delete(this.previews.keys().next().value!);
    this.previews.set(preview.id, { preview, identities });
    return structuredClone(preview);
  }
  get(previewId: string) {
    const saved = this.previews.get(previewId);
    if (!saved) throw new AppError('WORKTREE_REVIEW_EXPIRED', '변경 검토를 다시 불러오세요.', 409);
    return structuredClone(saved.preview);
  }
  async apply(
    previewId: string,
    resolutions: Record<string, WorktreeResolution>,
    signal: AbortSignal,
  ) {
    const work = this.queue.then(async () => {
      const preview = this.get(previewId),
        saved = this.previews.get(previewId)!;
      const { record, source, child, version } = await this.inventory(preview.worktreeId, signal);
      if (version !== preview.reviewVersion)
        throw new AppError('WORKTREE_STALE', '검토 후 Worktree 변경 목록이 달라졌습니다.', 409);
      if (
        Object.keys(resolutions).some(
          (path) => !preview.files.some((file) => file.path === path && file.conflict),
        )
      )
        throw new AppError('WORKTREE_RESOLUTION', '검토한 충돌 파일만 해결할 수 있습니다.');
      return withProjectWrite(source, async () => {
        const files = [];
        for (const file of preview.files) {
          const before = await readWorktreeFile(source, file.path, signal),
            theirs = await readWorktreeFile(child, file.path, signal),
            ownership = saved.identities.get(file.path)!;
          if (
            byteHash(before.bytes) !== file.beforeHash ||
            byteHash(theirs.bytes) !== file.theirsHash ||
            before.identity !== ownership.before ||
            theirs.identity !== ownership.theirs
          )
            throw new AppError(
              'WORKTREE_STALE',
              '검토 후 파일 내용이나 소유권이 변경되었습니다.',
              409,
            );
          const resolution = file.conflict ? resolutions[file.path] : file.merged;
          if (
            resolution === undefined ||
            (file.binary && !(resolution && typeof resolution === 'object'))
          )
            throw new AppError(
              'WORKTREE_CONFLICT',
              '충돌 파일과 바이트 파일의 처리 방법을 선택하세요.',
              409,
            );
          if (
            typeof resolution === 'string' &&
            (Buffer.byteLength(resolution) > MAX_WORKTREE_TEXT ||
              resolution.includes('\0') ||
              (file.conflict && markers.test(resolution)))
          )
            throw new AppError(
              'WORKTREE_CONFLICT',
              '2 MiB 이하의 UTF-8 내용으로 충돌 표시를 해결하세요.',
              409,
            );
          const next =
            resolution && typeof resolution === 'object'
              ? resolution.choice === 'ours'
                ? before.bytes
                : theirs.bytes
              : resolution === null
                ? null
                : Buffer.from(resolution);
          files.push({ ...file, beforeBytes: before.bytes, beforeIdentity: before.identity, next });
        }
        const backupId = randomUUID();
        await this.worktrees.saveBackup(backupId, {
          worktreeId: record.id,
          sourceProjectId: source.id,
          previewId,
          files: files.map((file) => ({
            path: file.path,
            before: file.beforeBytes?.toString('base64') ?? null,
            beforeHash: file.beforeHash,
            afterHash: byteHash(file.next),
          })),
        });
        record.merge = {
          status: 'applying',
          previewId,
          backupId,
          reviewVersion: preview.reviewVersion!,
          files: files.map((file) => ({
            path: file.path,
            beforeHash: file.beforeHash,
            afterHash: byteHash(file.next),
            applied: false,
          })),
        };
        await this.worktrees.markMerge(record.id, record.merge);
        try {
          for (const [index, file] of files.entries()) {
            const currentChild = await readWorktreeFile(child, file.path, signal);
            if (
              byteHash(currentChild.bytes) !== file.theirsHash ||
              currentChild.identity !== saved.identities.get(file.path)!.theirs
            )
              throw new AppError(
                'WORKTREE_STALE',
                '적용 도중 Worktree 파일이 변경되었습니다.',
                409,
              );
            const afterIdentity = await replaceWorktreeFile(
              source,
              file.path,
              file.beforeHash,
              file.beforeIdentity,
              file.next,
              signal,
            );
            record.merge.files[index]!.afterIdentity = afterIdentity;
            record.merge.files[index]!.applied = true;
            await this.worktrees.markMerge(record.id, record.merge);
            await this.worktrees.markReviewed(record.id, {
              [file.path]: { theirsHash: file.theirsHash, sourceHash: byteHash(file.next) },
            });
          }
          record.merge.status = 'applied';
          await this.worktrees.markMerge(record.id, record.merge);
          this.previews.delete(previewId);
          return this.worktrees.list().find((item) => item.id === record.id)!;
        } catch (error) {
          record.merge.status = 'partial';
          await this.worktrees.markMerge(record.id, record.merge);
          throw error;
        }
      });
    });
    this.queue = work.catch(() => undefined);
    return work;
  }
  async undo(id: string, signal: AbortSignal) {
    const work = this.queue.then(async () => {
      const { record, source } = await this.projects(id, signal),
        merge = record.merge;
      if (!merge?.backupId || merge.status === 'reverted')
        throw new AppError('WORKTREE_UNDO', '되돌릴 Worktree 변경이 없습니다.');
      const backup = backupSchema.parse(await this.worktrees.loadBackup(merge.backupId));
      if (
        backup.worktreeId !== id ||
        backup.sourceProjectId !== source.id ||
        backup.previewId !== merge.previewId
      )
        throw new AppError('WORKTREE_BACKUP', '백업과 적용 기록이 일치하지 않습니다.');
      return withProjectWrite(source, async () => {
        const files = [];
        for (const file of merge.files.filter((file) => file.applied)) {
          const stored = backup.files.find((item) => item.path === file.path),
            current = await readWorktreeFile(source, file.path, signal);
          const before =
            stored?.before === null
              ? null
              : stored
                ? Buffer.from(stored.before, 'base64')
                : undefined;
          if (
            !stored ||
            before === undefined ||
            byteHash(before) !== file.beforeHash ||
            stored.afterHash !== file.afterHash ||
            byteHash(current.bytes) !== file.afterHash ||
            current.identity !== file.afterIdentity
          )
            throw new AppError(
              'WORKTREE_UNDO_CONFLICT',
              '적용 후 바뀐 파일이 있어 되돌리지 않았습니다: ' + file.path,
              409,
            );
          files.push({ file, current, before });
        }
        for (const { file, current, before } of files.reverse()) {
          await replaceWorktreeFile(
            source,
            file.path,
            file.afterHash,
            current.identity,
            before,
            signal,
          );
          file.applied = false;
          await this.worktrees.markMerge(id, merge);
        }
        merge.status = 'reverted';
        await this.worktrees.markMerge(id, merge);
        return this.worktrees.list().find((item) => item.id === id)!;
      });
    });
    this.queue = work.catch(() => undefined);
    return work;
  }
}
