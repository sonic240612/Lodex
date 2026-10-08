import { lstat, realpath, opendir, open, rename, unlink } from 'node:fs/promises';
import { isAbsolute, join, relative, basename, dirname, resolve, sep } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { z } from 'zod';
import {
  AppError,
  type Project,
  type ToolDefinition,
  type EditProposal,
  type ChangeSet,
  fusionFields,
  normalizeFusedCommand,
} from '@lodex/contracts';
import { createTwoFilesPatch } from 'diff';
import { proposeChanges, changeInputSchema } from './changes';
import { pathOperationSchemas, runPathOperation } from './path-operations';
import { editFields } from './file-inputs';
export { proposeChanges, checkChanges, writeChanges } from './changes';
export {
  type InputControl,
  executeCommand,
  executeHostCommand,
  cleanupExecution,
  inspectDocker,
  executionTool,
  hostExecutionTool,
} from './execution';
export { hostFileTools, runHostFileTool, hostWriteInput } from './host-files';
export { webFetchTool, fetchWebPage } from './web';
export { webSearchTool, searchWeb } from './web-search';
export { BrowserSession, browserTool, browserActionSchema } from './browser';
export { readProjectInstructions, type ProjectInstructions } from './instructions';
export {
  withFusedFileQueue,
  assertUnchangedBeforeCommand,
  THEN_RUN_SUCCEEDED,
  THEN_RUN_FAILED,
  THEN_RUN_SKIPPED,
} from './action-fusion';

const MAX_FILE = 1024 * 1024;
const ignored = new Set([
  '.git',
  '.ssh',
  '.aws',
  'secrets',
  'credentials',
  '.gnupg',
  '.codex',
  'node_modules',
  '.venv',
  'venv',
  'target',
  'dist',
  'build',
]);
const blocked = (name: string) =>
  ignored.has(name.toLowerCase()) ||
  ['secrets.json', 'credentials.json'].includes(name.toLowerCase()) ||
  /^\.env(?:\.|$)|^\.lodex-edit-|\.(?:pem|key|p12|pfx)$/i.test(name);
const dotenvName = (name: string) => /^\.env(?:\.|$)/i.test(name);
const pathSchema = z.string().min(1).max(4096).default('.');
const schemas = {
  ...pathOperationSchemas,
  propose_changes: changeInputSchema,
  propose_edit: z.strictObject({
    ...editFields,
    path: editFields.path.default('.'),
    ...fusionFields,
  }),
  list_files: z.strictObject({ path: pathSchema }),
  find_files: z.strictObject({
    path: pathSchema,
    pattern: z.string().min(1).max(200),
    maxResults: z.number().int().min(1).max(500).default(200),
  }),
  read_file: z.strictObject({
    path: pathSchema,
    startLine: z.number().int().min(1).default(1),
    maxLines: z.number().int().min(1).max(300).default(150),
  }),
  read_many_files: z.strictObject({
    files: z
      .array(
        z.strictObject({
          path: pathSchema,
          startLine: z.number().int().min(1).default(1),
          maxLines: z.number().int().min(1).max(300).default(150),
        }),
      )
      .min(1)
      .max(20),
    maxTotalBytes: z.number().int().min(1024).max(48000).default(32000),
  }),
  search_text: z.strictObject({
    path: pathSchema,
    query: z.string().min(1).max(200),
    maxResults: z.number().int().min(1).max(100).default(30),
    caseSensitive: z.boolean().default(true),
  }),
};
const descriptions: Record<keyof typeof schemas, string> = {
  inspect_path:
    'Inspect before move/delete; returns fingerprint, kind and counts (max 2,000 entries/32 MiB). Excludes secret, generated, linked and project-root paths.',
  make_directory: 'Create one reviewed project directory. Parent must exist; never overwrites.',
  move_path:
    'Reviewed project move using inspect_path fingerprint. Destination must not exist; parent must exist. Never overwrites.',
  delete_path:
    'Delete using inspect_path fingerprint. Nonempty directories need recursive=true. Destructive: requires user review except in Full Access.',
  propose_changes:
    'Reviewed UTF-8 changes, at most 1 MiB/file; no text-field cap. edit follows propose_edit. Create example: {"files":[{"kind":"create","path":"src/new.ts","content":"hello\\n"}]}. Missing parents: make_directory, one level at a time. Root dotenv creation allowed; existing dotenv blocked. Optional thenRun validates after write; failure keeps edits. No deletion.',
  propose_edit:
    'Reviewed exact replacement. Example: expectedHash=read.sha256, oldText="n=1", newText="n=2". Add context around repeated anchors. Reuse current Plan reads. Preserves CRLF; mixed endings need single-line anchors. New files: propose_changes. Optional thenRun validates after write; failure keeps edits.',
  list_files: 'List at most 200 direct project-directory entries. Start with path ".".',
  find_files:
    'Find project-relative paths by glob, e.g. "**/*.ts" (max 500). Excludes generated, secret and linked paths.',
  read_file:
    'Read UTF-8 project lines and whole-file sha256. lines[].text excludes numbering. bytes=0: empty; complete=false: partial; lineEnding: lf/crlf/mixed/none.',
  read_many_files:
    'Batch read_file for known paths with a shared budget. Each file has its own hash. Check skipped/truncated; request missing ranges separately.',
  search_text:
    'Literal UTF-8 project search, not regex; returns bounded line matches. Excludes generated and secret files.',
};
export const projectTools: ToolDefinition[] = Object.entries(schemas).map(([name, schema]) => ({
  type: 'function',
  function: {
    name,
    description: descriptions[name as keyof typeof schemas],
    parameters: z.toJSONSchema(schema),
  },
}));

