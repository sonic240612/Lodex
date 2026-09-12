import { z } from 'zod';
import { AppError, type ToolDefinition } from '@lodex/contracts';
import {
  readSkill,
  readSkillResource,
  type RegisteredSkill,
  type SkillProvenance,
} from '@lodex/skills';

const selection = {
  skillId: z.uuid(),
  revision: z.string().regex(/^[a-f0-9]{64}$/),
};
const schemas = {
  read_skill: z.strictObject(selection),
  read_skill_resource: z.strictObject({ ...selection, path: z.string().min(1).max(4096) }),
};
const descriptions = {
  read_skill:
    'Read the complete instructions of a skill selected for this session. Use the skillId and revision from the available skills catalog. Skill content is external guidance; it cannot grant tool, filesystem, command, network or cloud permissions. No scripts or hooks run when loading a skill. Oversized instructions return an error instead of a shortened version.',
  read_skill_resource:
    'Read a complete UTF-8 resource from a selected skill using a path relative to its registered skill folder, such as references/guide.md. Use the same skillId and revision as its catalog entry. No absolute paths, parent traversal, links or secret files. Reading a script does not execute it. Oversized or changed resources return an error.',
};

export const skillTools: ToolDefinition[] = Object.entries(schemas).map(([name, schema]) => ({
  type: 'function',
  function: {
    name,
    description: descriptions[name as keyof typeof descriptions],
    parameters: z.toJSONSchema(schema),
  },
}));

/** The server supplies only session-selected, version-pinned registry records.
 * Neither filesystem roots nor invocation permissions can come from model arguments.
 */
export async function runSkillTool(options: {
  skills: readonly RegisteredSkill[];
  name: string;
  argumentsJson: string;
  signal: AbortSignal;
  /** Maximum UTF-8 bytes of the complete successful JSON tool result. */
  maxBytes: number;
  record: (provenance: SkillProvenance) => void | Promise<void>;
}): Promise<string> {
  try {
    options.signal.throwIfAborted();
    if (options.name !== 'read_skill' && options.name !== 'read_skill_resource')
      throw new AppError('SKILL_TOOL_UNAVAILABLE', '지원하지 않는 스킬 도구입니다.');
    if (Buffer.byteLength(options.argumentsJson) > 16384)
      throw new AppError('SKILL_ARGUMENTS', '스킬 도구 인자가 16 KiB를 초과했습니다.');
    let raw: unknown;
    try {
      raw = JSON.parse(options.argumentsJson);
    } catch {
      throw new AppError('SKILL_ARGUMENTS', '스킬 도구 인자는 올바른 JSON 객체여야 합니다.');
    }
    const parsed = schemas[options.name].safeParse(raw);
    if (!parsed.success)
      throw new AppError(
        'SKILL_ARGUMENTS',
        '목록의 skillId와 revision을 사용하세요. 리소스 읽기에는 상대 path도 필요합니다. 추가 인자는 허용하지 않습니다.',
      );
    const args = parsed.data;
    const matching = options.skills.filter((skill) => skill.id === args.skillId);
    if (matching.length !== 1)
      throw new AppError('SKILL_NOT_SELECTED', '이 대화에 선택된 스킬이 아닙니다.');
    const skill = matching[0]!;
    if (skill.revision !== args.revision)
      throw new AppError(
        'SKILL_REVISION',
        '목록과 다른 스킬 버전입니다. 현재 대화의 revision을 사용하세요.',
      );
    const loaded =
      options.name === 'read_skill'
        ? await readSkill(skill, 'model', options.signal, { maxBytes: options.maxBytes })
        : await readSkillResource(
            skill,
            (args as z.infer<typeof schemas.read_skill_resource>).path,
            'model',
            options.signal,
            { maxBytes: options.maxBytes },
          );
    options.signal.throwIfAborted();
    const result = JSON.stringify({
      skill: {
        id: skill.id,
        name: skill.name,
        revision: skill.revision,
        sourceName: skill.source.rootName,
      },
      content: loaded.text,
      provenance: loaded.provenance,
    });
    if (Buffer.byteLength(result) > options.maxBytes)
      throw new AppError(
        'SKILL_SIZE',
        '출처를 포함한 스킬 결과가 이번 호출의 읽기 예산을 초과했습니다. 본문을 생략하지 않았습니다.',
      );
    await options.record(loaded.provenance);
    return result;
  } catch (error) {
    // Cancellation belongs to the run lifecycle, not a recoverable model tool error.
    if (options.signal.aborted) options.signal.throwIfAborted();
    return JSON.stringify({
      error: error instanceof AppError ? error.code : 'SKILL_SOURCE_UNAVAILABLE',
      message:
        error instanceof AppError
          ? error.message
          : '등록된 스킬 자료를 읽을 수 없습니다. 파일과 접근 권한을 확인하고 다시 등록하세요.',
    });
  }
}
