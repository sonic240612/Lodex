import { parseDocument } from 'yaml';
import { AppError } from '@lodex/contracts';
import { SKILL_LIMITS } from './files';
import type { RegisteredSkill, SkillDependency, SkillDiagnostic, SkillDialect } from './types';

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function parseMetadata(text: string): Record<string, unknown> {
  if (Buffer.byteLength(text) > SKILL_LIMITS.metadataBytes)
    throw new AppError('SKILL_METADATA_SIZE', '스킬 메타데이터가 32 KiB를 초과했습니다.');
  try {
    const doc = parseDocument(text, {
      strict: true,
      uniqueKeys: true,
      stringKeys: true,
      version: '1.2',
      schema: 'core',
      merge: false,
      resolveKnownTags: false,
      prettyErrors: false,
      logLevel: 'silent',
    });
    if (doc.errors.length || doc.warnings.length) throw new Error('Invalid YAML');
    const value: unknown = doc.toJS({ maxAliasCount: 0 });
    let nodes = 0;
    const check = (item: unknown, depth: number) => {
      if (++nodes > 1024 || depth > 8) throw new Error('Metadata nesting');
      if (Array.isArray(item)) item.forEach((entry) => check(entry, depth + 1));
      else if (object(item)) {
        for (const [key, entry] of Object.entries(item)) {
          if (['__proto__', 'prototype', 'constructor', '<<'].includes(key))
            throw new Error('Unsupported key');
          check(entry, depth + 1);
        }
      } else if (item !== null && !['string', 'number', 'boolean'].includes(typeof item))
        throw new Error('Unsupported YAML value');
    };
    check(value, 0);
    if (!object(value)) throw new Error('Expected mapping');
    return value;
  } catch {
    // Avoid embedding YAML contents, which can contain private configuration, in errors.
    throw new AppError(
      'SKILL_METADATA',
      '스킬 YAML 형식이 잘못되었습니다. 중복 키·별칭·사용자 태그는 지원하지 않습니다.',
    );
  }
}

export function splitSkill(text: string, dialect: SkillDialect) {
  const normalized = text.replace(/^\ufeff/, '');
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(normalized);
  if (!match) {
    if (dialect === 'claude' && !normalized.startsWith('---'))
      return { fields: {}, body: normalized };
    throw new AppError('SKILL_FRONTMATTER', 'SKILL.md의 첫 줄에 YAML frontmatter가 필요합니다.');
  }
  return { fields: parseMetadata(match[1]!), body: normalized.slice(match[0].length) };
}

function requiredText(value: unknown, field: string, max: number): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > max ||
    /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)
  )
    throw new AppError(
      'SKILL_METADATA',
      `${field} 필드는 비어 있지 않은 ${max}자 이하의 텍스트여야 합니다.`,
    );
  return value.trim();
}

function boolean(value: unknown, field: string, dialect: SkillDialect): boolean {
  if (typeof value === 'boolean') return value;
  if (dialect === 'claude') {
    const str = String(value).toLowerCase();
    if (['yes', 'on', '1', 'true'].includes(str)) return true;
    if (['no', 'off', '0', 'false'].includes(str)) return false;
  }
  throw new AppError('SKILL_METADATA', `${field} 필드에 올바른 boolean 값이 필요합니다.`);
}

