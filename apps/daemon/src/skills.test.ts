import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { inspectSkillDirectory, type RegisteredSkill } from '@lodex/skills';
import { prepareDirectSkill, runSkillTool, skillTools } from './skills';

const directories: string[] = [];
async function setup(manualOnly = false) {
  const temp = await mkdtemp(join(tmpdir(), 'lodex-skill-adapter-'));
  directories.push(temp);
  const root = join(temp, 'example');
  await mkdir(join(root, 'references'), { recursive: true });
  await writeFile(
    join(root, 'SKILL.md'),
    `---\nname: example\ndescription: A selected skill.\ndisable-model-invocation: ${manualOnly}\n---\nRead references/guide.md.\n`,
  );
  await writeFile(join(root, 'references/guide.md'), 'Original resource content.\n');
  const skill = await inspectSkillDirectory(root);
  const record = vi.fn();
  const run = (
    name: string,
    args: unknown,
    skills: RegisteredSkill[] = [skill],
    maxBytes = 24000,
  ) =>
    runSkillTool({
      skills,
      name,
      argumentsJson: JSON.stringify(args),
      signal: new AbortController().signal,
      maxBytes,
      record,
    });
  return { root, skill, record, run, args: { skillId: skill.id, revision: skill.revision } };
}
afterEach(async () => {
  for (const path of directories.splice(0)) {
    if (dirname(resolve(path)) !== resolve(tmpdir())) throw new Error('Unsafe test path');
    await rm(path, { recursive: true, force: true });
  }
});

