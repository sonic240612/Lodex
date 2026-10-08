import { createHash, randomUUID } from 'node:crypto';
import { lstat, open, realpath } from 'node:fs/promises';
import { extname, isAbsolute, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import {
  AppError,
  languageServerConfigSchema,
  lspQuerySchema,
  type LanguageServerRegistration,
  type LanguageServerStatus,
  type LspOperation,
  type LspQuery,
  type Project,
  type ToolDefinition,
} from '@lodex/contracts';
import { readText, resolveTarget } from '@lodex/tools';
import type { Store } from '@lodex/storage';
import { z } from 'zod';
import { LspConnection } from './lsp-connection';

const operations: LspOperation[] = [
  'diagnostics',
  'definitions',
  'references',
  'hover',
  'document_symbols',
];
export const lspTools: ToolDefinition[] = operations.map((operation) => ({
  type: 'function',
  function: {
    name: 'lsp_' + operation,
    description: `Read ${operation.replaceAll('_', ' ')} from a user-registered language server for the selected project. Input line/column are 1-based UTF-16 positions; result ranges are LSP 0-based UTF-16. Reads current saved files, never applies edits or executes server commands. No server is downloaded or auto-installed.`,
    parameters: z.toJSONSchema(lspQuerySchema),
  },
}));
type Document = {
  text: string;
  version: number;
  uri: string;
  diagnostics?: { items: unknown[]; version?: number; receivedAt: string };
};
type Runtime = {
  connection: LspConnection;
  documents: Map<string, Document>;
  capabilities: Record<string, unknown>;
  busy: boolean;
  idle?: NodeJS.Timeout;
};
async function executableSnapshot(path: string) {
  if (!isAbsolute(path) || /\.(?:cmd|bat|ps1)$/i.test(path))
    throw new AppError(
      'LSP_EXECUTABLE',
      '실행파일의 절대 경로를 입력하세요. 셸 스크립트 대신 실제 실행파일과 인자를 사용하세요.',
    );
  const canonical = await realpath(path),
    before = await lstat(canonical, { bigint: true });
  if (!before.isFile() || before.nlink !== 1n || before.size > 512n * 1024n * 1024n)
    throw new AppError('LSP_EXECUTABLE', '512 MiB 이하의 일반 실행파일이 필요합니다.');
  const handle = await open(canonical, 'r'),
    hash = createHash('sha256');
  try {
    const opened = await handle.stat({ bigint: true });
    if (opened.ino !== before.ino || opened.dev !== before.dev)
      throw new AppError('LSP_CHANGED', '실행파일이 변경되었습니다.');
    for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk);
    const after = await handle.stat({ bigint: true }),
      current = await lstat(canonical, { bigint: true });
    if (
      current.isSymbolicLink() ||
      current.ino !== before.ino ||
      current.dev !== before.dev ||
      after.size !== before.size ||
      after.mtimeNs !== before.mtimeNs ||
      after.ctimeNs !== before.ctimeNs
    )
      throw new AppError('LSP_CHANGED', '실행파일이 변경되었습니다.');
    return { path: canonical, hash: hash.digest('hex'), identity: before.dev + ':' + before.ino };
  } finally {
    await handle.close();
  }
}
export class LanguageServers {
  private registrations: LanguageServerRegistration[] = [];
  private version = 0;
  private runtimes = new Map<string, Runtime>();
  private errors = new Map<string, string>();
  private queue: Promise<unknown> = Promise.resolve();
  private closing = false;
  private constructor(private store: Store) {}
  static async open(store: Store) {
    const manager = new LanguageServers(store),
      saved = await store.integration('language_servers');
    if (saved) {
      manager.version = saved.version;
      manager.registrations = z
        .array(
          z.strictObject({
            id: z.uuid(),
            revision: z.uuid(),
            config: languageServerConfigSchema,
            executableHash: z.string().regex(/^[a-f0-9]{64}$/),
            executableIdentity: z.string(),
            createdAt: z.string(),
            requiresReview: z.boolean().optional(),
          }),
        )
        .parse(saved.document);
    }
    return manager;
  }
  list(): LanguageServerStatus[] {
    return this.registrations.map((registration) => ({
      registration: structuredClone(registration),
      running: this.runtimes.get(registration.id)?.connection.live ?? false,
      active: this.runtimes.get(registration.id)?.busy ?? false,
      ...(registration.requiresReview
        ? { error: '복원한 설정입니다. 실행파일을 확인한 뒤 다시 등록하세요.' }
        : this.errors.has(registration.id)
          ? { error: this.errors.get(registration.id)! }
          : {}),
    }));
  }
  available(projectId: string) {
    return this.registrations.some(
      (record) => record.config.projectId === projectId && !record.requiresReview,
    );
  }
  async reload() {
    return this.serialize(async () => {
      if ((await this.store.integration('language_servers'))?.version === this.version) return;
      await Promise.all([...this.runtimes.keys()].map((id) => this.stop(id)));
      const refreshed = await LanguageServers.open(this.store);
      this.version = refreshed.version;
      this.registrations = refreshed.registrations;
      this.errors.clear();
    });
  }
  private serialize<T>(operation: () => Promise<T>) {
    const work = this.queue.then(operation);
    this.queue = work.catch(() => undefined);
    return work;
  }
  register(input: unknown, id?: string, expectedRevision?: string) {
    return this.serialize(async () => {
      if (this.closing) throw new AppError('LSP_CLOSED', '언어 서버 관리자를 종료하고 있습니다.');
      const config = languageServerConfigSchema.parse(input),
        project = await this.store.project(config.projectId);
      await resolveTarget(project, '.');
      const existing = id ? this.registrations.find((record) => record.id === id) : undefined;
      if (id && (!existing || existing.revision !== expectedRevision))
        throw new AppError('LSP_CHANGED', '언어 서버 설정이 변경되었습니다.', 409);
      if (existing && this.runtimes.get(existing.id)?.busy)
        throw new AppError('LSP_BUSY', '언어 서버 조회가 끝난 뒤 설정을 변경하세요.', 409);
      if (!existing && this.registrations.length >= 32)
        throw new AppError('LSP_LIMIT', '언어 서버는 최대 32개까지 등록할 수 있습니다.');
      const executable = await executableSnapshot(config.executable);
      if (existing) await this.stop(existing.id);
      const record: LanguageServerRegistration = {
        id: existing?.id ?? randomUUID(),
        revision: randomUUID(),
        config: { ...config, executable: executable.path },
        executableHash: executable.hash,
        executableIdentity: executable.identity,
        createdAt: new Date().toISOString(),
      };
      const next = [...this.registrations.filter((item) => item.id !== record.id), record];
      this.version = await this.store.saveIntegration('language_servers', this.version, next);
      this.registrations = next;
      this.errors.delete(record.id);
      return structuredClone(record);
    });
  }
  remove(id: string, revision: string) {
    return this.serialize(async () => {
      const record = this.registrations.find((item) => item.id === id);
      if (!record || record.revision !== revision)
        throw new AppError('LSP_CHANGED', '언어 서버 설정을 다시 불러오세요.', 409);
      if (this.runtimes.get(id)?.busy)
        throw new AppError('LSP_BUSY', '언어 서버 조회가 끝난 뒤 삭제하세요.', 409);
      await this.stop(id);
      const next = this.registrations.filter((item) => item.id !== id);
      this.version = await this.store.saveIntegration('language_servers', this.version, next);
      this.registrations = next;
    });
  }
  async stop(id: string) {
    const runtime = this.runtimes.get(id);
    if (!runtime) return;
    clearTimeout(runtime.idle);
    await runtime.connection.close();
    if (this.runtimes.get(id) === runtime) this.runtimes.delete(id);
  }
  private async start(
    record: LanguageServerRegistration,
    project: Project,
    signal: AbortSignal,
  ): Promise<Runtime> {
    if (record.requiresReview)
      throw new AppError(
        'LSP_REVIEW_REQUIRED',
        '복원한 언어 서버를 다시 등록한 뒤 사용하세요.',
        403,
      );
    const existing = this.runtimes.get(record.id);
    if (existing?.connection.live) return existing;
    if (existing) await this.stop(record.id);
    if (this.runtimes.size >= 4) {
      const idle = [...this.runtimes].find(([, runtime]) => !runtime.busy);
      if (!idle)
        throw new AppError('LSP_BUSY', '다른 언어 서버 조회가 끝난 뒤 다시 시도하세요.', 409);
      await this.stop(idle[0]);
    }
    const executable = await executableSnapshot(record.config.executable);
    if (
      executable.hash !== record.executableHash ||
      executable.identity !== record.executableIdentity
    )
      throw new AppError(
        'LSP_CHANGED',
        '언어 서버 실행파일이 변경되었습니다. 설정에서 다시 등록하세요.',
        409,
      );
    const documents = new Map<string, Document>(),
      rootUri = pathToFileURL(project.path).href;
    const connection = new LspConnection(
      record,
      project,
      (method, raw) => {
        if (method !== 'textDocument/publishDiagnostics' || !raw || typeof raw !== 'object') return;
        const value = raw as { uri?: unknown; diagnostics?: unknown; version?: unknown },
          doc =
            typeof value.uri === 'string'
              ? [...documents.values()].find((doc) => doc.uri === value.uri)
              : undefined;
        if (
          !doc ||
          !Array.isArray(value.diagnostics) ||
          (typeof value.version === 'number' && value.version !== doc.version)
        )
          return;
        doc.diagnostics = {
          items: value.diagnostics.slice(0, 500),
          ...(typeof value.version === 'number' ? { version: value.version } : {}),
          receivedAt: new Date().toISOString(),
        };
      },
      (method, raw) => {
        if (method === 'workspace/applyEdit')
          return { applied: false, failureReason: 'Lodex language tools are read-only.' };
        if (method === 'workspace/workspaceFolders') return [{ uri: rootUri, name: project.name }];
        if (method === 'workspace/configuration')
          return Array.isArray((raw as { items?: unknown[] } | undefined)?.items)
            ? (raw as { items: unknown[] }).items.slice(0, 100).map(() => null)
            : [];
        if (method === 'window/workDoneProgress/create' || method === 'window/showMessageRequest')
          return null;
        if (method === 'window/showDocument') return { success: false };
        return undefined;
      },
    );
    const runtime: Runtime = { connection, documents, capabilities: {}, busy: true };
    this.runtimes.set(record.id, runtime);
    try {
      await connection.start(signal);
      const result = (await connection.request(
        'initialize',
        {
          processId: process.pid,
          clientInfo: { name: 'Lodex', version: '0.1.0' },
          rootUri,
          rootPath: project.path,
          workspaceFolders: [{ uri: rootUri, name: project.name }],
          capabilities: {
            workspace: {
              applyEdit: false,
              workspaceFolders: true,
              configuration: true,
              executeCommand: { dynamicRegistration: false },
            },
            general: { positionEncodings: ['utf-16'] },
            textDocument: {
              synchronization: { dynamicRegistration: false, didSave: true },
              hover: { contentFormat: ['plaintext'] },
              definition: { linkSupport: true },
              documentSymbol: { hierarchicalDocumentSymbolSupport: true },
              publishDiagnostics: { versionSupport: true },
              diagnostic: { dynamicRegistration: false },
            },
          },
        },
        signal,
      )) as { capabilities?: Record<string, unknown> };
      runtime.capabilities = result?.capabilities ?? {};
      if (
        runtime.capabilities.positionEncoding &&
        runtime.capabilities.positionEncoding !== 'utf-16'
      )
        throw new AppError(
          'LSP_ENCODING',
          '이 언어 서버의 위치 인코딩은 지원하지 않습니다. UTF-16이 필요합니다.',
        );
      connection.notify('initialized', {});
      return runtime;
    } catch (error) {
      await this.stop(record.id);
      throw error;
    }
  }
  private async synchronize(
    runtime: Runtime,
    record: LanguageServerRegistration,
    project: Project,
    path: string,
    signal: AbortSignal,
  ) {
    const paths = new Set([...runtime.documents.keys(), path]);
    for (const name of paths) {
      let text;
      try {
        text = await readText(project, name, signal);
      } catch (error) {
        const prior = runtime.documents.get(name);
        if (prior) {
          runtime.connection.notify('textDocument/didClose', { textDocument: { uri: prior.uri } });
          runtime.connection.notify('workspace/didChangeWatchedFiles', {
            changes: [{ uri: prior.uri, type: 3 }],
          });
          runtime.documents.delete(name);
        }
        if (name === path) throw error;
        continue;
      }
      const doc = runtime.documents.get(name),
        uri = pathToFileURL((await resolveTarget(project, name)).path).href;
      if (!doc) {
        if (runtime.documents.size >= 64) {
          const [oldPath, oldDoc] = runtime.documents.entries().next().value!;
          runtime.connection.notify('textDocument/didClose', { textDocument: { uri: oldDoc.uri } });
          runtime.documents.delete(oldPath);
        }
        runtime.documents.set(name, { text, uri, version: 1 });
        runtime.connection.notify('textDocument/didOpen', {
          textDocument: { uri, languageId: record.config.languageId, version: 1, text },
        });
      } else if (doc.text !== text) {
        const synchronization = runtime.capabilities.textDocumentSync;
        const kind =
          typeof synchronization === 'number'
            ? synchronization
            : (synchronization as { change?: number } | undefined)?.change;
        const last = doc.text.split('\n');
        const range = {
          start: { line: 0, character: 0 },
          end: { line: last.length - 1, character: last.at(-1)!.length },
        };
        doc.version++;
        delete doc.diagnostics;
        if (kind === 0) {
          runtime.connection.notify('textDocument/didClose', { textDocument: { uri } });
          runtime.connection.notify('textDocument/didOpen', {
            textDocument: { uri, languageId: record.config.languageId, version: doc.version, text },
          });
        } else
          runtime.connection.notify('textDocument/didChange', {
            textDocument: { uri, version: doc.version },
            contentChanges: [kind === 2 ? { range, text } : { text }],
          });
        doc.text = text;
        const save =
          typeof synchronization === 'object' && synchronization !== null
            ? (synchronization as { save?: unknown }).save
            : undefined;
        if (save)
          runtime.connection.notify('textDocument/didSave', {
            textDocument: { uri },
            ...(typeof save === 'object' && (save as { includeText?: boolean }).includeText
              ? { text }
              : {}),
          });
        runtime.connection.notify('workspace/didChangeWatchedFiles', {
          changes: [{ uri, type: 2 }],
        });
      }
    }
    return runtime.documents.get(path)!;
  }
  private async sanitize(
    value: unknown,
    project: Project,
    signal: AbortSignal,
    depth = 0,
  ): Promise<unknown> {
    signal.throwIfAborted();
    if (depth > 30) throw new AppError('LSP_OUTPUT_LIMIT', '언어 서버 결과가 너무 깊습니다.');
    if (Array.isArray(value)) {
      const result = [];
      for (const item of value.slice(0, 500)) {
        const safe = await this.sanitize(item, project, signal, depth + 1);
        if (safe !== undefined) result.push(safe);
      }
      return result;
    }
    if (!value || typeof value !== 'object') return value;
    const object = value as Record<string, unknown>;
    for (const key of ['uri', 'targetUri'])
      if (typeof object[key] === 'string') {
        try {
          const url = new URL(object[key]);
          if (url.protocol !== 'file:' || url.search || url.hash) return undefined;
          const path = relative(project.path, fileURLToPath(url));
          if (!path || path === '..' || path.startsWith('..' + sep) || isAbsolute(path))
            return undefined;
          const target = await resolveTarget(project, path);
          if (!target.info.isFile() || target.info.nlink !== 1) return undefined;
        } catch {
          return undefined;
        }
      }
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(object))
      if (!['command', 'data'].includes(key)) {
        const safe = await this.sanitize(item, project, signal, depth + 1);
        if (safe !== undefined) result[key] = safe;
      }
    return result;
  }
  query(project: Project, operation: LspOperation, raw: LspQuery, signal: AbortSignal) {
    return this.serialize(async () => {
      signal.throwIfAborted();
      if (this.closing) throw new AppError('LSP_CLOSED', '언어 서버를 종료하고 있습니다.');
      const input = lspQuerySchema.parse(raw);
      await readText(project, input.path, signal);
      const matching = this.registrations.filter(
        (record) =>
          !record.requiresReview &&
          record.config.projectId === project.id &&
          (!input.serverId || record.id === input.serverId) &&
          record.config.extensions.includes(extname(input.path).toLowerCase()),
      );
      if (matching.length !== 1)
        throw new AppError(
          'LSP_SERVER',
          matching.length
            ? '여러 언어 서버가 일치합니다. serverId를 지정하세요.'
            : '이 프로젝트와 파일 확장자에 등록된 언어 서버가 없습니다.',
        );
      const record = matching[0]!;
      let runtime: Runtime | undefined;
      try {
        runtime = await this.start(record, project, signal);
        runtime.busy = true;
        clearTimeout(runtime.idle);
        const doc = await this.synchronize(runtime, record, project, input.path, signal);
        const lines = doc.text.split('\n');
        if (
          input.line > lines.length ||
          input.column - 1 > lines[input.line - 1]!.replace(/\r$/, '').length
        )
          throw new AppError('LSP_POSITION', '파일에 존재하는 줄과 열을 지정하세요.');
        const params = {
          textDocument: { uri: doc.uri },
          position: { line: input.line - 1, character: input.column - 1 },
        };
        let result: unknown;
        if (operation === 'diagnostics') {
          if (runtime.capabilities.diagnosticProvider)
            result = await runtime.connection.request(
              'textDocument/diagnostic',
              { textDocument: params.textDocument },
              signal,
            );
          else {
            for (let attempt = 0; attempt < 15 && !doc.diagnostics; attempt++)
              await delay(50, undefined, { signal });
            result = doc.diagnostics
              ? {
                  kind: 'full',
                  items: doc.diagnostics.items,
                  version: doc.diagnostics.version ?? null,
                  versionConfirmed: doc.diagnostics.version === doc.version,
                  receivedAt: doc.diagnostics.receivedAt,
                }
              : {
                  pending: true,
                  items: [],
                  message: '아직 진단 결과를 받지 못했습니다. 오류가 없다는 뜻이 아닙니다.',
                };
          }
        } else {
          const method = {
            definitions: 'definition',
            references: 'references',
            hover: 'hover',
            document_symbols: 'documentSymbol',
          }[operation];
          result = await runtime.connection.request(
            'textDocument/' + method,
            operation === 'document_symbols'
              ? { textDocument: params.textDocument }
              : operation === 'references'
                ? { ...params, context: { includeDeclaration: true } }
                : params,
            signal,
          );
        }
        const safe = await this.sanitize(result, project, signal);
        if (Buffer.byteLength(JSON.stringify(safe ?? null)) > 512 * 1024)
          throw new AppError(
            'LSP_OUTPUT_LIMIT',
            '언어 서버 결과가 512 KiB를 초과합니다. 조회 위치를 좁혀 주세요.',
          );
        this.errors.delete(record.id);
        return {
          serverId: record.id,
          operation,
          path: input.path,
          documentVersion: doc.version,
          positionsAreZeroBased: true,
          projectOnly: true,
          result: safe ?? null,
        };
      } catch (error) {
        this.errors.set(
          record.id,
          error instanceof AppError ? error.message : '언어 서버 조회에 실패했습니다.',
        );
        await this.stop(record.id);
        throw error;
      } finally {
        if (runtime && this.runtimes.get(record.id) === runtime) {
          runtime.busy = false;
          runtime.idle = setTimeout(() => {
            void this.stop(record.id);
          }, 120000);
          runtime.idle.unref();
        }
      }
    });
  }
  async close() {
    this.closing = true;
    await Promise.all([...this.runtimes.keys()].map((id) => this.stop(id)));
    await this.queue;
  }
}
