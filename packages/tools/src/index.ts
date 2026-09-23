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
  runCommandSchema,
} from '@lodex/contracts';
import { createTwoFilesPatch } from 'diff';
import { proposeChanges, changeInputSchema } from './changes';
import { pathOperationSchemas, runPathOperation } from './path-operations';
export { proposeChanges, checkChanges, writeChanges } from './changes';
export {
  executeCommand,
  executeHostCommand,
  cleanupExecution,
  inspectDocker,
  executionTool,
  hostExecutionTool,
} from './execution';
export { hostFileTools, runHostFileTool } from './host-files';

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
    path: pathSchema,
    expectedHash: z.string().regex(/^[a-f0-9]{64}$/),
    oldText: z.string().min(1).max(6000),
    newText: z.string().max(6000),
    thenRun: runCommandSchema.optional(),
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
  search_text: z.strictObject({
    path: pathSchema,
    query: z.string().min(1).max(200),
    maxResults: z.number().int().min(1).max(100).default(30),
    caseSensitive: z.boolean().default(true),
  }),
};
const descriptions: Record<keyof typeof schemas, string> = {
  inspect_path:
    'Inspect one existing project file or directory before move_path or delete_path. Returns a content fingerprint, kind, bounded entry count, and byte count. Reads at most 2,000 entries and 32 MiB. Secret, generated, linked, and project-root paths are excluded.',
  make_directory:
    'Create one directory inside an existing project directory after permission review. Does not create missing parents and never overwrites an existing path.',
  move_path:
    'Move one reviewed file or directory inside the project. First call inspect_path and pass its exact expectedFingerprint. The destination parent must exist and the destination must not exist. Never overwrites.',
  delete_path:
    'Delete one reviewed project file or directory. First call inspect_path and pass its exact expectedFingerprint. Non-empty directories require recursive=true. This is destructive and always requires user review unless Full Access is active.',
  propose_changes:
    'Propose a reviewed set of 1-8 UTF-8 file changes. kind edit requires read_file sha256, one exact oldText and newText. kind create requires a nonexistent path inside an EXISTING directory and content. A missing project-root .env or .env.* file may be created this way, but existing dotenv files cannot be read or edited. Paths must be distinct. Optional thenRun fuses one Docker validation command with the approved change set. Total tool arguments stay under 16 KiB. NEVER writes before approval. No directories or deletion.',
  propose_edit:
    'Propose one exact text replacement in an existing UTF-8 project file. First read_file for its sha256 as expectedHash; oldText must match exactly once, without line numbers. Preserves CRLF. Optional thenRun fuses one Docker validation command with the approved edit. Produces a diff for review and NEVER writes before approval. No creation or deletion.',
  list_files:
    'List up to 200 files/directories directly inside a project-relative directory. Start with path ".". No file content is read.',
  find_files:
    'Find project files recursively with a bounded glob such as "**/*.ts", "src/**/test?.tsx", or "README*". Returns at most 500 project-relative paths. Generated, secret, and linked paths are excluded. No file content is read.',
  read_file:
    'Read UTF-8 text from a project-relative file, with line numbers. Use startLine and maxLines for a bounded range. No writes.',
  search_text:
    'Search for a literal string in project UTF-8 files. caseSensitive defaults to true. Returns bounded line matches. Not a regex. Generated directories and common secret files are excluded.',
};
export const projectTools: ToolDefinition[] = Object.entries(schemas).map(([name, schema]) => ({
  type: 'function',
  function: {
    name,
    description: descriptions[name as keyof typeof schemas],
    parameters: z.toJSONSchema(schema),
  },
}));

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
function replaceOnce(text: string, oldText: string, newText: string): string {
  const at = text.indexOf(oldText);
  if (at < 0 || text.indexOf(oldText, at + 1) >= 0)
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
  if (!patch || Buffer.byteLength(patch) > 32000)
    throw new AppError('DIFF_LIMIT', '변경 비교가 너무 큽니다. 수정 범위를 줄여 주세요.');
  return {
    path: args.path,
    beforeHash: digest(text),
    afterHash: digest(next),
    oldText,
    newText,
    diff: patch,
    status: 'proposed',
    offset: text.indexOf(oldText),
    ...(args.thenRun ? { thenRun: args.thenRun } : {}),
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
      const lines = text.split(/\r?\n/);
      const selected: { line: number; text: string }[] = [];
      let bytes = 0;
      for (
        let i = args.startLine - 1;
        i < Math.min(lines.length, args.startLine - 1 + args.maxLines);
        i++
      ) {
        const line = lines[i]!;
        if (bytes + Buffer.byteLength(line) > 16000) break;
        bytes += Buffer.byteLength(line);
        selected.push({ line: i + 1, text: line });
      }
      return JSON.stringify({
        path: args.path,
        sha256: createHash('sha256').update(text).digest('hex'),
        totalLines: lines.length,
        lines: selected,
        truncated: args.startLine - 1 + selected.length < lines.length,
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
    return JSON.stringify({
      error:
        error instanceof AppError
          ? error.code
          : error instanceof z.ZodError
            ? 'TOOL_ARGUMENTS'
            : 'FILE_ERROR',
      message:
        error instanceof AppError
          ? error.message
          : '인자·파일 경로·텍스트 형식·접근 권한을 확인하세요.',
    });
  }
}
