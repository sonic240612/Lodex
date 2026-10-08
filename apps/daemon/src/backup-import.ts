import { createHash, randomUUID } from 'node:crypto';
import { lstat, open, realpath } from 'node:fs/promises';
import { basename } from 'node:path';
import { z } from 'zod';
import {
  AppError,
  modelConfigSchema,
  agentRoutingConfigSchema,
  planSchema,
  taskListSchema,
  pauseTaskList,
  contextCompactionSchema,
  modelCallRecordSchema,
  localProfileInputSchema,
  autopilotLimitsSchema,
  defaultExecutionConfig,
  browserConfigSchema,
  automationInputSchema,
  languageServerConfigSchema,
  type Session,
  type ModelConfig,
  type LocalProfile,
  type BackupImportPreview,
  type BackupImportResult,
  type BackupImportKind,
} from '@lodex/contracts';
import type { Store, BackupImportData, BackupImportCatalog } from '@lodex/storage';
import { inspectProject } from '@lodex/tools';
import { inspectSkillDirectory } from '@lodex/skills';
import { validateConfig } from '@lodex/mcp';
import { inspectModelGroup } from '@lodex/local-runtime';

const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
function restoredSessionId(backupId: string, sessionId: string) {
  const bytes = createHash('sha256').update(`lodex-restore:${backupId}:${sessionId}`).digest();
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
const id = z.uuid();
const date = z.iso.datetime();
const finite = z.number().finite().nonnegative();
const metric = z
  .object({
    value: finite,
    source: z.enum(['engine_reported', 'provider_reported', 'app_observed']),
  })
  .nullable();
const usage = z
  .object({
    inputTokens: finite.nullable(),
    outputTokens: finite.nullable(),
    costUsd: finite.nullable(),
    billing: z.enum(['not_applicable', 'pending_reconciliation', 'reported']),
    decodeTps: metric,
    prefillTps: metric,
    ttftMs: metric,
    generationId: z.string().max(500).optional(),
  })
  .nullable();
const activity = z.object({
  id,
  kind: z.enum(['tool', 'thinking']),
  label: z.string(),
  text: z.string(),
  status: z.enum(['running', 'completed', 'failed', 'cancelled', 'interrupted']),
  arguments: z.string().optional(),
  contentOffset: finite.int().optional(),
  startedAt: date.optional(),
  finishedAt: date.optional(),
});
const message = z.object({
  id,
  role: z.enum(['user', 'assistant']),
  content: z.string(),
  createdAt: date,
  status: z.enum(['complete', 'streaming', 'cancelled', 'failed', 'interrupted']),
  error: z.string().nullable(),
  usage,
  agentMode: z.enum(['plan', 'build']).optional(),
  activities: z.array(activity).optional(),
  finalResponseOffset: finite.int().optional(),
  workFinishedAt: date.optional(),
  costCalls: z.array(modelCallRecordSchema).optional(),
});
const session = z.object({
  id,
  title: z.string().max(200),
  createdAt: date,
  updatedAt: date,
  config: modelConfigSchema,
  routing: agentRoutingConfigSchema.optional(),
  plan: planSchema,
  taskList: taskListSchema.optional(),
  messages: z.array(message),
  contextCompaction: contextCompactionSchema.optional(),
  projectId: id.nullable().optional(),
  hasMcpHistory: z.boolean().optional(),
  hasSkillHistory: z.boolean().optional(),
  hasProjectHistory: z.boolean().optional(),
  autopilot: z
    .object({
      plan: planSchema,
      limits: autopilotLimitsSchema,
      startedAt: date,
      goalDriven: z.boolean().optional(),
    })
    .optional(),
});
const envelope = z.object({
  format: z.literal('lodex-backup-v1'),
  backupId: id,
  exportedAt: date,
  secretsIncluded: z.literal(false),
  data: z.object({
    state: z.object({
      protocolVersion: z.literal(1),
      projects: z.array(z.unknown()),
      sessions: z.array(z.unknown()),
    }),
    profiles: z.array(z.unknown()).default([]),
    skills: z.array(z.unknown()).default([]),
    mcp: z.array(z.unknown()).default([]),
    integrations: z
      .object({
        browser: z.unknown().optional(),
        automations: z.unknown().optional(),
        language_servers: z.unknown().optional(),
      })
      .default({}),
  }),
});
type Document = z.infer<typeof envelope>;
const kinds = ['projects', 'sessions', 'profiles', 'skills', 'mcp'] as const;
const labels = {
  projects: '프로젝트',
  sessions: '대화·계획',
  profiles: '로컬 모델 프로필',
  skills: 'Skills',
  mcp: 'MCP 등록',
};
const pathKey = (path: string) => (process.platform === 'win32' ? path.toLowerCase() : path);

/** Validate syntax before any filesystem access, which could authenticate a Windows share. */
export function isLocalBackupImportPath(
  path: string,
  platform: NodeJS.Platform = process.platform,
) {
  if (!path || /[\x00-\x1f\x7f]/.test(path) || /^[\\/]{2}/.test(path)) return false;
  if (platform !== 'win32') return path.startsWith('/');
  // Only ordinary drive-rooted paths: reject UNC, device namespaces, drive-relative
  // paths and alternate streams. Extended-length local paths can be selected again
  // through the file picker, which supplies ordinary drive paths.
  if (!/^[A-Za-z]:[\\/]/.test(path) || /[<>:"|?*]/.test(path.slice(2))) return false;
  return !path
    .slice(3)
    .split(/[\\/]/)
    .some((part) => /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part.trimEnd()));
}

function requireLocalPath(path: string) {
  if (!isLocalBackupImportPath(path))
    throw new AppError(
      'BACKUP_PATH',
      '네트워크·장치 경로 대신 로컬 파일의 절대 경로를 선택하세요.',
    );
}

function checkItemPaths(kind: Exclude<(typeof kinds)[number], 'sessions'>, raw: unknown) {
  if (kind === 'projects') requireLocalPath(z.object({ path: z.string() }).parse(raw).path);
  else if (kind === 'skills')
    requireLocalPath(
      z.object({ source: z.object({ rootPath: z.string() }) }).parse(raw).source.rootPath,
    );
  else if (kind === 'profiles') {
    const paths = z
      .object({
        enginePath: z.string(),
        modelPath: z.string(),
        modelFiles: z.array(z.object({ path: z.string() })).optional(),
      })
      .parse(raw);
    // Check the whole group before even inspecting its first local file.
    for (const path of [
      paths.enginePath,
      paths.modelPath,
      ...(paths.modelFiles ?? []).map((file) => file.path),
    ])
      requireLocalPath(path);
  }
}

async function readDocument(path: string) {
  requireLocalPath(path);
  const handle = await open(path, 'r');
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > 268_435_456)
      throw new AppError('BACKUP_SIZE', '256 MiB 이하의 백업 JSON 파일을 선택하세요.');
    // Bounded read: a concurrently growing file cannot make readFile allocate without a limit.
    const bytes = Buffer.alloc(before.size + 1);
    let count = 0;
    while (count < bytes.length) {
      const read = await handle.read(bytes, count, bytes.length - count, count);
      if (!read.bytesRead) break;
      count += read.bytesRead;
    }
    const after = await handle.stat();
    if (count !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs)
      throw new AppError('BACKUP_CHANGED', '백업 파일이 변경되었습니다. 다시 선택하세요.', 409);
    const content = bytes.subarray(0, count);
    const sha256 = digest(content);
    const expected = basename(path).match(/^lodex-.*-([a-f0-9]{64})\.json$/)?.[1];
    if (expected && expected !== sha256)
      throw new AppError('BACKUP_CHECKSUM', '백업 파일의 SHA-256 검증에 실패했습니다.');
    let document: Document;
    try {
      document = envelope.parse(
        JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(content)),
      );
    } catch {
      throw new AppError('BACKUP_FORMAT', '지원하지 않는 버전이거나 손상된 Lodex 백업입니다.');
    }
    return { document, sha256, hasFilenameHash: !!expected };
  } finally {
    await handle.close();
  }
}