export const projectReadToolNames = [
  'inspect_path',
  'list_files',
  'find_files',
  'read_file',
  'read_many_files',
  'search_text',
] as const;
export const isProjectReadTool = (name: string) =>
  (projectReadToolNames as readonly string[]).includes(name);

export async function inspectProject(path: unknown): Promise<Project> {
  if (typeof path !== 'string' || !path.trim() || path.length > 4096 || !isAbsolute(path))
    throw new AppError('PROJECT_PATH', '프로젝트 폴더의 절대 경로가 필요합니다.');
  try {
    const canonical = await realpath(path);
    const info = await lstat(canonical);
    if (!info.isDirectory()) throw new Error('Not a directory');
    return {
      id: randomUUID(),
      name: basename(canonical) || canonical,
      path: canonical,
      identity: info.dev + ':' + info.ino,
      createdAt: new Date().toISOString(),
    };
  } catch {
    throw new AppError(
      'PROJECT_PATH',
      '프로젝트 폴더를 열 수 없습니다. 경로와 접근 권한을 확인하세요.',
    );
  }
}

/** Filesystem containment checks, not a hostile-process OS sandbox. */
export async function resolveTarget(project: Project, path: string, allowProjectDotenv = false) {
  if (isAbsolute(path) || path.includes(':') || /[\x00-\x1f\x7f]/.test(path))
    throw new AppError('PATH_DENIED', '프로젝트 내부 상대 경로만 사용할 수 있습니다.');
  const parts = path.split(/[\\/]/).filter((p) => p && p !== '.');
  if (
    parts.some(
      (p, index) =>
        p === '..' ||
        /[. ]$/.test(p) ||
        /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p) ||
        (blocked(p) && !(allowProjectDotenv && parts.length === 1 && index === 0 && dotenvName(p))),
    )
  )
    throw new AppError('PATH_DENIED', '상위 폴더·제외 폴더·비밀 파일에는 접근할 수 없습니다.');
  const root = await realpath(project.path);
  const rootInfo = await lstat(root);
  if (root !== project.path || rootInfo.dev + ':' + rootInfo.ino !== project.identity)
    throw new AppError('PROJECT_MOVED', '등록한 프로젝트 폴더가 이동되거나 교체되었습니다.');
  let current = root;
  for (const part of parts) {
    current = join(current, part);
    if ((await lstat(current)).isSymbolicLink())
      throw new AppError('PATH_DENIED', '심볼릭 링크·junction을 통한 접근은 지원하지 않습니다.');
  }
  const canonical = await realpath(current);
  const rel = relative(root, canonical);
  const relativeParts = rel.split(/[\\/]/);
  if (
    relativeParts.some(
      (part, index) =>
        blocked(part) &&
        !(allowProjectDotenv && relativeParts.length === 1 && index === 0 && dotenvName(part)),
    )
  )
    throw new AppError('PATH_DENIED', '제외된 경로에는 접근할 수 없습니다.');
  if (rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel))
    throw new AppError('PATH_DENIED', '프로젝트 밖의 경로입니다.');
  return { path: canonical, info: await lstat(canonical) };
}
export async function readText(
  project: Project,
  path: string,
  signal: AbortSignal,
  allowStagingLink = false,
  allowProjectDotenv = false,
): Promise<string> {
  signal.throwIfAborted();
  const target = await resolveTarget(project, path, allowProjectDotenv);
  if (
    !target.info.isFile() ||
    (target.info.nlink > 1 && !allowStagingLink) ||
    target.info.size > MAX_FILE
  )
    throw new AppError('FILE_UNSUPPORTED', '1 MiB 이하의 일반 텍스트 파일만 지원합니다.');
  const handle = await open(target.path, 'r');
  try {
    const info = await handle.stat();
    if (
      !info.isFile() ||
      info.ino !== target.info.ino ||
      info.dev !== target.info.dev ||
      (info.nlink > 1 && !allowStagingLink)
    )
      throw new AppError('FILE_CHANGED', '파일이 읽기 도중 변경되었습니다.');
    const bytes = Buffer.alloc(MAX_FILE + 1);
    let total = 0;
    while (total < bytes.length) {
      signal.throwIfAborted();
      const { bytesRead } = await handle.read(bytes, total, bytes.length - total, total);
      if (!bytesRead) break;
      total += bytesRead;
    }
    const resolvedAfter = await resolveTarget(project, path, allowProjectDotenv);
    if (resolvedAfter.info.ino !== info.ino || resolvedAfter.info.dev !== info.dev)
      throw new AppError('FILE_CHANGED', '읽는 동안 파일이 교체되었습니다.');
    const after = await handle.stat();
    if (after.size !== target.info.size || after.mtimeMs !== target.info.mtimeMs)
      throw new AppError('FILE_CHANGED', '파일이 읽기 도중 변경되었습니다. 다시 읽어 주세요.');
    if (total > MAX_FILE || bytes.subarray(0, total).includes(0))
      throw new AppError('FILE_UNSUPPORTED', '파일이 너무 크거나 텍스트 형식이 아닙니다.');
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      bytes.subarray(0, total),
    );
  } finally {
    await handle.close();
  }
}
export const digest = (text: string) => createHash('sha256').update(text).digest('hex');
function selectLineRange(text: string, startLine: number, maxLines: number, maxBytes: number) {
  const all = text.split(/\r?\n/);
  const lines: { line: number; text: string }[] = [];
  let bytes = 0;
  for (let index = startLine - 1; index < Math.min(all.length, startLine - 1 + maxLines); index++) {
    const value = all[index]!;
    const size = Buffer.byteLength(value);
    if (bytes + size > maxBytes) break;
    bytes += size;
    lines.push({ line: index + 1, text: value });
  }
  return {
    totalLines: all.length,
    lines,
    bytes,
    truncated: startLine - 1 + lines.length < all.length,
  };
}
function readMetadata(text: string, startLine: number, truncated: boolean) {
  const crlf = text.includes('\r\n');
  const lf = /(?<!\r)\n/.test(text);
  return {
    bytes: Buffer.byteLength(text),
    lineEnding: crlf ? (lf ? 'mixed' : 'crlf') : lf ? 'lf' : 'none',
    complete: startLine === 1 && !truncated,
  };
}
function replaceOnce(text: string, oldText: string, newText: string): string {
  const at = text.indexOf(oldText);
  if (at < 0 || (oldText ? text.indexOf(oldText, at + 1) >= 0 : text.length > 0))
    throw new AppError(
      'EDIT_MATCH',
      '수정할 텍스트는 파일에서 정확히 한 번 일치해야 합니다. 다시 읽고 범위를 지정해 주세요.',
    );
  const next = text.slice(0, at) + newText + text.slice(at + oldText.length);
  if (next === text) throw new AppError('EDIT_EMPTY', '변경 내용이 없습니다.');
  if (
    Buffer.from(next).toString('utf8') !== next ||
    next.includes('\0') ||
    Buffer.byteLength(next) > MAX_FILE
  )
    throw new AppError('FILE_UNSUPPORTED', '수정 결과는 1 MiB 이하의 UTF-8 텍스트여야 합니다.');
  return next;
}
export async function proposeEdit(
  project: Project,
  input: unknown,
  signal: AbortSignal,
): Promise<EditProposal> {
  const args = schemas.propose_edit.parse(input);
  const thenRun = normalizeFusedCommand(args);
  const text = await readText(project, args.path, signal);
  if (digest(text) !== args.expectedHash)
    throw new AppError(
      'EDIT_CONFLICT',
      '파일이 변경되었습니다. 다시 읽은 뒤 수정안을 만들어 주세요.',
      409,
    );
  // Normalize a model's LF input only for files that consistently use CRLF.
  const crlf = text.includes('\r\n') && !/(?<!\r)\n/.test(text);
  const normalize = (value: string) => (crlf ? value.replace(/\r?\n/g, '\r\n') : value);
  const oldText = normalize(args.oldText),
    newText = normalize(args.newText);
  const next = replaceOnce(text, oldText, newText);
  const patch = createTwoFilesPatch('a/' + args.path, 'b/' + args.path, text, next, '', '', {
    context: 3,
    timeout: 500,
  });
  if (!patch)
    throw new AppError(
      'DIFF_LIMIT',
      '변경 비교를 만들 수 없습니다. 더 작은 수정 단위로 나누세요. 파일을 삭제하고 다시 만들지 마세요.',
    );
  return {
    path: args.path,
    beforeHash: digest(text),
    afterHash: digest(next),
    oldText,
    newText,
    diff: patch,
    status: 'proposed',
    offset: text.indexOf(oldText),
    ...(thenRun ? { thenRun } : {}),
  };
}
export async function checkEdit(
  project: Project,
  edit: EditProposal,
  signal: AbortSignal,
): Promise<'proposed' | 'applied' | 'reverted' | 'conflict'> {
  const hash = digest(await readText(project, edit.path, signal));
  return hash === edit.afterHash
    ? 'applied'
    : hash === edit.beforeHash
      ? edit.operation === 'undo' || edit.status === 'reverted'
        ? 'reverted'
        : 'proposed'
      : 'conflict';
}
function restoreOriginal(text: string, edit: EditProposal): string {
  let offset = edit.offset;
  if (offset === undefined) {
    // Legacy proposals did not record the offset. Only an unambiguous reverse
    // replacement is supported, and its full original hash must still match.
    if (!edit.newText || text.indexOf(edit.newText) !== text.lastIndexOf(edit.newText))
      throw new AppError(
        'UNDO_LEGACY',
        '이전 버전 수정안의 복원 위치를 확인할 수 없습니다. 원본을 복원하는 새 수정안을 만들어 주세요.',
      );
    offset = text.indexOf(edit.newText);
  }
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    offset > text.length ||
    text.slice(offset, offset + edit.newText.length) !== edit.newText
  )
    throw new AppError('EDIT_INVALID', '저장된 수정 위치가 파일과 일치하지 않습니다.');
  return text.slice(0, offset) + edit.oldText + text.slice(offset + edit.newText.length);
}
// Serialize Lodex writers even when two sessions address the same registered root.
const writes = new Map<string, Promise<unknown>>();
export async function applyEdit(
  project: Project,
  edit: EditProposal,
  signal: AbortSignal,
): Promise<void> {
  return writeEdit(project, edit, signal, 'apply');
}
export async function undoEdit(
  project: Project,
  edit: EditProposal,
  signal: AbortSignal,
): Promise<void> {
  return writeEdit(project, edit, signal, 'undo');
}
async function writeEdit(
  project: Project,
  edit: EditProposal,
  signal: AbortSignal,
  operation: 'apply' | 'undo',
): Promise<void> {
  return withProjectWrite(project, () => writeEditUnlocked(project, edit, signal, operation));
}
export async function withProjectWrite<T>(project: Project, run: () => Promise<T>): Promise<T> {
  const previous = writes.get(project.identity) ?? Promise.resolve();
  const task = previous.catch(() => undefined).then(run);
  writes.set(project.identity, task);
  try {
    return await task;
  } finally {
    if (writes.get(project.identity) === task) writes.delete(project.identity);
  }
}
export async function writeEditUnlocked(
  project: Project,
  edit: EditProposal,
  signal: AbortSignal,
  operation: 'apply' | 'undo',
): Promise<void> {
  const sourceHash = operation === 'undo' ? edit.afterHash : edit.beforeHash;
  const targetHash = operation === 'undo' ? edit.beforeHash : edit.afterHash;
  signal.throwIfAborted();
  const target = await resolveTarget(project, edit.path);
  const text = await readText(project, edit.path, signal);
  if (digest(text) === targetHash) return; // Never repeat an already committed replacement.
  if (digest(text) !== sourceHash)
    throw new AppError('EDIT_CONFLICT', '검토 후 파일이 변경되었습니다. 덮어쓰지 않았습니다.', 409);
  if (!(target.info.mode & 0o222))
    throw new AppError('EDIT_READ_ONLY', '읽기 전용 파일은 수정할 수 없습니다.');
  const next =
    operation === 'undo'
      ? restoreOriginal(text, edit)
      : replaceOnce(text, edit.oldText, edit.newText);
  if (digest(next) !== targetHash)
    throw new AppError('EDIT_INVALID', '저장된 수정안의 해시가 일치하지 않습니다.');
  const temporary = join(dirname(target.path), '.lodex-edit-' + randomUUID() + '.tmp');
  let committed = false;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    try {
      await handle.writeFile(next, 'utf8');
      await handle.chmod(target.info.mode & 0o777);
      await handle.sync();
    } finally {
      await handle.close();
    }
    const current = await resolveTarget(project, edit.path);
    if (
      current.path !== target.path ||
      current.info.ino !== target.info.ino ||
      current.info.dev !== target.info.dev ||
      digest(await readText(project, edit.path, signal)) !== sourceHash
    )
      throw new AppError(
        'EDIT_CONFLICT',
        '적용 중 파일이 변경되었습니다. 덮어쓰지 않았습니다.',
        409,
      );
    signal.throwIfAborted();
    await rename(temporary, target.path);
    committed = true;
  } finally {
    if (!committed) {
      // Recheck containment before touching a temporary path after any failure.
      const parent = await resolveTarget(
        project,
        relative(project.path, dirname(target.path)) || '.',
      );
      if (parent.path === dirname(target.path)) await unlink(temporary).catch(() => undefined);
    }
  }
}

