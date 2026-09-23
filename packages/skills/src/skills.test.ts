import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  access,
  link,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  inspectSkillDirectory,
  readSkill,
  readSkillResource,
  skillCatalog,
  SKILL_LIMITS,
} from './index';

const directories: string[] = [];
async function setup(
  text = '---\nname: example\ndescription: Read example files.\n---\n\nRead references/guide.md when needed.\n',
) {
  const temp = await mkdtemp(join(tmpdir(), 'lodex-skills-한글 '));
  directories.push(temp);
  const root = join(temp, 'example');
  await mkdir(join(root, 'references'), { recursive: true });
  await writeFile(join(root, 'SKILL.md'), text);
  await writeFile(join(root, 'references/guide.md'), 'Lazy reference: 원문 그대로.\n');
  return { temp, root };
}
afterEach(async () => {
  for (const path of directories.splice(0)) {
    if (dirname(resolve(path)) !== resolve(tmpdir())) throw new Error('Unsafe test path');
    await rm(path, { recursive: true, force: true });
  }
});

describe('passive skill registration', () => {
  it('preserves BOM/CRLF instructions, multiline YAML and exact byte provenance, with a metadata-only catalog', async () => {
    const text =
      '\ufeff---\r\nname: example\r\ndescription: >-\r\n  Inspect files\r\n  with Korean text.\r\nmetadata:\r\n  author: "Sample author"\r\n---\r\n\r\n# 절차\r\nRead references/guide.md.\r\n';
    const { root } = await setup(text);
    const skill = await inspectSkillDirectory(root);
    expect(skill.description).toBe('Inspect files with Korean text.');
    expect(skill.metadata).toEqual({ author: 'Sample author' });
    const catalog = skillCatalog([skill]);
    expect(catalog.skills[0]).toMatchObject({ id: skill.id, name: 'example' });
    expect(JSON.stringify(catalog)).not.toContain(root);
    expect(JSON.stringify(catalog)).not.toContain('# 절차');
    const loaded = await readSkill(skill, 'model');
    expect(loaded.text).toBe(text);
    expect(loaded.body).toBe('\r\n# 절차\r\nRead references/guide.md.\r\n');
    expect(loaded.provenance.sha256).toBe(
      createHash('sha256').update(Buffer.from(text)).digest('hex'),
    );
    expect(loaded.provenance.bytes).toBe(Buffer.byteLength(text));
    const resource = await readSkillResource(skill, 'references/guide.md', 'model');
    expect(resource.text).toBe('Lazy reference: 원문 그대로.\n');
    expect(resource.provenance).toMatchObject({
      skillId: skill.id,
      revision: skill.revision,
      path: 'references/guide.md',
    });
  });

  it('never executes scripts, dynamic shell preprocessing, hooks or dependency installation during inspection', async () => {
    const { root, temp } = await setup(
      '---\nname: example\ndescription: A workflow.\nhooks:\n  SessionStart: ./scripts/side-effect.cjs\nallowed-tools: Bash(*)\ncontext: fork\n---\n!`node scripts/side-effect.cjs`\nRun $ARGUMENTS from ${CLAUDE_SKILL_DIR}.\n',
    );
    await mkdir(join(root, 'scripts'));
    const marker = join(temp, 'must-not-exist');
    await writeFile(
      join(root, 'scripts/side-effect.cjs'),
      `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed')`,
    );
    const skill = await inspectSkillDirectory(root, { dialect: 'claude' });
    expect(skill.diagnostics.map((item) => item.code)).toEqual(
      expect.arrayContaining([
        'UNSUPPORTED_METADATA',
        'TOOL_POLICY_UNSUPPORTED',
        'DYNAMIC_PREPROCESSING_UNSUPPORTED',
        'SUBSTITUTION_UNSUPPORTED',
        'SCRIPTS_NOT_EXECUTED',
      ]),
    );
    await readSkill(skill, 'model');
    await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('leaves binary resource content unread during import and rejects it on explicit text read', async () => {
    const { root } = await setup();
    await mkdir(join(root, 'assets'));
    await writeFile(join(root, 'assets/image.bin'), Buffer.from([0xff, 0, 0xab]));
    const skill = await inspectSkillDirectory(root);
    expect(skill.files).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: 'assets/image.bin', bytes: 3 })]),
    );
    await expect(readSkillResource(skill, 'assets/image.bin', 'model')).rejects.toMatchObject({
      code: 'SKILL_ENCODING',
    });
  });

  it('accepts pi directory-name differences and reports unknown metadata without granting tools', async () => {
    const { root } = await setup(
      '---\nname: different-name\ndescription: Shared skill.\nallowed-tools: Read\nfuture-field: value\n---\nRead files.\n',
    );
    const skill = await inspectSkillDirectory(root, { dialect: 'pi' });
    expect(skill.name).toBe('different-name');
    expect(skill.diagnostics.map((d) => d.code)).toEqual(
      expect.arrayContaining([
        'DIRECTORY_NAME_MISMATCH',
        'TOOL_POLICY_UNSUPPORTED',
        'UNSUPPORTED_METADATA',
      ]),
    );
  });

  it.each(['opencode', 'openclaw', 'hermes'] as const)(
    'imports %s SKILL.md without granting its runtime policies',
    async (dialect) => {
      const extra =
        dialect === 'openclaw'
          ? 'command-dispatch: tool\ncommand-tool: exec\nmetadata:\n  openclaw:\n    requires:\n      bins: [dangerous-tool]\n'
          : dialect === 'hermes'
            ? 'version: 1.0.0\nplatforms: [linux]\nmetadata:\n  hermes:\n    requires_toolsets: [terminal]\n'
            : 'metadata:\n  source: opencode\n';
      const { root } = await setup(
        `---\nname: example\ndescription: Portable workflow.\n${extra}---\nRead {baseDir}/references/guide.md.\n`,
      );
      const skill = await inspectSkillDirectory(root, { dialect });
      expect(skill.dialect).toBe(dialect);
      expect(skill.invocation).toEqual({ model: true, user: true });
      expect(skill.diagnostics.map((entry) => entry.code)).toContain(
        'BASEDIR_SUBSTITUTION_UNSUPPORTED',
      );
      if (dialect === 'openclaw') {
        expect(skill.metadata.openclaw).toContain('dangerous-tool');
        expect(skill.diagnostics.map((entry) => entry.code)).toContain(
          'TOOL_POLICY_UNSUPPORTED',
        );
      }
      if (dialect === 'hermes') {
        expect(skill.metadata.hermes).toContain('terminal');
        expect(skill.diagnostics.map((entry) => entry.code)).toContain(
          'PLATFORM_POLICY_UNVERIFIED',
        );
      }
    },
  );

  it('supports explicit Claude fallback metadata and enforces its manual-only/user-only policy values', async () => {
    const { root } = await setup(
      '---\ndisable-model-invocation: YES\n---\nFirst instruction line.\n',
    );
    const manual = await inspectSkillDirectory(root, { dialect: 'claude' });
    expect(manual).toMatchObject({
      name: 'example',
      description: 'First instruction line.',
      invocation: { model: false, user: true },
    });
    expect(skillCatalog([manual]).policyExcludedIds).toEqual([manual.id]);
    await expect(readSkill(manual, 'model')).rejects.toMatchObject({ code: 'SKILL_INVOCATION' });
    await expect(readSkillResource(manual, 'references/guide.md', 'model')).rejects.toMatchObject({
      code: 'SKILL_INVOCATION',
    });
    expect((await readSkill(manual, 'user')).body).toContain('First instruction line.');
    await writeFile(
      join(root, 'SKILL.md'),
      '---\nname: example\ndescription: Model only.\nuser-invocable: false\n---\nBackground context.',
    );
    const automatic = await inspectSkillDirectory(root, { dialect: 'claude' });
    await expect(readSkill(automatic, 'user')).rejects.toMatchObject({ code: 'SKILL_INVOCATION' });
    expect(skillCatalog([automatic]).skills).toHaveLength(1);
  });

  it('reads Codex invocation policy and reports dependencies as unverified without connecting', async () => {
    const { root } = await setup();
    await mkdir(join(root, 'agents'));
    await writeFile(
      join(root, 'agents/openai.yaml'),
      'policy:\n  allow_implicit_invocation: false\ndependencies:\n  tools:\n    - type: mcp\n      value: sample-server\n      transport: streamable_http\n      url: https://127.0.0.1:1/never-connect\n',
    );
    const skill = await inspectSkillDirectory(root, { dialect: 'codex' });
    expect(skill.invocation.model).toBe(false);
    expect(skill.dependencies).toEqual([
      { type: 'mcp', value: 'sample-server', transport: 'streamable_http', status: 'unverified' },
    ]);
    await expect(readSkill(skill, 'model')).rejects.toMatchObject({ code: 'SKILL_INVOCATION' });
    expect((await readSkill(skill, 'user')).text).toContain('name: example');
  });

  it.each([
    'name: example\nname: duplicate\ndescription: Test.',
    'name: example\ndescription: &desc Test.\ncopy: *desc',
    'name: example\ndescription: !custom Test.',
    'name: example\ndescription: [broken',
    'name: example\ndescription: Test.\nmetadata:\n  constructor: forbidden',
  ])(
    'rejects malformed, aliased or unsafe YAML without echoing its content: %s',
    async (frontmatter) => {
      const { root } = await setup(`---\n${frontmatter}\n---\nBody.`);
      await expect(inspectSkillDirectory(root)).rejects.toMatchObject({ code: 'SKILL_METADATA' });
    },
  );

  it('rejects invalid UTF-8 and oversized instructions rather than truncating them', async () => {
    const { root } = await setup();
    await writeFile(join(root, 'SKILL.md'), Buffer.from([0xff, 0xab]));
    await expect(inspectSkillDirectory(root)).rejects.toMatchObject({ code: 'SKILL_ENCODING' });
    await writeFile(join(root, 'SKILL.md'), 'x'.repeat(SKILL_LIMITS.entryBytes + 1));
    await expect(inspectSkillDirectory(root)).rejects.toMatchObject({ code: 'SKILL_SIZE' });
  });

  it('limits folder depth and entry count with explicit errors', async () => {
    const { root } = await setup();
    await mkdir(join(root, ...Array.from({ length: 9 }, () => 'nested')), { recursive: true });
    await writeFile(join(root, ...Array.from({ length: 9 }, () => 'nested'), 'file.txt'), 'deep');
    await expect(inspectSkillDirectory(root)).rejects.toMatchObject({ code: 'SKILL_DEPTH' });
    const other = await setup();
    await Promise.all(
      Array.from({ length: SKILL_LIMITS.entries }, (_, i) =>
        writeFile(join(other.root, `file-${i}.txt`), ''),
      ),
    );
    await expect(inspectSkillDirectory(other.root)).rejects.toMatchObject({ code: 'SKILL_COUNT' });
  });

  it('catalogs duplicate names by distinct IDs and reports budget omissions without cutting descriptions', async () => {
    const first = await setup(),
      second = await setup();
    const a = await inspectSkillDirectory(first.root),
      b = await inspectSkillDirectory(second.root);
    expect(skillCatalog([a, b]).skills.map((s) => s.name)).toEqual(['example', 'example']);
    const bytes = skillCatalog([a]).serializedBytes;
    const limited = skillCatalog([a, b], { maxBytes: bytes });
    expect(limited.skills.map((s) => s.id)).toEqual([a.id]);
    expect(limited.omittedIds).toEqual([b.id]);
    expect(limited.skills[0]!.description).toBe(a.description);
  });
});

