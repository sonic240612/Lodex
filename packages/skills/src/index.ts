import { randomUUID } from 'node:crypto';
import { AppError } from '@lodex/contracts';
import {
  checkRoot,
  cleanRelative,
  hash,
  hasCompanion,
  inspectRoot,
  inventory,
  readRegisteredFile,
  SKILL_LIMITS,
} from './files';
import { normalizeCompanion, normalizeSkill, splitSkill } from './metadata';
import type {
  RegisteredSkill,
  SkillCatalog,
  SkillDiagnostic,
  SkillDialect,
  SkillDocument,
  SkillInvocation,
  SkillProvenance,
  SkillResource,
} from './types';
export type * from './types';
export { SKILL_LIMITS } from './files';

const signalOrDefault = (signal?: AbortSignal) => signal ?? new AbortController().signal;

/** Explicit folder inspection only: no code execution, installs, downloads or home scan.
 * Resource contents stay unread until readSkillResource; their stat identities are pinned.
 */
export async function inspectSkillDirectory(
  path: string,
  options: { dialect?: SkillDialect; signal?: AbortSignal } = {},
): Promise<RegisteredSkill> {
  const signal = signalOrDefault(options.signal);
  signal.throwIfAborted();
  const dialect = options.dialect ?? 'standard';
  if (!['standard', 'codex', 'claude', 'pi'].includes(dialect))
    throw new AppError('SKILL_DIALECT', '지원하지 않는 스킬 형식입니다.');
  const source = await inspectRoot(path);
  const diagnostics: SkillDiagnostic[] = [];
  const files = await inventory(source, diagnostics, signal);
  const entry = files.find((file) => file.path === 'SKILL.md');
  if (!entry) throw new AppError('SKILL_ENTRY', '선택한 폴더에 읽을 수 있는 SKILL.md가 없습니다.');
  const document = await readRegisteredFile(source, entry, SKILL_LIMITS.entryBytes, signal);
  const metadata = normalizeSkill(document.text, source.rootName, dialect, diagnostics);
  const companion = files.find((file) => file.path === 'agents/openai.yaml');
  const companionDocument = companion
    ? await readRegisteredFile(source, companion, SKILL_LIMITS.metadataBytes, signal)
    : null;
  const dependencies = companionDocument
    ? normalizeCompanion(companionDocument.text, metadata.invocation, diagnostics)
    : [];
  if (files.some((file) => file.kind === 'script'))
    diagnostics.push({
      code: 'SCRIPTS_NOT_EXECUTED',
      message:
        '스크립트가 포함되어 있습니다. 가져오기는 코드를 실행하거나 의존성을 설치하지 않습니다.',
    });
  if (files.some((file) => file.bytes > SKILL_LIMITS.resourceBytes))
    diagnostics.push({
      code: 'OVERSIZED_RESOURCES',
      message: '1 MiB보다 큰 리소스는 목록에 표시되지만 읽을 수 없습니다.',
    });
  const revision = hash(
    JSON.stringify({
      source,
      dialect,
      files,
      entrySha256: document.sha256,
      companionSha256: companionDocument?.sha256 ?? null,
    }),
  );
  return {
    schemaVersion: 1,
    id: randomUUID(),
    revision,
    source,
    dialect,
    ...metadata,
    dependencies,
    diagnostics,
    files,
    entrySha256: document.sha256,
    companionSha256: companionDocument?.sha256 ?? null,
    inspectedAt: new Date().toISOString(),
  };
}

/** Catalog never includes instruction bodies, resource contents, or absolute source paths.
 * The host first filters registrations for session and provider transmission permissions.
 */
export function skillCatalog(
  skills: readonly RegisteredSkill[],
  options: { invocation?: SkillInvocation; maxBytes?: number } = {},
): SkillCatalog {
  const invocation = options.invocation ?? 'model';
  const maxBytes = options.maxBytes ?? SKILL_LIMITS.catalogBytes;
  if (!Number.isInteger(maxBytes) || maxBytes < 2 || maxBytes > SKILL_LIMITS.catalogBytes)
    throw new AppError(
      'SKILL_CATALOG_LIMIT',
      '스킬 목록 예산은 2 bytes부터 16 KiB까지 설정할 수 있습니다.',
    );
  if (skills.length > SKILL_LIMITS.entries)
    throw new AppError('SKILL_COUNT', '한 번에 최대 512개의 스킬 등록 정보를 제공할 수 있습니다.');
  const result: SkillCatalog = {
    skills: [],
    omittedIds: [],
    policyExcludedIds: [],
    serializedBytes: 2,
  };
  const seen = new Set<string>();
  for (const skill of skills) {
    if (seen.has(skill.id)) throw new AppError('SKILL_DUPLICATE', '중복된 스킬 등록 ID입니다.');
    seen.add(skill.id);
    if (!skill.invocation[invocation]) {
      result.policyExcludedIds.push(skill.id);
      continue;
    }
    const descriptor = {
      id: skill.id,
      revision: skill.revision,
      name: skill.name,
      description: skill.description,
      sourceName: skill.source.rootName,
    };
    const bytes = Buffer.byteLength(JSON.stringify([...result.skills, descriptor]));
    if (bytes > maxBytes) result.omittedIds.push(skill.id);
    else {
      result.skills.push(descriptor);
      result.serializedBytes = bytes;
    }
  }
  return result;
}

