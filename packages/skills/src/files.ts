import { createHash } from 'node:crypto';
import type { BigIntStats } from 'node:fs';
import { lstat, open, opendir, realpath } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { AppError } from '@lodex/contracts';
import type { RegisteredSkill, SkillDiagnostic, SkillFile } from './types';

export const SKILL_LIMITS = Object.freeze({
  entryBytes: 128 * 1024,
  metadataBytes: 32 * 1024,
  resourceBytes: 1024 * 1024,
  inventoryBytes: 64 * 1024 * 1024,
  entries: 512,
  depth: 8,
  catalogBytes: 16 * 1024,
});

const excludedDirectories = new Set([
  '.git',
  '.ssh',
  '.aws',
  '.gnupg',
  'secrets',
  'credentials',
  'node_modules',
  '.venv',
  'venv',
  'target',
  'dist',
  'build',
]);
export const blockedName = (name: string) =>
  excludedDirectories.has(name.toLowerCase()) ||
  ['secrets.json', 'credentials.json'].includes(name.toLowerCase()) ||
  /^\.env(?:\.|$)|\.(?:pem|key|p12|pfx)$/i.test(name);
export const hash = (bytes: string | Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex');
export const identity = (info: BigIntStats) => `${info.dev}:${info.ino}`;
const fingerprint = (info: BigIntStats) =>
  `${identity(info)}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;

export function cleanRelative(path: string): string {
  if (
    typeof path !== 'string' ||
    !path ||
    path.length > 4096 ||
    isAbsolute(path) ||
    path.startsWith('\\') ||
    path.includes(':') ||
    /[\x00-\x1f\x7f]/.test(path)
  )
    throw new AppError('SKILL_PATH', '스킬 폴더 내부 상대 경로가 필요합니다.');
  const parts = path.split(/[\\/]/);
  if (
    parts.some(
      (part) =>
        !part ||
        part === '.' ||
        part === '..' ||
        /[. ]$/.test(part) ||
        blockedName(part) ||
        /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
    )
  )
    throw new AppError('SKILL_PATH', '상위 경로·비밀 파일·제외 경로는 읽을 수 없습니다.');
  if (parts.length > SKILL_LIMITS.depth)
    throw new AppError('SKILL_DEPTH', '스킬 리소스 경로의 깊이 제한을 초과했습니다.');
  return parts.join('/');
}

export async function inspectRoot(path: string): Promise<RegisteredSkill['source']> {
  if (
    typeof path !== 'string' ||
    !isAbsolute(path) ||
    path.length > 4096 ||
    /[\x00-\x1f\x7f]/.test(path)
  )
    throw new AppError('SKILL_ROOT', '등록할 스킬 폴더의 절대 경로가 필요합니다.');
  const given = await lstat(resolve(path), { bigint: true });
  if (given.isSymbolicLink() || !given.isDirectory() || blockedName(basename(path)))
    throw new AppError('SKILL_ROOT', '일반 스킬 폴더를 선택하세요. 링크 폴더는 지원하지 않습니다.');
  const canonical = await realpath(path);
  const info = await lstat(canonical, { bigint: true });
  if (!info.isDirectory() || identity(info) !== identity(given))
    throw new AppError('SKILL_CHANGED', '스킬 폴더가 검사 도중 변경되었습니다.');
  return { rootPath: canonical, rootIdentity: identity(info), rootName: basename(canonical) };
}

export async function checkRoot(source: RegisteredSkill['source']) {
  const canonical = await realpath(source.rootPath);
  const info = await lstat(source.rootPath, { bigint: true });
  if (
    canonical !== source.rootPath ||
    info.isSymbolicLink() ||
    !info.isDirectory() ||
    identity(info) !== source.rootIdentity
  )
    throw new AppError(
      'SKILL_CHANGED',
      '등록한 스킬 폴더가 이동되거나 교체되었습니다. 다시 등록하세요.',
    );
}

async function target(source: RegisteredSkill['source'], path: string) {
  await checkRoot(source);
  const normalized = cleanRelative(path);
  let current = source.rootPath;
  for (const part of normalized.split('/')) {
    current = join(current, part);
    if ((await lstat(current, { bigint: true })).isSymbolicLink())
      throw new AppError('SKILL_PATH', '심볼릭 링크·junction 리소스는 읽을 수 없습니다.');
  }
  const canonical = await realpath(current);
  const rel = relative(source.rootPath, canonical);
  if (rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel))
    throw new AppError('SKILL_PATH', '등록된 스킬 폴더 밖의 경로입니다.');
  return { path: canonical, info: await lstat(canonical, { bigint: true }) };
}

function kind(path: string): SkillFile['kind'] {
  if (path === 'SKILL.md') return 'instructions';
  if (path === 'agents/openai.yaml') return 'metadata';
  if (path.startsWith('scripts/') || /\.(?:py|sh|bash|ps1|cmd|bat|js|mjs|cjs|exe)$/i.test(path))
    return 'script';
  if (path.startsWith('references/')) return 'reference';
  if (path.startsWith('assets/')) return 'asset';
  return 'other';
}

/** Read directory entries and stat resources, not their content. */
export async function inventory(
  source: RegisteredSkill['source'],
  diagnostics: SkillDiagnostic[],
  signal: AbortSignal,
): Promise<SkillFile[]> {
  const files: SkillFile[] = [];
  let entries = 0,
    bytes = 0;
  const walk = async (prefix: string, depth: number): Promise<void> => {
    signal.throwIfAborted();
    const checked = prefix ? await target(source, prefix) : null;
    await checkRoot(source);
    const directory = await opendir(checked?.path ?? source.rootPath);
    for await (const entry of directory) {
      signal.throwIfAborted();
      if (++entries > SKILL_LIMITS.entries)
        throw new AppError('SKILL_COUNT', '스킬 폴더의 파일·폴더 항목 제한(512개)을 초과했습니다.');
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (blockedName(entry.name)) {
        diagnostics.push({
          code: 'EXCLUDED_PATH',
          message: '비밀 파일 또는 생성 디렉터리를 제외했습니다.',
          path,
        });
        continue;
      }
      if (entry.isSymbolicLink()) {
        diagnostics.push({
          code: 'EXCLUDED_LINK',
          message: '링크 파일 또는 폴더를 제외했습니다.',
          path,
        });
        continue;
      }
      if (depth > SKILL_LIMITS.depth)
        throw new AppError('SKILL_DEPTH', '스킬 폴더의 깊이 제한(8단계)을 초과했습니다.');
      const found = await target(source, path);
      if (found.info.isDirectory()) await walk(path, depth + 1);
      else if (found.info.isFile() && found.info.nlink === 1n) {
        bytes += Number(found.info.size);
        if (bytes > SKILL_LIMITS.inventoryBytes)
          throw new AppError(
            'SKILL_SIZE',
            '등록할 스킬 리소스의 전체 크기 제한(64 MiB)을 초과했습니다.',
          );
        files.push({
          path,
          bytes: Number(found.info.size),
          identity: identity(found.info),
          fingerprint: fingerprint(found.info),
          kind: kind(path),
        });
      } else
        diagnostics.push({
          code: 'EXCLUDED_FILE',
          message: '일반 단일 링크 파일이 아니어서 제외했습니다.',
          path,
        });
    }
  };
  await walk('', 1);
  await checkRoot(source);
  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** Containment and identity checks, not an OS sandbox against hostile local processes. */
export async function readRegisteredFile(
  source: RegisteredSkill['source'],
  file: SkillFile,
  limit: number,
  signal: AbortSignal,
): Promise<{ text: string; sha256: string; bytes: number }> {
  signal.throwIfAborted();
  const found = await target(source, file.path);
  if (!found.info.isFile() || found.info.nlink !== 1n)
    throw new AppError('SKILL_FILE', '일반 단일 링크 텍스트 파일만 읽을 수 있습니다.');
  if (found.info.size > BigInt(limit))
    throw new AppError(
      'SKILL_SIZE',
      `스킬 파일 크기가 읽기 제한(${limit} bytes)을 초과했습니다. 본문을 생략하지 않았습니다.`,
    );
  if (fingerprint(found.info) !== file.fingerprint)
    throw new AppError('SKILL_CHANGED', '등록 이후 스킬 파일이 변경되었습니다. 다시 등록하세요.');
  const handle = await open(found.path, 'r');
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n || fingerprint(before) !== file.fingerprint)
      throw new AppError('SKILL_CHANGED', '스킬 파일이 읽기 도중 교체되었습니다.');
    const bytes = Buffer.alloc(limit + 1);
    let total = 0;
    while (total < bytes.length) {
      signal.throwIfAborted();
      const { bytesRead } = await handle.read(bytes, total, bytes.length - total, total);
      if (!bytesRead) break;
      total += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    const resolved = await target(source, file.path);
    if (fingerprint(after) !== file.fingerprint || fingerprint(resolved.info) !== file.fingerprint)
      throw new AppError('SKILL_CHANGED', '스킬 파일이 읽기 도중 변경되었습니다.');
    if (total > limit)
      throw new AppError('SKILL_SIZE', '스킬 파일의 읽기 크기 제한을 초과했습니다.');
    const contents = bytes.subarray(0, total);
    if (contents.includes(0))
      throw new AppError('SKILL_ENCODING', 'UTF-8 텍스트 리소스만 지원합니다.');
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(contents);
    } catch {
      throw new AppError('SKILL_ENCODING', '올바른 UTF-8 텍스트가 아닙니다.');
    }
    return { text, bytes: total, sha256: hash(contents) };
  } finally {
    await handle.close();
  }
}

export async function hasCompanion(source: RegisteredSkill['source']): Promise<boolean> {
  try {
    await target(source, 'agents/openai.yaml');
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