describe('session-selected skill tools', () => {
  it('validates fresh policy metadata for entry and resource reads, including old registrations', async () => {
    const { root } = await setup();
    await writeFile(
      join(root, 'SKILL.md'),
      '---\nname: example\ndescription: Restricted.\nallowed-tools: Read\n---\nRead $0 using {baseDir}.\n',
    );
    const registered = await inspectSkillDirectory(root);
    const { toolPolicy: _savedPolicy, ...legacy } = registered;
    for (const name of ['read_skill', 'read_skill_resource']) {
      const activate = vi.fn(),
        record = vi.fn();
      const result = JSON.parse(
        await runSkillTool({
          skills: [legacy],
          name,
          argumentsJson: JSON.stringify({
            skillId: legacy.id,
            revision: legacy.revision,
            ...(name === 'read_skill'
              ? { arguments: 'source.ts' }
              : { path: 'references/guide.md' }),
          }),
          signal: new AbortController().signal,
          maxBytes: 24000,
          record,
          activate,
        }),
      );
      expect(result.error).toBeUndefined();
      expect(activate).toHaveBeenCalledOnce();
      expect(activate.mock.calls[0]![0].allowed.has('read_file')).toBe(true);
      if (name === 'read_skill')
        expect(result.content).toContain(`Read source.ts using ${await realpath(root)}`);
    }
  });

  it('allows resources of a directly invoked manual-only skill and checks declared dependencies before reading', async () => {
    const { skill, args } = await setup(true);
    const direct = await prepareDirectSkill(
      '/example hello',
      [skill],
      skillTools,
      [],
      new AbortController().signal,
    );
    expect(direct?.content).toContain('ARGUMENTS: hello');
    const output = JSON.parse(
      await runSkillTool({
        skills: [skill],
        name: 'read_skill_resource',
        argumentsJson: JSON.stringify({ ...args, path: 'references/guide.md' }),
        userSkillId: direct!.skill.id,
        signal: new AbortController().signal,
        maxBytes: 24000,
        record: vi.fn(),
      }),
    );
    expect(output.content).toContain('Original resource');
    const missing = {
      ...skill,
      dependencies: [{ type: 'mcp', value: 'selected-server', status: 'unverified' as const }],
    };
    await expect(
      prepareDirectSkill('/example', [missing], skillTools, [], new AbortController().signal),
    ).rejects.toMatchObject({ code: 'SKILL_DEPENDENCY' });
  });

  it('exposes strict skill tools and returns complete selected content with recorded provenance', async () => {
    expect(skillTools.map((t) => t.function.name)).toEqual(['read_skill', 'read_skill_resource']);
    for (const tool of skillTools)
      expect(tool.function.parameters).toMatchObject({ additionalProperties: false });
    const { run, args, root, record, skill } = await setup();
    const instructions = JSON.parse(await run('read_skill', args));
    expect(instructions.content).toContain('Read references/guide.md.');
    expect(instructions.skill).toMatchObject({ id: skill.id, revision: skill.revision });
    expect(instructions.provenance).toMatchObject({ skillId: skill.id, path: 'SKILL.md' });
    expect(record).toHaveBeenCalledWith(instructions.provenance);
    expect(JSON.stringify(instructions)).not.toContain(root);
    const resource = JSON.parse(
      await run('read_skill_resource', { ...args, path: 'references/guide.md' }),
    );
    expect(resource.content).toBe('Original resource content.\n');
    expect(record).toHaveBeenLastCalledWith(resource.provenance);
  });

  it('refuses unselected IDs and mismatched revisions before recording or returning content', async () => {
    const { run, args, record } = await setup();
    expect(JSON.parse(await run('read_skill', args, [])).error).toBe('SKILL_NOT_SELECTED');
    expect(JSON.parse(await run('read_skill', { ...args, skillId: randomUUID() })).error).toBe(
      'SKILL_NOT_SELECTED',
    );
    expect(JSON.parse(await run('read_skill', { ...args, revision: '0'.repeat(64) })).error).toBe(
      'SKILL_REVISION',
    );
    expect(record).not.toHaveBeenCalled();
  });

  it('enforces manual-only invocation for resources as well as the instruction entry', async () => {
    const { run, args, record } = await setup(true);
    expect(JSON.parse(await run('read_skill', args)).error).toBe('SKILL_INVOCATION');
    expect(
      JSON.parse(await run('read_skill_resource', { ...args, path: 'references/guide.md' })).error,
    ).toBe('SKILL_INVOCATION');
    expect(JSON.parse(await run('read_skill', { ...args, invocation: 'user' })).error).toBe(
      'SKILL_ARGUMENTS',
    );
    expect(record).not.toHaveBeenCalled();
  });

  it('rejects extra arguments, invalid JSON, missing paths and unknown tools without reflecting supplied secrets', async () => {
    const { run, args, record } = await setup();
    const extra = await run('read_skill', { ...args, rootPath: 'C:/private/secret' });
    expect(JSON.parse(extra).error).toBe('SKILL_ARGUMENTS');
    expect(extra).not.toContain('C:/private/secret');
    expect(JSON.parse(await run('read_skill_resource', args)).error).toBe('SKILL_ARGUMENTS');
    expect(JSON.parse(await run('not_a_tool', args)).error).toBe('SKILL_TOOL_UNAVAILABLE');
    const malformed = await runSkillTool({
      skills: [],
      name: 'read_skill',
      argumentsJson: '{ "private": secret',
      signal: new AbortController().signal,
      maxBytes: 24000,
      record,
    });
    expect(JSON.parse(malformed).error).toBe('SKILL_ARGUMENTS');
    expect(malformed).not.toContain('secret');
    expect(record).not.toHaveBeenCalled();
  });

  it('returns an explicit size error instead of truncated content, including JSON escape overhead', async () => {
    const { run, args, record, root } = await setup();
    const small = JSON.parse(await run('read_skill', args, undefined, 10));
    expect(small.error).toBe('SKILL_SIZE');
    expect(small.content).toBeUndefined();
    await writeFile(join(root, 'references/guide.md'), '\\'.repeat(800));
    const skill = await inspectSkillDirectory(root);
    const resource = JSON.parse(
      await run(
        'read_skill_resource',
        { skillId: skill.id, revision: skill.revision, path: 'references/guide.md' },
        [skill],
        1000,
      ),
    );
    expect(resource.error).toBe('SKILL_SIZE');
    expect(resource.content).toBeUndefined();
    expect(record).not.toHaveBeenCalled();
  });

  it('reports missing or changed sources without exposing filesystem error paths', async () => {
    const { run, args, record, root } = await setup();
    await writeFile(join(root, 'references/guide.md'), 'Changed resource');
    expect(
      JSON.parse(await run('read_skill_resource', { ...args, path: 'references/guide.md' })).error,
    ).toBe('SKILL_CHANGED');
    await rm(join(root, 'SKILL.md'));
    const unavailable = await run('read_skill', args);
    expect(JSON.parse(unavailable).error).toBe('SKILL_SOURCE_UNAVAILABLE');
    expect(unavailable).not.toContain(root);
    expect(record).not.toHaveBeenCalled();
  });

  it('propagates cancellation to the run lifecycle rather than converting it to a tool result', async () => {
    const { skill, args, record } = await setup();
    await expect(
      runSkillTool({
        skills: [skill],
        name: 'read_skill',
        argumentsJson: JSON.stringify(args),
        signal: AbortSignal.abort(new Error('run cancelled')),
        maxBytes: 24000,
        record,
      }),
    ).rejects.toThrow('run cancelled');
    expect(record).not.toHaveBeenCalled();
  });
});