function allowInvocation(skill: RegisteredSkill, invocation: SkillInvocation) {
  if (!['model', 'user'].includes(invocation) || !skill.invocation[invocation])
    throw new AppError(
      'SKILL_INVOCATION',
      invocation === 'model'
        ? '이 스킬은 모델의 자동 호출이 허용되지 않았습니다.'
        : '이 스킬은 직접 호출이 허용되지 않았습니다.',
    );
}

function readLimit(maxBytes: number | undefined, ceiling: number): number {
  const limit = maxBytes ?? ceiling;
  if (!Number.isInteger(limit) || limit < 1 || limit > ceiling)
    throw new AppError(
      'SKILL_SIZE',
      `읽기 예산은 1 byte부터 ${ceiling} bytes까지 설정할 수 있습니다.`,
    );
  return limit;
}

async function currentEntry(skill: RegisteredSkill, signal: AbortSignal) {
  await checkRoot(skill.source);
  const entry = skill.files.find((file) => file.path === 'SKILL.md');
  if (!entry) throw new AppError('SKILL_ENTRY', '등록 정보에 SKILL.md가 없습니다.');
  const result = await readRegisteredFile(skill.source, entry, SKILL_LIMITS.entryBytes, signal);
  if (result.sha256 !== skill.entrySha256)
    throw new AppError('SKILL_CHANGED', '등록한 스킬 지침이 변경되었습니다. 다시 등록하세요.');
  const companion = skill.files.find((file) => file.path === 'agents/openai.yaml');
  if (companion) {
    const metadata = await readRegisteredFile(
      skill.source,
      companion,
      SKILL_LIMITS.metadataBytes,
      signal,
    );
    if (metadata.sha256 !== skill.companionSha256)
      throw new AppError('SKILL_CHANGED', '등록한 스킬 정책이 변경되었습니다. 다시 등록하세요.');
  } else if (await hasCompanion(skill.source))
    throw new AppError(
      'SKILL_CHANGED',
      '등록 이후 스킬 정책 파일이 추가되었습니다. 다시 등록하세요.',
    );
  return result;
}

function provenance(
  skill: RegisteredSkill,
  path: string,
  result: { sha256: string; bytes: number },
): SkillProvenance {
  return {
    skillId: skill.id,
    revision: skill.revision,
    sourceName: skill.source.rootName,
    path,
    sha256: result.sha256,
    bytes: result.bytes,
    entrySha256: skill.entrySha256,
    readAt: new Date().toISOString(),
  };
}

/** The host must choose the registered object itself, never accept it from tool arguments. */
export async function readSkill(
  skill: RegisteredSkill,
  invocation: SkillInvocation,
  suppliedSignal?: AbortSignal,
  options: { maxBytes?: number } = {},
): Promise<SkillDocument> {
  allowInvocation(skill, invocation);
  const signal = signalOrDefault(suppliedSignal);
  signal.throwIfAborted();
  const limit = readLimit(options.maxBytes, SKILL_LIMITS.entryBytes);
  const entry = skill.files.find((file) => file.path === 'SKILL.md');
  if (!entry) throw new AppError('SKILL_ENTRY', '등록 정보에 SKILL.md가 없습니다.');
  if (entry.bytes > limit)
    throw new AppError(
      'SKILL_SIZE',
      '스킬 지침이 이번 호출의 읽기 예산을 초과했습니다. 본문을 생략하지 않았습니다.',
    );
  const result = await currentEntry(skill, signal);
  if (result.bytes > limit)
    throw new AppError('SKILL_SIZE', '스킬 지침이 읽기 예산을 초과했습니다.');
  return {
    text: result.text,
    body: splitSkill(result.text, skill.dialect).body,
    provenance: provenance(skill, 'SKILL.md', result),
  };
}

/** UTF-8 reads only. Entire instructions/resources are returned or an explicit size error.
 * The host also enforces that the skill is selected/activated for this session.
 */
export async function readSkillResource(
  skill: RegisteredSkill,
  path: string,
  invocation: SkillInvocation,
  suppliedSignal?: AbortSignal,
  options: { maxBytes?: number } = {},
): Promise<SkillResource> {
  allowInvocation(skill, invocation);
  const signal = signalOrDefault(suppliedSignal);
  signal.throwIfAborted();
  const normalized = cleanRelative(path);
  const file = skill.files.find((item) => item.path === normalized);
  if (!file) throw new AppError('SKILL_RESOURCE', '등록된 스킬 리소스가 아닙니다.');
  await currentEntry(skill, signal);
  const result = await readRegisteredFile(
    skill.source,
    file,
    readLimit(options.maxBytes, SKILL_LIMITS.resourceBytes),
    signal,
  );
  return { text: result.text, provenance: provenance(skill, normalized, result) };
}