async function entries(project: Project, path: string, signal: AbortSignal) {
  const target = await resolveTarget(project, path);
  if (!target.info.isDirectory()) throw new AppError('NOT_DIRECTORY', '폴더 경로가 필요합니다.');
  const found: { name: string; directory: boolean }[] = [];
  let scanned = 0;
  for await (const entry of await opendir(target.path)) {
    signal.throwIfAborted();
    if (++scanned > 2000) break;
    if (!blocked(entry.name) && !entry.isSymbolicLink() && (entry.isFile() || entry.isDirectory()))
      found.push({ name: entry.name, directory: entry.isDirectory() });
  }
  return { found: found.sort((a, b) => a.name.localeCompare(b.name)), truncated: scanned > 2000 };
}

function globMatcher(pattern: string): (path: string) => boolean {
  const normalized = pattern.replaceAll('\\', '/');
  if (
    normalized.startsWith('/') ||
    normalized.includes(':') ||
    /[\x00-\x1f\x7f]/.test(normalized) ||
    normalized.split('/').some((part) => !part || part === '.' || part === '..')
  )
    throw new AppError('TOOL_ARGUMENTS', 'glob은 프로젝트 내부 파일 패턴이어야 합니다.');
  let source = '^';
  for (let index = 0; index < normalized.length; index++) {
    const char = normalized[index]!;
    if (char === '*' && normalized[index + 1] === '*') {
      index++;
      if (normalized[index + 1] === '/') {
        index++;
        source += '(?:.*/)?';
      } else source += '.*';
    } else if (char === '*') source += '[^/]*';
    else if (char === '?') source += '[^/]';
    else source += char.replace(/[|\\{}()[\]^$+?.-]/g, '\\$&');
  }
  const expression = new RegExp(source + '$');
  const basenameOnly = !normalized.includes('/');
  return (path) => expression.test(basenameOnly ? basename(path) : path);
}

