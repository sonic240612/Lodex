import { createHash, randomUUID } from 'node:crypto';
import type { Stats } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
} from 'node:fs/promises';
import { basename, dirname, isAbsolute, join } from 'node:path';
import {
  AppError,
  fusionFields,
  normalizeFusedCommand,
  type ToolDefinition,
} from '@lodex/contracts';
import { z } from 'zod';

const absolutePath = z
  .string()
  .min(1)
  .max(4096)
  .refine(isAbsolute, '절대 경로가 필요합니다.')
  .describe('Absolute host path.');
const listSchema = z.strictObject({ path: absolutePath });
const readSchema = z.strictObject({ path: absolutePath });
const writeSchema = z.strictObject({
  path: absolutePath,
  expectedHash: z
    .union([z.string().regex(/^[a-f0-9]{64}$/), z.null()])
    .describe('Current sha256 from host read/write; null ONLY for nonexistent files.'),
  content: z
    .string()
    .max(1_048_576)
    .describe(
      'COMPLETE UTF-8 content, preserving unrelated text and line endings. Not a patch. Empty clears.',
    ),
  ...fusionFields,
});

export function hostWriteInput(argumentsJson: string) {
  const input = writeSchema.parse(JSON.parse(argumentsJson));
  const thenRun = normalizeFusedCommand(input);
  return { ...input, ...(thenRun ? { thenRun } : {}) };
}

export const hostFileTools: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'host_list_files',
      description: 'FULL ACCESS ONLY. List an absolute host directory, at most 500 direct entries.',
      parameters: z.toJSONSchema(listSchema),
    },
  },
  {
    type: 'function',
    function: {
      name: 'host_read_file',
      description:
        'FULL ACCESS ONLY. Read any UTF-8 host file, including secrets, with sha256. Maximum 1 MiB.',
      parameters: z.toJSONSchema(readSchema),
    },
  },
  {
    type: 'function',
    function: {
      name: 'host_write_file',
      description:
        'FULL ACCESS BUILD ONLY. Atomic whole-file write; first host_read_file. Creates parents. New-file example: {"path":"/absolute/new.txt","expectedHash":null,"content":"hello\\n"}. Use actual host path. thenRun runs a known host command; conflicts skip it, failures keep the file.',
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
  const input = hostWriteInput(argumentsJson);
  await mkdir(dirname(input.path), { recursive: true });
  const parent = await realpath(dirname(input.path));
  const requested = join(parent, basename(input.path));
  let target = requested;
  let current: Buffer | null = null;
  let original: Stats | undefined;
  try {
    const link = await lstat(requested);
    target = link.isSymbolicLink() ? await realpath(requested) : requested;
    original = await stat(target);
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
    // Keep new and in-progress secret files private regardless of the process umask.
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(input.content, 'utf8');
      if (original && process.platform !== 'win32') {
        const created = await handle.stat();
        if (created.uid !== original.uid || created.gid !== original.gid)
          await handle.chown(original.uid, original.gid);
        await handle.chmod(original.mode & 0o777);
      }
      await handle.sync();
    } finally {
      await handle.close();
    }
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
    if (original) {
      const metadata = await lstat(target);
      if (
        metadata.isSymbolicLink() ||
        metadata.dev !== original.dev ||
        metadata.ino !== original.ino ||
        metadata.mode !== original.mode ||
        metadata.uid !== original.uid ||
        metadata.gid !== original.gid
      )
        throw new AppError(
          'HOST_FILE_CONFLICT',
          '파일 또는 접근 권한이 변경되었습니다. 다시 읽어 주세요.',
          409,
        );
    }
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
