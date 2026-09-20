import { createHash, randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { AppError, type ToolDefinition } from '@lodex/contracts';
import { z } from 'zod';

const absolutePath = z.string().min(1).max(4096).refine(isAbsolute, '절대 경로가 필요합니다.');
const listSchema = z.strictObject({ path: absolutePath });
const readSchema = z.strictObject({ path: absolutePath });
const writeSchema = z.strictObject({
  path: absolutePath,
  expectedHash: z.union([z.string().regex(/^[a-f0-9]{64}$/), z.null()]),
  content: z.string().max(1_048_576),
});

export const hostFileTools: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'host_list_files',
      description:
        'FULL ACCESS ONLY. List one absolute host directory, including locations outside the selected project. Returns at most 500 entries and does not recurse.',
      parameters: z.toJSONSchema(listSchema),
    },
  },
  {
    type: 'function',
    function: {
      name: 'host_read_file',
      description:
        'FULL ACCESS ONLY. Read one UTF-8 host file by absolute path, including secret files and files outside the selected project. Returns a SHA-256 hash for safe later writes. Maximum 1 MiB.',
      parameters: z.toJSONSchema(readSchema),
    },
  },
  {
    type: 'function',
    function: {
      name: 'host_write_file',
      description:
        'FULL ACCESS BUILD ONLY. Atomically create or replace a UTF-8 host file by absolute path. Pass the SHA-256 returned by host_read_file for an existing file, or null only when creating a new file. Concurrent changes are rejected.',
      parameters: z.toJSONSchema(writeSchema),
    },
  },
];

const digest = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');

async function readBounded(path: string): Promise<Buffer> {
  const info = await stat(path);
  if (!info.isFile()) throw new AppError('HOST_FILE', '일반 파일만 읽을 수 있습니다.');
  if (info.size > 1_048_576)
    throw new AppError('HOST_FILE_SIZE', '1 MiB 이하 파일만 읽을 수 있습니다.');
  const bytes = await readFile(path);
  if (bytes.includes(0))
    throw new AppError('HOST_FILE_BINARY', 'UTF-8 텍스트 파일만 읽을 수 있습니다.');
  return bytes;
}

export async function runHostFileTool(
  name: string,
  argumentsJson: string,
  mode: 'plan' | 'build',
): Promise<string> {
  if (name === 'host_list_files') {
    const input = listSchema.parse(JSON.parse(argumentsJson));
    const path = await realpath(input.path);
    const all = await readdir(path, { withFileTypes: true });
    const entries = all.slice(0, 500);
    return JSON.stringify({
      path,
      truncated: all.length > entries.length,
      entries: entries.map((entry) => ({
        name: entry.name,
        type: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other',
      })),
    });
  }
  if (name === 'host_read_file') {
    const input = readSchema.parse(JSON.parse(argumentsJson));
    const path = await realpath(input.path);
    const bytes = await readBounded(path);
    return JSON.stringify({
      path,
      sha256: digest(bytes),
      bytes: bytes.length,
      content: bytes.toString('utf8'),
    });
  }
  if (name !== 'host_write_file')
    throw new AppError('HOST_TOOL', '알 수 없는 호스트 파일 도구입니다.');
  if (mode !== 'build')
    throw new AppError('PLAN_READ_ONLY', 'Plan 모드에서는 파일을 변경할 수 없습니다.', 403);
  const input = writeSchema.parse(JSON.parse(argumentsJson));
  await mkdir(dirname(input.path), { recursive: true });
  const parent = await realpath(dirname(input.path));
  const requested = join(parent, basename(input.path));
  let target = requested;
  let current: Buffer | null = null;
  try {
    const link = await lstat(requested);
    target = link.isSymbolicLink() ? await realpath(requested) : requested;
    current = await readBounded(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (current === null && input.expectedHash !== null)
    throw new AppError(
      'HOST_FILE_CONFLICT',
      '파일이 없어 기존 파일 해시와 일치하지 않습니다.',
      409,
    );
  if (current !== null && digest(current) !== input.expectedHash)
    throw new AppError(
      'HOST_FILE_CONFLICT',
      '파일이 읽은 뒤 변경되었습니다. 다시 읽어 주세요.',
      409,
    );
  const temporary = join(dirname(target), `.lodex-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, input.content, { encoding: 'utf8', flag: 'wx' });
    const latest = await readFile(target).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if ((latest === null ? null : digest(latest)) !== input.expectedHash)
      throw new AppError(
        'HOST_FILE_CONFLICT',
        '파일이 쓰기 직전에 변경되었습니다. 다시 읽어 주세요.',
        409,
      );
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
  const written = Buffer.from(input.content);
  return JSON.stringify({
    status: 'written',
    path: target,
    sha256: digest(written),
    bytes: written.length,
  });
}