describe('registered skill read boundaries', () => {
  it('blocks traversal, absolute paths, Windows special paths and excluded secrets', async () => {
    const { root, temp } = await setup();
    await writeFile(join(temp, 'outside.txt'), 'private');
    await writeFile(join(root, '.env'), 'API_KEY=private');
    await writeFile(join(root, 'private.key'), 'private');
    await mkdir(join(root, 'node_modules'));
    await writeFile(join(root, 'node_modules/dependency.txt'), 'private');
    const skill = await inspectSkillDirectory(root);
    expect(skill.files.map((f) => f.path)).not.toEqual(
      expect.arrayContaining(['.env', 'private.key', 'node_modules/dependency.txt']),
    );
    for (const path of [
      '../outside.txt',
      join(temp, 'outside.txt'),
      'C:\\secret.txt',
      '\\\\server\\share',
      'references/guide.md:private',
      '.env',
      'private.key',
      'node_modules/dependency.txt',
      'references/CON',
      'references/guide.md.',
    ])
      await expect(readSkillResource(skill, path, 'model')).rejects.toMatchObject({
        code: 'SKILL_PATH',
      });
    await writeFile(join(root, 'new.txt'), 'unregistered');
    await expect(readSkillResource(skill, 'new.txt', 'model')).rejects.toMatchObject({
      code: 'SKILL_RESOURCE',
    });
  });

  it('excludes junction/symlink resources and rejects registered resources replaced by a link', async () => {
    const { root, temp } = await setup();
    const outside = join(temp, 'outside');
    await mkdir(outside);
    await writeFile(join(outside, 'private.txt'), 'private');
    await symlink(outside, join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    const skill = await inspectSkillDirectory(root);
    expect(skill.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'EXCLUDED_LINK', path: 'linked' })]),
    );
    expect(skill.files.some((f) => f.path.startsWith('linked/'))).toBe(false);
    const registered = join(root, 'references');
    await rename(registered, join(root, 'old-references'));
    await symlink(outside, registered, process.platform === 'win32' ? 'junction' : 'dir');
    await expect(readSkillResource(skill, 'references/guide.md', 'model')).rejects.toMatchObject({
      code: 'SKILL_PATH',
    });
  });

  it('excludes hardlinked files from import', async () => {
    const { root, temp } = await setup();
    await writeFile(join(temp, 'outside.txt'), 'private');
    await link(join(temp, 'outside.txt'), join(root, 'linked.txt'));
    const skill = await inspectSkillDirectory(root);
    expect(skill.files.some((f) => f.path === 'linked.txt')).toBe(false);
    expect(skill.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'EXCLUDED_FILE', path: 'linked.txt' }),
      ]),
    );
  });

  it('detects modified entry/resource files and replaced roots before content is returned', async () => {
    const { root, temp } = await setup();
    const skill = await inspectSkillDirectory(root);
    await writeFile(join(root, 'references/guide.md'), 'Changed after registration.');
    await expect(readSkillResource(skill, 'references/guide.md', 'model')).rejects.toMatchObject({
      code: 'SKILL_CHANGED',
    });
    await writeFile(
      join(root, 'SKILL.md'),
      (await readFile(join(root, 'SKILL.md'), 'utf8')) + '\nChanged instructions.',
    );
    await expect(readSkill(skill, 'model')).rejects.toMatchObject({ code: 'SKILL_CHANGED' });
    await rename(root, join(temp, 'old-root'));
    await mkdir(root);
    await expect(readSkill(skill, 'model')).rejects.toMatchObject({ code: 'SKILL_CHANGED' });
  });

  it('detects a policy file added after registration and changed Codex sidecars', async () => {
    const { root } = await setup();
    const first = await inspectSkillDirectory(root);
    await mkdir(join(root, 'agents'));
    await writeFile(
      join(root, 'agents/openai.yaml'),
      'policy:\n  allow_implicit_invocation: true\n',
    );
    await expect(readSkill(first, 'model')).rejects.toMatchObject({ code: 'SKILL_CHANGED' });
    const second = await inspectSkillDirectory(root);
    await writeFile(
      join(root, 'agents/openai.yaml'),
      'policy:\n  allow_implicit_invocation: false\n',
    );
    await expect(readSkill(second, 'model')).rejects.toMatchObject({ code: 'SKILL_CHANGED' });
  });

  it('enforces caller byte budgets and cancellation without returning shortened instructions', async () => {
    const { root } = await setup();
    const skill = await inspectSkillDirectory(root);
    await expect(readSkill(skill, 'model', undefined, { maxBytes: 10 })).rejects.toMatchObject({
      code: 'SKILL_SIZE',
    });
    await expect(
      readSkillResource(skill, 'references/guide.md', 'model', undefined, { maxBytes: 10 }),
    ).rejects.toMatchObject({ code: 'SKILL_SIZE' });
    await expect(
      readSkillResource(skill, 'references/guide.md', 'model', undefined, { maxBytes: -1 }),
    ).rejects.toMatchObject({ code: 'SKILL_SIZE' });
    const aborted = AbortSignal.abort(new Error('cancelled by caller'));
    await expect(inspectSkillDirectory(root, { signal: aborted })).rejects.toThrow(
      'cancelled by caller',
    );
    await expect(readSkill(skill, 'model', aborted)).rejects.toThrow('cancelled by caller');
  });
});