function restoredConfig(config: ModelConfig, profiles: Set<string>) {
  const result = { ...config, cloudConsent: false, projectCloudConsent: false };
  if (result.managedModelId && !profiles.has(result.managedModelId)) {
    delete result.managedModelId;
    delete result.managedModelVersion;
    // A stale managed endpoint must not silently address another server after restore.
    result.model = '';
    result.baseUrl = 'http://127.0.0.1:8080/v1';
  }
  return result;
}

function restoredSession(
  value: unknown,
  projects: Map<string, string>,
  profiles: Set<string>,
  restoredId?: string,
): Session {
  const parsed = session.parse(value);
  if (new Set(parsed.messages.map((item) => item.id)).size !== parsed.messages.length)
    throw new Error('Duplicate message');
  const messageIds = new Set(parsed.messages.map((item) => item.id));
  if (parsed.contextCompaction && !messageIds.has(parsed.contextCompaction.throughMessageId))
    throw new Error('Invalid checkpoint');
  const routing = parsed.routing
    ? {
        subagentsEnabled: parsed.routing.subagentsEnabled,
        ...(parsed.routing.plan ? { plan: restoredConfig(parsed.routing.plan, profiles) } : {}),
        ...(parsed.routing.build ? { build: restoredConfig(parsed.routing.build, profiles) } : {}),
        ...(parsed.routing.summary
          ? { summary: restoredConfig(parsed.routing.summary, profiles) }
          : {}),
        ...(parsed.routing.review
          ? { review: restoredConfig(parsed.routing.review, profiles) }
          : {}),
        ...(parsed.routing.subagent
          ? { subagent: restoredConfig(parsed.routing.subagent, profiles) }
          : {}),
      }
    : {};
  return {
    id: restoredId ?? parsed.id,
    title: parsed.title,
    version: 0,
    createdAt: parsed.createdAt,
    updatedAt: parsed.updatedAt,
    config: restoredConfig(parsed.config, profiles),
    routing: agentRoutingConfigSchema.parse(routing),
    mode: 'build',
    permissionMode: 'ask',
    run: null,
    projectId: parsed.projectId ? (projects.get(parsed.projectId) ?? null) : null,
    plan: parsed.plan,
    ...(parsed.taskList
      ? {
          taskList: pauseTaskList({
            ...parsed.taskList,
            tasks: parsed.taskList.tasks.map((task) => ({
              ...task,
              ...(task.model ? { model: restoredConfig(task.model, profiles) } : {}),
            })),
          }),
        }
      : {}),
    ...(parsed.contextCompaction ? { contextCompaction: parsed.contextCompaction } : {}),
    ...(parsed.autopilot
      ? {
          autopilot: {
            runId: randomUUID(),
            status: 'paused',
            plan: parsed.autopilot.plan,
            taskIds: [],
            completedTaskIds: [],
            wholeGoal: true,
            evidence: [],
            limits: parsed.autopilot.limits,
            startedAt: parsed.autopilot.startedAt,
            modelCalls: 0,
            toolCalls: 0,
            reservedOutputTokens: 0,
            spentCostUsd: 0,
            reservedCostUsd: 0,
            costUnconfirmed: false,
            reason: '백업에서 복원했습니다. 설정을 확인한 뒤 목표를 다시 시작하세요.',
            ...(parsed.autopilot.goalDriven ? { goalDriven: true } : {}),
          },
        }
      : {}),
    execution: defaultExecutionConfig(),
    skills: [],
    mcp: [],
    mcpAttachments: [],
    skillCloudConsent: false,
    mcpCloudConsent: false,
    hasMcpHistory: parsed.hasMcpHistory ?? true,
    hasSkillHistory: parsed.hasSkillHistory ?? true,
    hasProjectHistory: parsed.hasProjectHistory ?? !!parsed.projectId,
    messages: parsed.messages.map((item) => {
      if (item.finalResponseOffset !== undefined && item.finalResponseOffset > item.content.length)
        throw new Error('Invalid offset');
      return {
        id: item.id,
        role: item.role,
        content: item.content,
        createdAt: item.createdAt,
        error: item.error,
        usage: item.usage
          ? {
              inputTokens: item.usage.inputTokens,
              outputTokens: item.usage.outputTokens,
              costUsd: item.usage.costUsd,
              billing: item.usage.billing,
              decodeTps: item.usage.decodeTps,
              prefillTps: item.usage.prefillTps,
              ttftMs: item.usage.ttftMs,
              ...(item.usage.generationId !== undefined
                ? { generationId: item.usage.generationId }
                : {}),
            }
          : null,
        status: item.status === 'streaming' ? 'interrupted' : item.status,
        ...(item.agentMode !== undefined ? { agentMode: item.agentMode } : {}),
        ...(item.finalResponseOffset !== undefined
          ? { finalResponseOffset: item.finalResponseOffset }
          : {}),
        ...(item.workFinishedAt !== undefined ? { workFinishedAt: item.workFinishedAt } : {}),
        ...(item.costCalls !== undefined ? { costCalls: item.costCalls } : {}),
        ...(item.activities
          ? {
              activities: item.activities.map((entry) => ({
                id: entry.id,
                kind: entry.kind,
                label: entry.label,
                text: entry.text,
                status: entry.status === 'running' ? ('interrupted' as const) : entry.status,
                ...(entry.arguments !== undefined ? { arguments: entry.arguments } : {}),
                ...(entry.contentOffset !== undefined
                  ? { contentOffset: entry.contentOffset }
                  : {}),
                ...(entry.startedAt !== undefined ? { startedAt: entry.startedAt } : {}),
                ...(entry.finishedAt !== undefined ? { finishedAt: entry.finishedAt } : {}),
              })),
            }
          : {}),
      };
    }),
  };
}