export async function runProjectTool(
  project: Project,
  name: string,
  rawArguments: string,
  signal: AbortSignal,
  onProposal?: (edit: EditProposal) => void,
  onChanges?: (changes: ChangeSet) => void,
  authorizeMutation?: (paths: string[], destructive: boolean) => Promise<boolean>,
): Promise<string> {
  try {
    signal.throwIfAborted();
    if (!(name in schemas) || !Object.hasOwn(schemas, name))
      throw new AppError('TOOL_UNAVAILABLE', '등록되지 않은 도구입니다.');
    let value: unknown;
    try {
      value = JSON.parse(rawArguments);
    } catch {
      throw new AppError('TOOL_ARGUMENTS', '도구 인자는 완성된 JSON이어야 합니다.');
    }
    if (Object.hasOwn(pathOperationSchemas, name))
      return JSON.stringify(
        await runPathOperation(
          project,
          name as keyof typeof pathOperationSchemas,
          value,
          signal,
          authorizeMutation,
        ),
      );
    if (name === 'propose_changes') {
      const changes = await proposeChanges(project, schemas.propose_changes.parse(value), signal);
      onChanges?.(changes);
      return JSON.stringify({
        files: changes.files.map((f) => ({ path: f.path, afterHash: f.afterHash, diff: f.diff })),
        applied: false,
        ...(changes.thenRun ? { thenRun: changes.thenRun } : {}),
        message: 'Proposal only. Await user review and apply the set in the UI.',
      });
    }
    if (name === 'propose_edit') {
      const edit = await proposeEdit(project, value, signal);
      onProposal?.(edit);
      return JSON.stringify({
        path: edit.path,
        beforeHash: edit.beforeHash,
        afterHash: edit.afterHash,
        diff: edit.diff,
        applied: false,
        ...(edit.thenRun ? { thenRun: edit.thenRun } : {}),
        message: 'Proposal only. Await user review and apply in the UI.',
      });
    }
    if (name === 'list_files') {
      const args = schemas.list_files.parse(value);
      const result = await entries(project, args.path, signal);
      return JSON.stringify({
        path: args.path,
        entries: result.found.slice(0, 200),
        truncated: result.truncated || result.found.length > 200,
      });
    }
    if (name === 'find_files') {
      const args = schemas.find_files.parse(value);
      const matches = globMatcher(args.pattern);
      const queue = [{ path: args.path, depth: 0 }];
      const paths: string[] = [];
      let visited = 0,
        truncated = false;
      outer: while (queue.length) {
        signal.throwIfAborted();
        const next = queue.shift()!;
        const result = await entries(project, next.path, signal);
        truncated ||= result.truncated;
        for (const entry of result.found) {
          if (++visited > 5000) {
            truncated = true;
            break outer;
          }
          const path = relative(project.path, resolve(project.path, next.path, entry.name))
            .split(sep)
            .join('/');
          if (entry.directory) {
            if (next.depth < 32) queue.push({ path, depth: next.depth + 1 });
            else truncated = true;
            continue;
          }
          if (!matches(path)) continue;
          paths.push(path);
          if (paths.length >= args.maxResults || Buffer.byteLength(JSON.stringify(paths)) > 16000) {
            truncated = true;
            break outer;
          }
        }
      }
      return JSON.stringify({ paths: paths.sort(), truncated, visited });
    }
    if (name === 'read_file') {
      const args = schemas.read_file.parse(value);
      const text = await readText(project, args.path, signal);
      const selected = selectLineRange(text, args.startLine, args.maxLines, 16000);
      return JSON.stringify({
        path: args.path,
        sha256: createHash('sha256').update(text).digest('hex'),
        ...readMetadata(text, args.startLine, selected.truncated),
        totalLines: selected.totalLines,
        lines: selected.lines,
        truncated: selected.truncated,
      });
    }
    if (name === 'read_many_files') {
      const args = schemas.read_many_files.parse(value);
      const files: {
        path: string;
        sha256: string;
        bytes: number;
        lineEnding: string;
        complete: boolean;
        totalLines: number;
        lines: { line: number; text: string }[];
        truncated: boolean;
      }[] = [];
      let remaining = args.maxTotalBytes;
      let truncated = false;
      for (const request of args.files) {
        signal.throwIfAborted();
        if (remaining < 512) {
          truncated = true;
          break;
        }
        const text = await readText(project, request.path, signal);
        const selected = selectLineRange(
          text,
          request.startLine,
          request.maxLines,
          Math.max(0, remaining - 384 - Buffer.byteLength(request.path)),
        );
        const file = {
          path: request.path,
          sha256: createHash('sha256').update(text).digest('hex'),
          ...readMetadata(text, request.startLine, selected.truncated),
          totalLines: selected.totalLines,
          lines: selected.lines,
          truncated: selected.truncated,
        };
        files.push(file);
        remaining -= Buffer.byteLength(JSON.stringify(file));
        truncated ||= selected.truncated;
      }
      return JSON.stringify({
        files,
        truncated: truncated || files.length < args.files.length,
        skipped: args.files.slice(files.length).map((request) => request.path),
      });
    }
    const args = schemas.search_text.parse(value);
    const query = args.caseSensitive ? args.query : args.query.toLocaleLowerCase('en-US');
    const queue = [{ path: args.path, depth: 0 }];
    const matches: { path: string; line: number; text: string }[] = [];
    let visited = 0,
      readBytes = 0,
      skipped = 0,
      truncated = false;
    outer: while (queue.length) {
      signal.throwIfAborted();
      const next = queue.shift()!;
      const result = await entries(project, next.path, signal);
      truncated ||= result.truncated;
      for (const entry of result.found) {
        if (++visited > 2000 || readBytes > 16 * MAX_FILE) {
          truncated = true;
          break outer;
        }
        const path = relative(project.path, resolve(project.path, next.path, entry.name))
          .split(sep)
          .join('/');
        if (entry.directory) {
          if (next.depth < 12) queue.push({ path, depth: next.depth + 1 });
          else truncated = true;
          continue;
        }
        let text: string;
        try {
          text = await readText(project, path, signal);
        } catch {
          signal.throwIfAborted();
          skipped++;
          continue;
        }
        readBytes += Buffer.byteLength(text);
        for (const [index, line] of text.split(/\r?\n/).entries()) {
          if ((args.caseSensitive ? line : line.toLocaleLowerCase('en-US')).includes(query))
            matches.push({ path, line: index + 1, text: line.slice(0, 500) });
          if (
            matches.length >= args.maxResults ||
            Buffer.byteLength(JSON.stringify(matches)) > 16000
          ) {
            truncated = true;
            break outer;
          }
        }
      }
    }
    return JSON.stringify({ matches, truncated, skipped, visited });
  } catch (error) {
    signal.throwIfAborted();
    const code =
      error instanceof AppError
        ? error.code
        : error instanceof z.ZodError
          ? 'TOOL_ARGUMENTS'
          : 'FILE_ERROR';
    const recovery: Record<string, string> = {
      TOOL_ARGUMENTS:
        'Use the provided tool schema and correct the indicated fields. Send one complete JSON object, not a patch or Markdown.',
      EDIT_MATCH:
        'Read the relevant range and copy source text exactly. Include more surrounding lines to make the match unique. Empty oldText is allowed only for an empty existing file. Do not retry the same unmatched text or delete/recreate the file.',
      EDIT_CONFLICT:
        'Read the current file again and rebuild the edit with its current sha256 and source text. Do not reuse a stale hash or overwrite intervening changes.',
      EDIT_EMPTY:
        'The requested replacement changes nothing. Check whether the desired state already exists and skip this edit if so.',
      CHANGE_DUPLICATE:
        'Use one change per file path. Combine edits in one unique block, or apply sequentially using each confirmed new hash.',
      CREATE_EXISTS:
        'This path already exists, even if empty. Read it and use kind edit/propose_edit with its current hash; never delete it to retry create.',
      CREATE_PARENT:
        'Check the parent with list_files and create missing directories with make_directory, one level at a time, before creating the file.',
      DIFF_LIMIT:
        'Split into smaller exact replacements. Keep the original file and use a current hash for each applied edit.',
      PATH_DENIED:
        'Stay within the paths permitted by this tool. Do not retry by changing separators or disguising the path.',
      FILE_ERROR:
        'Check the path and parent directory with list_files/find_files, then read the intended existing file. For a new file use propose_changes kind create after its parents exist.',
    };
    return JSON.stringify({
      error: code,
      message:
        error instanceof AppError
          ? error.message
          : '인자·파일 경로·텍스트 형식·접근 권한을 확인하세요.',
      ...(recovery[code] ? { recovery: recovery[code] } : {}),
      ...(error instanceof z.ZodError
        ? {
            issues: error.issues.slice(0, 8).map((issue) => ({
              path: issue.path.join('.'),
              code: issue.code,
              message: issue.message.slice(0, 240),
            })),
          }
        : {}),
    });
  }
}
