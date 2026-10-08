import { AppError, type ToolDefinition } from '@lodex/contracts';
import type { RegisteredSkill } from '@lodex/skills';

const aliases: Record<string, readonly string[]> = {
  Read: ['read_file', 'read_many_files', 'host_read_file', 'read_skill_resource'],
  Glob: ['list_files', 'find_files', 'host_list_files'],
  Grep: ['search_text'],
  Edit: ['propose_edit'],
  Write: ['propose_changes', 'host_write_file'],
  Bash: [
    'run_command',
    'run_host_command',
    'write_command_input',
    'stop_command_job',
    'resize_command_terminal',
  ],
  WebFetch: ['web_fetch'],
  WebSearch: ['web_search'],
  Skill: ['read_skill', 'read_skill_resource'],
  TodoWrite: ['propose_plan', 'set_task_list', 'update_task'],
  Task: ['delegate_tasks'],
  Agent: ['delegate_tasks'],
};
const nativeTools = new Set([
  ...Object.values(aliases).flat(),
  'inspect_path',
  'make_directory',
  'move_path',
  'delete_path',
  'read_command_job',
  'review_worktree',
  'merge_worktree',
  'search_history',
  'read_tool_result',
  'recall_observation',
  'verify_task',
  'verify_goal',
  'complete_goal',
  'review_work',
]);
export interface SkillPolicy {
  allowed?: Set<string>;
  denied: Set<string>;
}
export function compileSkillPolicy(
  value: RegisteredSkill['toolPolicy'],
  available: readonly ToolDefinition[],
): SkillPolicy | undefined {
  if (!value) return undefined;
  if (value.unsupported.length)
    throw new AppError(
      'SKILL_TOOL_POLICY',
      '지원하지 않는 스킬 도구 정책입니다. 스킬의 allowed-tools/disallowed-tools를 단순 도구 이름으로 수정하세요.',
    );
  const resolve = (name: string) => {
    if (aliases[name]) return aliases[name];
    if (nativeTools.has(name) || available.some((tool) => tool.function.name === name))
      return [name];
    throw new AppError(
      'SKILL_TOOL_POLICY',
      `스킬 도구 이름 ${name}을 Lodex 도구로 매핑할 수 없습니다. 자동으로 권한을 넓히지 않았습니다.`,
    );
  };
  const denied = new Set(value.denied.flatMap(resolve));
  // An edit-capable alternative must not bypass an explicit Edit denial.
  if (value.denied.some((name) => name === 'Edit' || name === 'Write'))
    ['propose_edit', 'propose_changes', 'host_write_file'].forEach((name) => denied.add(name));
  // Delegated models have independent tool catalogs; keep restrictive skills in this run.
  denied.add('delegate_tasks');
  return { denied, ...(value.allowed ? { allowed: new Set(value.allowed.flatMap(resolve)) } : {}) };
}
export function filterSkillTools(
  tools: readonly ToolDefinition[],
  policies: readonly SkillPolicy[],
) {
  return tools.filter((tool) =>
    policies.every(
      (policy) =>
        !policy.denied.has(tool.function.name) &&
        (!policy.allowed || policy.allowed.has(tool.function.name)),
    ),
  );
}
export function checkSkillDependencies(
  skill: RegisteredSkill,
  selected: readonly { id: string; name: string; transport: string }[],
) {
  const missing = skill.dependencies.filter(
    (dependency) =>
      dependency.type !== 'mcp' ||
      !selected.some(
        (server) =>
          (server.id === dependency.value ||
            server.name.toLowerCase() === dependency.value.toLowerCase()) &&
          (!dependency.transport || dependency.transport === server.transport),
      ),
  );
  if (missing.length)
    throw new AppError(
      'SKILL_DEPENDENCY',
      '스킬이 요구하는 MCP 연결이 선택되어 있지 않거나 지원하지 않는 의존성입니다. 스킬의 의존성 목록과 이 대화의 MCP 선택을 확인하세요. 자동 설치·연결하지 않았습니다.',
    );
}