async function restoredProfile(value: unknown): Promise<LocalProfile> {
  const stored = z
    .object({
      id,
      version: z.number().int().positive(),
      name: z.string(),
      enginePath: z.string(),
      modelPath: z.string(),
      settings: z.unknown(),
      vramReservationMb: finite,
      ramReservationMb: finite.int().max(4194304).optional(),
      engineIdentity: z.string(),
      modelIdentity: z.string(),
      modelBytes: finite.int(),
      modelFiles: z
        .array(z.object({ path: z.string(), bytes: finite.int(), identity: z.string() }))
        .optional(),
      engineVersion: z.string().max(2000),
      supportedFlags: z.array(z.string().regex(/^--[a-z][a-z0-9-]+$/)).max(2000),
      ggufVersion: z.number().int().positive(),
    })
    .parse(value);
  const input = localProfileInputSchema.parse({
    name: stored.name,
    enginePath: stored.enginePath,
    modelPath: stored.modelPath,
    settings: stored.settings,
    vramReservationMb: stored.vramReservationMb,
    ...(stored.ramReservationMb !== undefined ? { ramReservationMb: stored.ramReservationMb } : {}),
  });
  for (const [path, identity] of [
    [input.enginePath, stored.engineIdentity],
    [input.modelPath, stored.modelIdentity],
  ] as const) {
    requireLocalPath(path);
    const canonical = await realpath(path);
    requireLocalPath(canonical);
    const info = await lstat(canonical);
    if (!info.isFile() || `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}` !== identity)
      throw new Error('Changed local model');
  }
  const model = await inspectModelGroup(input.modelPath);
  if (model.metadata.version !== stored.ggufVersion || model.size !== stored.modelBytes)
    throw new Error('Changed model format');
  if (stored.modelFiles && JSON.stringify(model.files) !== JSON.stringify(stored.modelFiles))
    throw new Error('Changed model group');
  // Never probe --help/--version: importing a file must not run its engine executable.
  return {
    ...stored,
    modelFiles: model.files,
    name: input.name,
    enginePath: input.enginePath,
    modelPath: input.modelPath,
    settings: input.settings,
    vramReservationMb: input.vramReservationMb,
  };
}