export function normalizeSkill(
  text: string,
  rootName: string,
  dialect: SkillDialect,
  diagnostics: SkillDiagnostic[],
) {
  const { fields, body } = splitSkill(text, dialect);
  let rawName = fields.name,
    rawDescription = fields.description;
  if (dialect === 'claude' || dialect === 'openclaw') {
    if (rawName === undefined) {
      rawName = rootName;
      diagnostics.push({
        code: 'INFERRED_NAME',
        message: 'Claude 형식에 따라 폴더 이름을 사용했습니다.',
      });
    }
    if (rawDescription === undefined) {
      rawDescription = body.split(/\r?\n/).find((line) => line.trim());
      diagnostics.push({
        code: 'INFERRED_DESCRIPTION',
        message: 'Claude 형식에 따라 첫 본문 줄을 설명으로 사용했습니다.',
      });
    }
  }
  const name = requiredText(rawName, 'name', 64);
  const description = requiredText(rawDescription, 'description', 1024);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name))
    diagnostics.push({
      code: 'NONSTANDARD_NAME',
      message: '표준 skill 이름 규칙과 다릅니다.',
      field: 'name',
    });
  if (name !== rootName)
    diagnostics.push({
      code: 'DIRECTORY_NAME_MISMATCH',
      message: 'skill 이름과 폴더 이름이 다릅니다.',
      field: 'name',
    });
  const metadata: Record<string, string> = {};
  if (fields.metadata !== undefined) {
    if (!object(fields.metadata))
      throw new AppError('SKILL_METADATA', 'metadata에는 문자열 키와 문자열 값이 필요합니다.');
    for (const [key, value] of Object.entries(fields.metadata)) {
      if (typeof value === 'string') metadata[key] = value;
      else if (dialect === 'openclaw' || dialect === 'hermes') {
        metadata[key] = JSON.stringify(value);
        diagnostics.push({
          code: 'RUNTIME_METADATA_UNVERIFIED',
          message: '외부 하네스의 환경·도구 요구 조건을 기록했지만 자동으로 권한을 부여하거나 설치하지 않습니다.',
          field: `metadata.${key}`,
        });
      } else
        throw new AppError('SKILL_METADATA', 'metadata에는 문자열 키와 문자열 값이 필요합니다.');
    }
  }
  const invocation = {
    model:
      fields['disable-model-invocation'] === undefined ||
      !boolean(fields['disable-model-invocation'], 'disable-model-invocation', dialect),
    user:
      fields['user-invocable'] === undefined ||
      boolean(fields['user-invocable'], 'user-invocable', dialect),
  };
  const known = new Set([
    'name',
    'description',
    'license',
    'compatibility',
    'metadata',
    'disable-model-invocation',
    'user-invocable',
    ...(dialect === 'hermes' ? ['version', 'author', 'platforms', 'aliases', 'category'] : []),
    ...(dialect === 'openclaw'
      ? ['homepage', 'command-arg-mode']
      : []),
  ]);
  for (const field of Object.keys(fields)) {
    if (known.has(field)) continue;
    diagnostics.push({
      code: ['allowed-tools', 'disallowed-tools', 'command-dispatch', 'command-tool'].includes(field)
        ? 'TOOL_POLICY_UNSUPPORTED'
        : 'UNSUPPORTED_METADATA',
      message: ['allowed-tools', 'disallowed-tools', 'command-dispatch', 'command-tool'].includes(field)
        ? '선언된 도구 정책을 실행 권한으로 적용하지 않습니다. Lodex의 세션 권한을 사용합니다.'
        : '이 메타데이터 기능은 적용하지 않습니다.',
      field,
    });
  }
  if (/!`/.test(body))
    diagnostics.push({
      code: 'DYNAMIC_PREPROCESSING_UNSUPPORTED',
      message: '동적 셸 삽입을 실행하거나 치환하지 않습니다.',
    });
  if (/\$(?:ARGUMENTS(?:\[\d+\])?|\d+|\{CLAUDE_[A-Z_]+\})/.test(body))
    diagnostics.push({
      code: 'SUBSTITUTION_UNSUPPORTED',
      message: '하네스 전용 인자·경로 치환을 적용하지 않습니다.',
    });
  if (/\{baseDir\}/.test(body))
    diagnostics.push({
      code: 'BASEDIR_SUBSTITUTION_UNSUPPORTED',
      message: '{baseDir}는 절대 경로로 치환하지 않습니다. 등록된 리소스는 전용 읽기 도구로만 엽니다.',
    });
  if (dialect === 'hermes' && fields.platforms !== undefined)
    diagnostics.push({
      code: 'PLATFORM_POLICY_UNVERIFIED',
      message: 'Hermes 플랫폼 제한을 기록했지만 현재 운영체제 자동 필터에는 적용하지 않습니다.',
      field: 'platforms',
    });
  return {
    name,
    description,
    metadata,
    invocation,
    ...(fields.license === undefined
      ? {}
      : { license: requiredText(fields.license, 'license', 2000) }),
    ...(fields.compatibility === undefined
      ? {}
      : { compatibility: requiredText(fields.compatibility, 'compatibility', 500) }),
  };
}

export function normalizeCompanion(
  text: string,
  invocation: RegisteredSkill['invocation'],
  diagnostics: SkillDiagnostic[],
): SkillDependency[] {
  const fields = parseMetadata(text);
  for (const field of Object.keys(fields))
    if (!['interface', 'policy', 'dependencies'].includes(field))
      diagnostics.push({
        code: 'UNSUPPORTED_METADATA',
        message: 'Codex 메타데이터 기능을 적용하지 않습니다.',
        field,
      });
  if (fields.interface !== undefined)
    diagnostics.push({
      code: 'INTERFACE_METADATA_UNSUPPORTED',
      message: 'Codex의 표시 설정은 이 모듈에서 적용하지 않습니다.',
      field: 'interface',
    });
  if (fields.policy !== undefined) {
    if (!object(fields.policy))
      throw new AppError('SKILL_METADATA', 'Codex policy는 YAML mapping이어야 합니다.');
    for (const [field, value] of Object.entries(fields.policy)) {
      if (field === 'allow_implicit_invocation')
        invocation.model = invocation.model && boolean(value, field, 'codex');
      else
        diagnostics.push({
          code: 'UNSUPPORTED_METADATA',
          message: 'Codex policy 항목을 적용하지 않습니다.',
          field: `policy.${field}`,
        });
    }
  }
  const dependencies: SkillDependency[] = [];
  if (fields.dependencies !== undefined) {
    if (!object(fields.dependencies))
      throw new AppError('SKILL_METADATA', 'Codex dependencies는 YAML mapping이어야 합니다.');
    for (const field of Object.keys(fields.dependencies))
      if (field !== 'tools')
        diagnostics.push({
          code: 'UNSUPPORTED_METADATA',
          message: '지원하지 않는 의존성 선언입니다.',
          field: `dependencies.${field}`,
        });
    const tools = fields.dependencies.tools ?? [];
    if (!Array.isArray(tools) || tools.length > 64)
      throw new AppError('SKILL_METADATA', '도구 의존성은 최대 64개 항목의 목록이어야 합니다.');
    for (const tool of tools) {
      if (!object(tool))
        throw new AppError('SKILL_METADATA', '도구 의존성은 YAML mapping이어야 합니다.');
      dependencies.push({
        type: requiredText(tool.type, 'dependency.type', 80),
        value: requiredText(tool.value, 'dependency.value', 200),
        status: 'unverified',
        ...(tool.transport === undefined
          ? {}
          : { transport: requiredText(tool.transport, 'dependency.transport', 80) }),
      });
    }
    if (dependencies.length)
      diagnostics.push({
        code: 'DEPENDENCIES_UNVERIFIED',
        message: '선언된 도구의 설치·연결 여부를 확인하지 않았습니다. 자동 연결하지 않습니다.',
      });
  }
  return dependencies;
}
