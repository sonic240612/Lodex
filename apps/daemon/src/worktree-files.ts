import { createHash, randomUUID } from 'node:crypto';
import { open, lstat, mkdir, rename, link, unlink } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { AppError, type Project } from '@lodex/contracts';
import { resolveTarget } from '@lodex/tools';

export const MAX_WORKTREE_BYTES = 16 * 1024 * 1024;
export const MAX_WORKTREE_TEXT = 2 * 1024 * 1024;
export const byteHash = (bytes: Uint8Array | null) =>
  bytes === null ? null : createHash('sha256').update(bytes).digest('hex');
const identity = (info: { dev: bigint; ino: bigint }) => info.dev + ':' + info.ino;
export function decodeText(bytes: Buffer | null): string | null | undefined {
  if (bytes === null) return null;
  if (bytes.includes(0)) return undefined;
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return undefined;
  }
}
export async function readWorktreeFile(project: Project, path: string, signal: AbortSignal) {
  signal.throwIfAborted();
  let target;
  try {
    target = await resolveTarget(project, path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { bytes: null, identity: null };
    throw error;
  }
  const exact = await lstat(target.path, { bigint: true });
  if (
    !exact.isFile() ||
    exact.isSymbolicLink() ||
    exact.nlink !== 1n ||
    exact.size > BigInt(MAX_WORKTREE_BYTES)
  )
    throw new AppError(
      'WORKTREE_FILE',
      '16 MiB 이하의 일반 파일만 검토합니다. 링크와 특수 파일은 지원하지 않습니다.',
    );
  const handle = await open(target.path, 'r');
  try {
    const before = await handle.stat({ bigint: true });
    if (identity(before) !== identity(exact) || before.nlink !== 1n)
      throw new AppError('WORKTREE_STALE', '파일이 교체되었습니다.', 409);
    const buffer = Buffer.alloc(Math.min(MAX_WORKTREE_BYTES + 1, Number(before.size) + 1));
    let size = 0;
    while (size < buffer.length) {
      signal.throwIfAborted();
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, size);
      if (!bytesRead) break;
      size += bytesRead;
    }
    const after = await handle.stat({ bigint: true }),
      current = await resolveTarget(project, path);
    if (
      identity(after) !== identity(await lstat(current.path, { bigint: true })) ||
      after.nlink !== 1n ||
      BigInt(size) !== before.size ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs
    )
      throw new AppError('WORKTREE_STALE', '읽는 동안 파일이 변경되었습니다.', 409);
    return { bytes: buffer.subarray(0, size), identity: identity(after) };
  } finally {
    await handle.close();
  }
}

// Caller holds withProjectWrite for the entire transaction. Publication follows
// the same inode/hash checks as ordinary edits; creation never replaces a file.
export async function replaceWorktreeFile(
  project: Project,
  path: string,
  expectedHash: string | null,
  expectedIdentity: string | null,
  next: Buffer | null,
  signal: AbortSignal,
) {
  const before = await readWorktreeFile(project, path, signal);
  if (byteHash(before.bytes) !== expectedHash || before.identity !== expectedIdentity)
    throw new AppError('WORKTREE_STALE', '검토 후 파일의 내용이나 소유권이 변경되었습니다.', 409);
  if (byteHash(next) === expectedHash) return before.identity;
  const parentParts = dirname(path).replaceAll('\\', '/').split('/');
  let folder = '';
  for (const part of parentParts) {
    if (part === '.') continue;
    folder = folder ? folder + '/' + part : part;
    try {
      await resolveTarget(project, folder);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = await resolveTarget(project, dirname(folder));
      await mkdir(join(parent.path, part), { mode: 0o755 });
      await resolveTarget(project, folder);
    }
  }
  const parent = await resolveTarget(project, dirname(path)),
    target = join(parent.path, path.replaceAll('\\', '/').split('/').at(-1)!);
  const parentIdentity = identity(await lstat(parent.path, { bigint: true }));
  const recheck = async () => {
    const currentParent = await resolveTarget(project, dirname(path));
    const current = await readWorktreeFile(project, path, signal);
    if (
      identity(await lstat(currentParent.path, { bigint: true })) !== parentIdentity ||
      byteHash(current.bytes) !== expectedHash ||
      current.identity !== expectedIdentity
    )
      throw new AppError('WORKTREE_STALE', '적용 도중 파일이나 상위 폴더가 변경되었습니다.', 409);
    signal.throwIfAborted();
  };
  if (next === null) {
    await recheck();
    await unlink(target);
    return null;
  }
  if (next.length > MAX_WORKTREE_BYTES)
    throw new AppError('WORKTREE_FILE', '파일이 16 MiB를 초과합니다.');
  const temporary = join(parent.path, '.lodex-worktree-' + randomUUID() + '.tmp');
  const handle = await open(temporary, 'wx', 0o600);
  let published = false;
  try {
    try {
      await handle.writeFile(next);
      if (before.bytes !== null) {
        const current = await resolveTarget(project, path);
        if (!(current.info.mode & 0o222))
          throw new AppError('EDIT_READ_ONLY', '읽기 전용 파일은 수정할 수 없습니다.');
        await handle.chmod(current.info.mode & 0o777);
      }
      await handle.sync();
    } finally {
      await handle.close();
    }
    const staged = await lstat(temporary);
    if (!staged.isFile() || staged.isSymbolicLink() || staged.nlink !== 1)
      throw new AppError('WORKTREE_STALE', '임시 파일이 교체되었습니다.', 409);
    await recheck();
    if (before.bytes === null) {
      await link(temporary, target);
      await unlink(temporary);
    } else await rename(temporary, target);
    published = true;
    return (await readWorktreeFile(project, path, signal)).identity;
  } finally {
    if (!published) {
      const currentParent = await resolveTarget(
        project,
        relative(project.path, parent.path) || '.',
      );
      if (identity(await lstat(currentParent.path, { bigint: true })) === parentIdentity)
        await unlink(temporary).catch(() => undefined);
    }
  }
}