async function prepare(
  document: Document,
  catalog: BackupImportCatalog,
  restoredIds: Map<string, string>,
) {
  const data: BackupImportData = { projects: [], sessions: [], profiles: [], skills: [], mcp: [] };
  const items: BackupImportPreview['items'] = kinds.map((kind) => ({
    kind,
    label: labels[kind],
    importable: 0,
    conflicts: 0,
    skipped: 0,
  }));
  items.push({
    kind: 'integrations',
    label: '브라우저·예약 실행·언어 서버 설정',
    importable: 0,
    conflicts: 0,
    skipped: 0,
  });
  const warnings: string[] = [
    '기존 데이터는 덮어쓰지 않습니다. 같은 ID의 항목은 건너뛰며 삭제했던 대화는 새 ID로 복원합니다.',
    '복원한 대화는 승인 요청으로 시작합니다. 클라우드 전송·명령 실행·Skills·MCP 선택을 다시 확인하세요.',
    '활동은 읽기 전용 기록으로 복원합니다. 파일 변경 취소·승인·실행 재개와 ObservationPack 원본 파일은 복원되지 않습니다.',
    'API 키·모델 파일·프로젝트 파일은 포함되지 않습니다. Telegram·Worktree·백그라운드 작업과 현재 VRAM·보존 설정은 변경하지 않습니다.',
  ];
  const projects = new Map<string, string>();
  const profiles = new Set<string>();
  for (const kind of kinds.filter((entry) => entry !== 'sessions')) {
    const stats = items.find((entry) => entry.kind === kind)!;
    const input = kind === 'projects' ? document.data.state.projects : document.data[kind];
    const seen = new Set<string>();
    for (const raw of input) {
      try {
        const { id: entryId } = z.object({ id }).parse(raw);
        if (seen.has(entryId)) throw new Error('Duplicate ID');
        seen.add(entryId);
        checkItemPaths(kind, raw);
        const existing = catalog[kind].find((entry) => entry.id === entryId);
        if (existing) {
          stats.conflicts++;
          if (kind === 'projects') {
            const candidate = z.object({ path: z.string(), identity: z.string() }).parse(raw);
            const project = catalog.projects.find((entry) => entry.id === entryId)!;
            if (
              pathKey(candidate.path) === pathKey(project.path) &&
              candidate.identity === project.identity
            )
              projects.set(entryId, project.id);
          } else if (kind === 'profiles') {
            const candidate = z
              .object({
                engineIdentity: z.string(),
                modelIdentity: z.string(),
                version: z.number(),
              })
              .parse(raw);
            const profile = catalog.profiles.find((entry) => entry.id === entryId)!;
            if (
              profile.engineIdentity === candidate.engineIdentity &&
              profile.modelIdentity === candidate.modelIdentity &&
              profile.version === candidate.version
            )
              profiles.add(entryId);
          }
          continue;
        }
        if (kind === 'projects') {
          const candidate = z.object({ path: z.string(), identity: z.string() }).parse(raw);
          const checked = await inspectProject(candidate.path);
          if (checked.identity !== candidate.identity) throw new Error('Replaced directory');
          const samePath = [...catalog.projects, ...data.projects].find(
            (entry) => pathKey(entry.path) === pathKey(checked.path),
          );
          if (samePath) {
            if (samePath.identity !== checked.identity) throw new Error('Changed directory');
            projects.set(entryId, samePath.id);
            stats.conflicts++;
            continue;
          }
          data.projects.push({ ...checked, id: entryId });
          projects.set(entryId, entryId);
        } else if (kind === 'profiles') {
          data.profiles.push(await restoredProfile(raw));
          profiles.add(entryId);
        } else if (kind === 'skills') {
          const candidate = z
            .object({
              source: z.object({ rootPath: z.string(), rootIdentity: z.string() }),
              dialect: z.enum([
                'standard',
                'codex',
                'claude',
                'pi',
                'opencode',
                'openclaw',
                'hermes',
              ]),
            })
            .parse(raw);
          const checked = await inspectSkillDirectory(candidate.source.rootPath, {
            dialect: candidate.dialect,
          });
          if (checked.source.rootIdentity !== candidate.source.rootIdentity)
            throw new Error('Replaced skill');
          if (
            [...catalog.skills, ...data.skills].some(
              (entry) => pathKey(entry.source.rootPath) === pathKey(checked.source.rootPath),
            )
          ) {
            stats.conflicts++;
            continue;
          }
          data.skills.push({ ...checked, id: entryId });
        } else {
          const candidate = z.object({ config: z.unknown() }).parse(raw);
          const config = validateConfig(candidate.config);
          data.mcp.push({
            id: entryId,
            config,
            revision: digest(JSON.stringify(config)),
            server: null,
            protocol: null,
            tools: [],
            resources: [],
            prompts: [],
            resourceTemplates: [],
            inspectedAt: new Date().toISOString(),
          });
        }
        stats.importable++;
      } catch {
        stats.skipped++;
      }
    }
  }
  const stats = items.find((entry) => entry.kind === 'sessions')!;
  const seen = new Set<string>();
  for (const raw of document.data.state.sessions) {
    try {
      const { id: sessionId } = z.object({ id }).parse(raw);
      if (seen.has(sessionId)) throw new Error('Duplicate ID');
      seen.add(sessionId);
      if (catalog.sessionIds.includes(sessionId)) {
        stats.conflicts++;
        continue;
      }
      if (catalog.deletedSessionIds.includes(sessionId) && !restoredIds.has(sessionId))
        restoredIds.set(sessionId, restoredSessionId(document.backupId, sessionId));
      if (catalog.sessionIds.includes(restoredIds.get(sessionId) ?? sessionId)) {
        stats.conflicts++;
        continue;
      }
      const restored = restoredSession(raw, projects, profiles, restoredIds.get(sessionId));
      data.sessions.push(restored);
      stats.importable++;
    } catch {
      stats.skipped++;
    }
  }
  if (items.some((item) => item.skipped))
    warnings.push(
      '건너뛴 항목은 로컬 경로가 아니거나 파일이 없거나 교체되었거나 형식이 호환되지 않습니다. 대화 자체는 프로젝트 연결 없이 복원될 수 있습니다.',
    );
  const integrationStats = items.find((item) => item.kind === 'integrations')!;
  const sessions = new Set([...catalog.sessionIds, ...data.sessions.map((session) => session.id)]);
  for (const name of ['browser', 'automations', 'language_servers'] as const) {
    const raw = document.data.integrations[name];
    if (raw == null) continue;
    if (catalog.integrations?.some((item) => item.name === name)) {
      integrationStats.conflicts++;
      continue;
    }
    try {
      let imported: unknown;
      if (name === 'browser') imported = { ...browserConfigSchema.parse(raw), enabled: false };
      else if (name === 'automations') {
        const records = z
          .array(automationInputSchema.extend({ id, createdAt: date, updatedAt: date }).strip())
          .max(100)
          .parse(raw);
        if (new Set(records.map((record) => record.id)).size !== records.length)
          throw new Error('Duplicate automation');
        imported = records.map((record) => {
          const sessionId = restoredIds.get(record.sessionId) ?? record.sessionId;
          if (!sessions.has(sessionId)) throw new Error('Unavailable automation session');
          return { ...record, sessionId, enabled: false };
        });
      } else {
        const records = z
          .array(
            z.object({
              id,
              revision: id,
              config: languageServerConfigSchema,
              executableHash: z.string().regex(/^[a-f0-9]{64}$/),
              executableIdentity: z.string().min(1).max(500),
              createdAt: date,
            }),
          )
          .max(100)
          .parse(raw);
        if (new Set(records.map((record) => record.id)).size !== records.length)
          throw new Error('Duplicate language server');
        imported = records.map((record) => {
          const projectId = projects.get(record.config.projectId);
          if (!projectId) throw new Error('Unavailable language project');
          return { ...record, config: { ...record.config, projectId }, requiresReview: true };
        });
      }
      (data.integrations ??= []).push({ name, document: imported });
      integrationStats.importable++;
    } catch {
      integrationStats.skipped++;
    }
  }
  if (data.integrations?.length)
    warnings.push(
      '브라우저와 예약 실행은 꺼진 상태로 복원합니다. 언어 서버는 실행파일을 확인하고 다시 등록해야 사용할 수 있습니다. 기존 통합 설정은 덮어쓰지 않습니다.',
    );
  if (integrationStats.skipped)
    warnings.push(
      '연결할 대화·프로젝트가 없거나 형식이 호환되지 않는 통합 설정은 복원하지 않습니다.',
    );
  if (data.mcp.length)
    warnings.push(
      'MCP는 연결 설정만 가져옵니다. 설정 화면에서 다시 검사하고 도구를 선택해야 사용할 수 있습니다.',
    );
  return { data, items, warnings };
}

