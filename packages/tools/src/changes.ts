import { lstat, open, link, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { createTwoFilesPatch } from 'diff';
import {
  AppError,
  type Project,
  type ChangeSet,
  type FileChange,
  type CreatedFileProposal,
} from '@lodex/contracts';
import {
  digest,
  proposeEdit,
  readText,
  resolveTarget,
  withProjectWrite,
  writeEditUnlocked,
} from './index';

export const changeInputSchema = z.strictObject({
  files: z
    .array(
      z.union([
        z.strictObject({
          kind: z.literal('edit'),
          path: z.string().min(1).max(4096),
          expectedHash: z.string().regex(/^[a-f0-9]{64}$/),
          oldText: z.string().min(1).max(6000),
          newText: z.string().max(6000),
        }),
        z.strictObject({
          kind: z.literal('create'),
          path: z.string().min(1).max(4096),
          content: z.string().max(12000),
        }),
      ]),
    )
    .min(1)
    .max(8),
});
const isCreate = (file: FileChange): file is CreatedFileProposal =>
  'kind' in file && file.kind === 'create';
const absent = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT';
type Observation = NonNullable<ChangeSet['observations']>[number];
const projectDotenv = (path: string) => /^\.env(?:\.|$)/i.test(path.replaceAll('\\', '/'));

// Validate the entire supplied path, including a nonexistent leaf, before using its parent.
async function destination(project: Project, path: string, allowProjectDotenv = false) {
  try {
    await resolveTarget(project, path, allowProjectDotenv);
  } catch (error) {
    if (!absent(error)) throw error;
  }
  const portable = path.replaceAll('\\', '/');
  const parent = await resolveTarget(project, dirname(portable));
  if (!parent.info.isDirectory() || ['.', '..', ''].includes(basename(portable)))
    throw new AppError('CREATE_PARENT', '기존 프로젝트 폴더 안의 파일 경로가 필요합니다.');
  return join(parent.path, basename(portable));
}
function temporary(path: string, file: CreatedFileProposal) {
  if (!z.uuid().safeParse(file.stagingId).success)
    throw new AppError('EDIT_INVALID', '임시 파일 식별자가 잘못되었습니다.');
  return join(dirname(path), '.lodex-edit-' + file.stagingId + '.tmp');
}

export async function proposeChanges(
  project: Project,
  input: unknown,
  signal: AbortSignal,
): Promise<ChangeSet> {
  const args = changeInputSchema.parse(input);
  const files: FileChange[] = [];
  const paths = new Set<string>();
  for (const item of args.files) {
    signal.throwIfAborted();
    const allowProjectDotenv = item.kind === 'create' && projectDotenv(item.path);
    const target = await destination(project, item.path, allowProjectDotenv);
    // Also reject case aliases on case-sensitive systems so a set stays portable.
    const key = target.toLowerCase();
    if (paths.has(key))
      throw new AppError(
        'CHANGE_DUPLICATE',
        '한 변경 묶음에는 파일당 하나의 변경만 넣을 수 있습니다.',
      );
    paths.add(key);
    if (item.kind === 'edit') {
      const { kind: _, ...edit } = item;
      files.push(await proposeEdit(project, edit, signal));
    } else {
      try {
        await lstat(target);
        throw new AppError('CREATE_EXISTS', '새 파일 경로가 이미 존재합니다.');
      } catch (error) {
        if (!absent(error)) throw error;
      }
      if (
        item.content.includes('\0') ||
        Buffer.from(item.content).toString('utf8') !== item.content
      )
        throw new AppError('FILE_UNSUPPORTED', '새 파일 내용은 UTF-8 텍스트여야 합니다.');
      const diff = createTwoFilesPatch('/dev/null', 'b/' + item.path, '', item.content, '', '', {
        context: 3,
        timeout: 500,
      });
      if (!diff) throw new AppError('DIFF_LIMIT', '변경 비교를 만들 수 없습니다.');
      files.push({
        kind: 'create',
        path: item.path,
        content: item.content,
        afterHash: digest(item.content),
        stagingId: randomUUID(),
        diff,
      });
    }
  }
  if (
    Buffer.byteLength(JSON.stringify(files)) > 96000 ||
    Buffer.byteLength(files.map((f) => f.diff).join('\n')) > 48000
  )
    throw new AppError('DIFF_LIMIT', '변경 묶음이 너무 큽니다. 파일 수나 수정 범위를 줄여 주세요.');
  return { files, status: 'proposed' };
}

// A crash between link() and unlink() can leave the owned staging name. Only
// remove that name when both names still identify the exact proposed bytes.
async function releaseStagingLink(
  project: Project,
  file: CreatedFileProposal,
  signal: AbortSignal,
) {
  const allowProjectDotenv = projectDotenv(file.path);
  const target = await resolveTarget(project, file.path, allowProjectDotenv);
  if (target.info.nlink === 1) return;
  const staged = temporary(target.path, file);
  const info = await lstat(staged);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.nlink !== 2 ||
    target.info.nlink !== 2 ||
    info.ino !== target.info.ino ||
    info.dev !== target.info.dev
  )
    throw new AppError(
      'FILE_UNSUPPORTED',
      '소유권을 확인할 수 없는 하드 링크는 처리하지 않습니다.',
    );
  if (
    digest(await readText(project, file.path, signal, true, allowProjectDotenv)) !== file.afterHash
  )
    throw new AppError(
      'EDIT_CONFLICT',
      '생성 파일이 변경되었습니다. 임시 링크를 정리하지 않았습니다.',
    );
  const current = await resolveTarget(project, file.path, allowProjectDotenv);
  const stagedNow = await lstat(staged);
  if (
    current.info.ino !== info.ino ||
    current.info.dev !== info.dev ||
    stagedNow.ino !== info.ino ||
    stagedNow.dev !== info.dev ||
    stagedNow.isSymbolicLink()
  )
    throw new AppError('EDIT_CONFLICT', '파일이 상태 확인 중 교체되었습니다.');
  await unlink(staged);
}
async function inspectFile(
  project: Project,
  file: FileChange,
  signal: AbortSignal,
): Promise<Observation> {
  signal.throwIfAborted();
  if (isCreate(file)) {
    const path = await destination(project, file.path, projectDotenv(file.path));
    try {
      await lstat(path);
    } catch (error) {
      if (absent(error)) return { path: file.path, state: 'before' };
      throw error;
    }
    const info = await lstat(path);
    if (!file.identity || file.identity !== info.dev + ':' + info.ino)
      return { path: file.path, state: 'conflict' };
    await releaseStagingLink(project, file, signal);
  }
  const hash = digest(
    await readText(project, file.path, signal, false, isCreate(file) && projectDotenv(file.path)),
  );
  return {
    path: file.path,
    state:
      hash === file.afterHash
        ? 'after'
        : !isCreate(file) && hash === file.beforeHash
          ? 'before'
          : 'conflict',
  };
}
async function inspectSet(
  project: Project,
  changes: ChangeSet,
  signal: AbortSignal,
): Promise<ChangeSet> {
  const observations: Observation[] = [];
  for (const file of changes.files) {
    try {
      observations.push(await inspectFile(project, file, signal));
    } catch (error) {
      signal.throwIfAborted();
      observations.push({
        path: file.path,
        state: error instanceof AppError ? 'conflict' : 'unknown',
      });
    }
  }
  const states = observations.map((o) => o.state);
  const status = states.includes('unknown')
    ? 'uncertain'
    : states.includes('conflict')
      ? 'conflict'
      : states.every((s) => s === 'after')
        ? 'applied'
        : states.every((s) => s === 'before')
          ? changes.operation === 'undo' || changes.status === 'reverted'
            ? 'reverted'
            : 'proposed'
          : 'partial';
  return { ...changes, status, observations };
}
export async function checkChanges(
  project: Project,
  changes: ChangeSet,
  signal: AbortSignal,
): Promise<ChangeSet> {
  return withProjectWrite(project, () => inspectSet(project, changes, signal));
}

