import { describe, expect, it } from 'vitest';
import type { ToolDefinition } from '@lodex/contracts';
import type { RegisteredSkill } from '@lodex/skills';
import { checkSkillDependencies, compileSkillPolicy, filterSkillTools } from './skill-policy';

const tools = (...names: string[]): ToolDefinition[] =>
  names.map((name) => ({
    type: 'function',
    function: { name, description: name, parameters: {} },
  }));
const names = (value: ToolDefinition[]) => value.map((tool) => tool.function.name);

describe('restrictive skill tool policies', () => {
  it('intersects aliases and policies without providing unavailable host or write tools', () => {
    const available = tools('read_file', 'web_fetch', 'propose_edit', 'run_command');
    const allow = compileSkillPolicy(
      { allowed: ['Read', 'Bash', 'WebFetch'], denied: [], unsupported: [] },
      available,
    )!;
    const deny = compileSkillPolicy({ denied: ['Bash'], unsupported: [] }, available)!;
    expect(names(filterSkillTools(available, [allow, deny]))).toEqual(['read_file', 'web_fetch']);
    expect(names(filterSkillTools(tools('read_file'), [allow]))).toEqual(['read_file']);
    expect(
      filterSkillTools(available, [
        compileSkillPolicy({ allowed: [], denied: [], unsupported: [] }, available)!,
      ]),
    ).toEqual([]);
  });

  it('rejects unknown and parameterized policy grammar instead of widening the tool pool', () => {
    expect(() =>
      compileSkillPolicy(
        { allowed: ['Bash(git *)'], denied: [], unsupported: ['allowed-tools'] },
        [],
      ),
    ).toThrow('지원하지 않는');
    expect(() =>
      compileSkillPolicy({ allowed: ['UnknownTool'], denied: [], unsupported: [] }, []),
    ).toThrow('매핑');
    const selectedMcp = tools('mcp_selected_tool');
    expect(
      names(
        filterSkillTools(selectedMcp, [
          compileSkillPolicy(
            { allowed: ['mcp_selected_tool'], denied: [], unsupported: [] },
            selectedMcp,
          )!,
        ]),
      ),
    ).toEqual(['mcp_selected_tool']);
    expect(() =>
      compileSkillPolicy(
        { allowed: ['mcp_unselected_tool'], denied: [], unsupported: [] },
        selectedMcp,
      ),
    ).toThrow('매핑');
  });

  it('blocks equivalent file writes and independent delegated catalogs after Edit denial', () => {
    const available = tools(
      'propose_edit',
      'propose_changes',
      'host_write_file',
      'delegate_tasks',
      'read_file',
    );
    const policy = compileSkillPolicy({ denied: ['Edit'], unsupported: [] }, available)!;
    expect(names(filterSkillTools(available, [policy]))).toEqual(['read_file']);
  });

  it('requires selected MCP dependencies with a matching declared transport', () => {
    const skill = {
      dependencies: [{ type: 'mcp', value: 'Context7', transport: 'http', status: 'unverified' }],
    } as RegisteredSkill;
    expect(() => checkSkillDependencies(skill, [])).toThrow('MCP');
    expect(() =>
      checkSkillDependencies(skill, [{ id: 'one', name: 'context7', transport: 'stdio' }]),
    ).toThrow('MCP');
    expect(() =>
      checkSkillDependencies(skill, [{ id: 'one', name: 'context7', transport: 'http' }]),
    ).not.toThrow();
    skill.dependencies[0]!.type = 'install';
    expect(() =>
      checkSkillDependencies(skill, [{ id: 'one', name: 'context7', transport: 'http' }]),
    ).toThrow('의존성');
  });
});