export class BackupImporter {
  private previews = new Map<
    string,
    {
      path: string;
      sha256: string;
      fingerprint: string;
      items: string;
      expires: number;
      restoredIds: Map<string, string>;
    }
  >();
  constructor(private store: Store) {}
  async preview(path: string): Promise<BackupImportPreview> {
    const { document, sha256, hasFilenameHash } = await readDocument(path);
    const catalog = await this.store.backupImportCatalog();
    const restoredIds = new Map<string, string>();
    const result = await prepare(document, catalog, restoredIds);
    const token = randomUUID(),
      expires = Date.now() + 15 * 60 * 1000;
    for (const [key, value] of this.previews)
      if (value.expires < Date.now()) this.previews.delete(key);
    while (this.previews.size >= 8) this.previews.delete(this.previews.keys().next().value!);
    this.previews.set(token, {
      path,
      sha256,
      fingerprint: catalog.fingerprint,
      items: JSON.stringify(result.items),
      expires,
      restoredIds,
    });
    return {
      token,
      fileName: basename(path),
      sha256,
      exportedAt: document.exportedAt,
      expiresAt: new Date(expires).toISOString(),
      items: result.items,
      warnings: [
        ...result.warnings,
        ...(!hasFilenameHash
          ? [
              '파일명에 원래 체크섬이 없어 제작 당시 무결성은 확인할 수 없습니다. 복원 전까지 파일이 바뀌지 않는지는 SHA-256으로 확인합니다.',
            ]
          : []),
      ],
    };
  }
  async restore(token: string): Promise<BackupImportResult> {
    const preview = this.previews.get(token);
    if (!preview || preview.expires < Date.now())
      throw new AppError(
        'BACKUP_PREVIEW',
        '백업 미리보기가 만료되었습니다. 파일을 다시 선택하세요.',
        409,
      );
    const { document, sha256 } = await readDocument(preview.path);
    const catalog = await this.store.backupImportCatalog();
    if (sha256 !== preview.sha256 || catalog.fingerprint !== preview.fingerprint)
      throw new AppError(
        'BACKUP_CHANGED',
        '백업 파일 또는 앱 데이터가 변경되었습니다. 미리보기를 다시 확인하세요.',
        409,
      );
    const result = await prepare(document, catalog, preview.restoredIds);
    if (JSON.stringify(result.items) !== preview.items)
      throw new AppError(
        'BACKUP_CHANGED',
        '로컬 파일 상태가 변경되었습니다. 미리보기를 다시 확인하세요.',
        409,
      );
    await this.store.importBackup(result.data, preview.fingerprint);
    this.previews.delete(token);
    return {
      imported: Object.fromEntries([
        ...kinds.map((kind) => [kind, result.data[kind].length]),
        ['integrations', result.data.integrations?.length ?? 0],
      ]) as Record<BackupImportKind, number>,
    };
  }
}