async function createFile(
  project: Project,
  file: CreatedFileProposal,
  signal: AbortSignal,
  recordIdentity?: (file: CreatedFileProposal) => Promise<void>,
) {
  const allowProjectDotenv = projectDotenv(file.path);
  const path = await destination(project, file.path, allowProjectDotenv);
  const staged = temporary(path, file);
  if (digest(file.content) !== file.afterHash)
    throw new AppError('EDIT_INVALID', '생성 내용의 해시가 일치하지 않습니다.');
  // wx never truncates a leftover staging file. A partial staging write is kept
  // for inspection instead of overwriting bytes whose outcome is uncertain.
  let handle;
  try {
    handle = await open(staged, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const info = await lstat(staged);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 48000)
      throw new AppError(
        'CREATE_STAGING',
        '기존 임시 파일을 확인할 수 없습니다. 새 변경안을 만들어 주세요.',
      );
    handle = await open(staged, 'r');
    try {
      const opened = await handle.stat();
      if (
        opened.ino !== info.ino ||
        opened.dev !== info.dev ||
        digest(await handle.readFile('utf8')) !== file.afterHash
      )
        throw new AppError(
          'CREATE_STAGING',
          '중단된 임시 파일이 불완전합니다. 새 변경안을 만들어 주세요.',
        );
    } finally {
      await handle.close();
    }
    handle = undefined;
  }
  if (handle) {
    try {
      await handle.writeFile(file.content, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
  const stagedInfo = await lstat(staged);
  if (!stagedInfo.isFile() || stagedInfo.isSymbolicLink() || stagedInfo.nlink !== 1)
    throw new AppError('CREATE_STAGING', '임시 파일이 교체되었습니다.');
  file.identity = stagedInfo.dev + ':' + stagedInfo.ino;
  // Persist the inode before publication. Matching bytes alone cannot authorize
  // undo to delete a file independently created by the user.
  await recordIdentity?.(file);
  signal.throwIfAborted();
  if ((await destination(project, file.path, allowProjectDotenv)) !== path)
    throw new AppError('PROJECT_MOVED', '대상 폴더가 변경되었습니다.');
  // Hard-link publication is atomic for this file and fails if any target exists.
  // No rename fallback: it could overwrite a concurrently created user file.
  try {
    await link(staged, path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST')
      throw new AppError('EDIT_CONFLICT', '새 파일 경로가 생겼습니다. 덮어쓰지 않았습니다.', 409);
    throw new AppError(
      'CREATE_LINK',
      '이 파일 시스템에서 파일을 안전하게 게시할 수 없습니다. 하드 링크 지원과 권한을 확인하세요.',
    );
  }
  await releaseStagingLink(project, file, signal);
}
async function removeCreatedFile(project: Project, file: CreatedFileProposal, signal: AbortSignal) {
  const allowProjectDotenv = projectDotenv(file.path);
  const before = await resolveTarget(project, file.path, allowProjectDotenv);
  if (file.identity !== before.info.dev + ':' + before.info.ino)
    throw new AppError('EDIT_CONFLICT', '다른 파일로 교체되어 삭제하지 않았습니다.', 409);
  if (
    digest(await readText(project, file.path, signal, false, allowProjectDotenv)) !== file.afterHash
  )
    throw new AppError('EDIT_CONFLICT', '생성 후 변경된 파일은 삭제하지 않습니다.', 409);
  const current = await resolveTarget(project, file.path, allowProjectDotenv);
  if (
    before.path !== current.path ||
    before.info.ino !== current.info.ino ||
    before.info.dev !== current.info.dev
  )
    throw new AppError('EDIT_CONFLICT', '되돌리는 동안 파일이 교체되었습니다.', 409);
  signal.throwIfAborted();
  await unlink(current.path);
}

export async function writeChanges(
  project: Project,
  changes: ChangeSet,
  operation: 'apply' | 'undo',
  signal: AbortSignal,
  recordIdentity?: (file: CreatedFileProposal) => Promise<void>,
): Promise<void> {
  return withProjectWrite(project, async () => {
    const inspected = await inspectSet(project, changes, signal);
    if (inspected.observations!.some((o) => o.state === 'conflict' || o.state === 'unknown'))
      throw new AppError(
        'EDIT_CONFLICT',
        '묶음에 충돌하거나 확인할 수 없는 파일이 있어 변경을 시작하지 않았습니다.',
        409,
      );
    const files = operation === 'undo' ? [...changes.files].reverse() : changes.files;
    for (const file of files) {
      const observation = await inspectFile(project, file, signal);
      const target = operation === 'undo' ? 'before' : 'after';
      if (observation.state === target) continue;
      if (!['before', 'after'].includes(observation.state))
        throw new AppError(
          'EDIT_CONFLICT',
          '처리 중 파일이 변경되었습니다. 파일별 상태를 확인하세요.',
          409,
        );
      if (isCreate(file)) {
        if (operation === 'apply') await createFile(project, file, signal, recordIdentity);
        else await removeCreatedFile(project, file, signal);
      } else await writeEditUnlocked(project, file, signal, operation);
    }
  });
}
