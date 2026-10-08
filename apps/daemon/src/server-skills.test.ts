import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  defaultModelConfig,
  makeCommand,
  type InferenceProvider,
  type InferenceRequest,
  type Session,
} from '@lodex/contracts';
import type { RegisteredSkill } from '@lodex/skills';
import { Store } from '@lodex/storage';
import { startServer } from './server';

const BODY = 'PRIVATE_SKILL_BODY: Read the guide and preserve the stated constraints.';
const RESOURCE = 'PRIVATE_SKILL_RESOURCE: 회귀 검증 후 결과를 보고하세요.';
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});

const plainProvider = (requests: InferenceRequest[]): InferenceProvider => ({
  listModels: async () => [],
  capabilities: async () => ({ tools: true, streaming: true }),
  async *generate(request) {
    requests.push(structuredClone(request));
    yield { type: 'text_delta', text: 'Fixture response.' };
    yield { type: 'finished', reason: 'stop' };
  },
});

async function fixture(
  provider: InferenceProvider,
  manualOnly = false,
  metadata = '',
  body = BODY,
) {
  const dir = await mkdtemp(join(tmpdir(), 'lodex-skills-api-'));
  const root = join(dir, 'sample-skill');
  await mkdir(join(root, 'references'), { recursive: true });
  await writeFile(
    join(root, 'SKILL.md'),
    `---\nname: sample-skill\ndescription: A selected review workflow.\ndisable-model-invocation: ${manualOnly}\n${metadata}\n---\n${body}\n`,
  );
  await writeFile(join(root, 'references/guide.md'), RESOURCE);
  const store = await Store.open(join(dir, 'state.sqlite'), resolve('apps/daemon/dist/worker.cjs'));
  const factory = vi.fn(() => provider);
  const app = await startServer({
    token: 's'.repeat(64),
    store,
    openrouterKey: 'test-key-not-sent-to-network',
    providerFactory: factory,
  });
  cleanups.push(async () => {
    await app.close();
    if (dirname(resolve(dir)) !== resolve(tmpdir())) throw new Error('Unsafe fixture directory');
    await rm(dir, { recursive: true, force: true });
  });
  const request = (path: string, value?: unknown) =>
    fetch(`http://127.0.0.1:${app.port}${path}`, {
      method: value === undefined ? 'GET' : 'POST',
      headers: { Authorization: 'Bearer ' + 's'.repeat(64), 'Content-Type': 'application/json' },
      ...(value === undefined ? {} : { body: JSON.stringify(value) }),
    });
  const registered = await request('/v1/skills/register', { path: root, dialect: 'standard' });
  expect(registered.status).toBe(200);
  const skill = (await registered.json()).skill as RegisteredSkill;
  const create = async (cloud = false) => {
    const created = await request(
      '/v1/commands',
      makeCommand({
        type: 'create_session',
        sessionId: crypto.randomUUID(),
        title: 'Skills fixture',
        mode: 'plan',
        config: {
          ...defaultModelConfig(),
          provider: cloud ? 'openrouter' : 'llama-server',
          model: 'fixture-model',
          cloudConsent: cloud,
        },
      }),
    );
    expect(created.status).toBe(200);
    return (await created.json()).session as Session;
  };
  const configure = async (
    session: Session,
    skills = [{ id: skill.id, revision: skill.revision }],
    skillCloudConsent = false,
  ) => {
    const response = await request(
      '/v1/commands',
      makeCommand({
        type: 'configure_skills',
        sessionId: session.id,
        expectedVersion: session.version,
        skills,
        skillCloudConsent,
      }),
    );
    expect(response.status).toBe(200);
    return (await response.json()).session as Session;
  };
  const send = (session: Session, content = 'Inspect the selected workflow.') =>
    request(
      '/v1/commands',
      makeCommand({
        type: 'send_message',
        sessionId: session.id,
        expectedVersion: session.version,
        content,
      }),
    );
  const finished = async (id: string) => {
    await expect.poll(async () => (await store.session(id)).run?.status).toBe('completed');
    return store.session(id);
  };
  return { dir, store, request, factory, root, skill, create, configure, send, finished };
}

function readingProvider(
  getSkill: () => RegisteredSkill,
  requests: InferenceRequest[],
  resources = false,
): InferenceProvider {
  let round = 0;
  return {
    listModels: async () => [],
    capabilities: async () => ({ tools: true, streaming: true }),
    async *generate(request) {
      requests.push(structuredClone(request));
      const skill = getSkill();
      if (round === 0 || (resources && round === 1)) {
        const resource = round === 1;
        yield {
          type: 'tool_call_delta',
          index: 0,
          id: 'skill-read-' + round++,
          name: resource ? 'read_skill_resource' : 'read_skill',
          arguments: JSON.stringify({
            skillId: skill.id,
            revision: skill.revision,
            ...(resource ? { path: 'references/guide.md' } : {}),
          }),
        };
        yield { type: 'finished', reason: 'tool_calls' };
      } else {
        yield { type: 'text_delta', text: 'Loaded the selected instructions.' };
        yield { type: 'finished', reason: 'stop' };
      }
    },
  };
}

describe('skills daemon integration', () => {
  it('blocks a fused command before a directly invoked Build skill can alter files', async () => {
    let round = 0;
    const requests: InferenceRequest[] = [];
    const provider: InferenceProvider = {
      listModels: async () => [],
      capabilities: async () => ({ tools: true, streaming: true }),
      async *generate(request) {
        requests.push(structuredClone(request));
        if (round++ === 0) {
          yield {
            type: 'tool_call_delta',
            index: 0,
            id: 'fused-write',
            name: 'host_write_file',
            arguments: JSON.stringify({
              path: 'must-not-change.txt',
              content: 'changed',
              thenRun: { command: 'must-not-execute' },
            }),
          };
          yield { type: 'finished', reason: 'tool_calls' };
        } else {
          yield { type: 'text_delta', text: 'The command is excluded by the skill.' };
          yield { type: 'finished', reason: 'stop' };
        }
      },
    };
    const app = await fixture(provider, true, 'allowed-tools: Write');
    const { project } = await (await app.request('/v1/projects', { path: app.dir })).json();
    let session = (
      await (
        await app.request(
          '/v1/commands',
          makeCommand({
            type: 'create_session',
            sessionId: crypto.randomUUID(),
            title: 'Build skill',
            projectId: project.id,
            mode: 'build',
            config: { ...defaultModelConfig(), provider: 'demo', model: 'demo' },
          }),
        )
      ).json()
    ).session as Session;
    session = (
      await (
        await app.request(
          '/v1/commands',
          makeCommand({
            type: 'set_permission_mode',
            sessionId: session.id,
            expectedVersion: session.version,
            mode: 'full',
          }),
        )
      ).json()
    ).session as Session;
    session = await app.configure(session);
    expect((await app.send(session, '/sample-skill')).status).toBe(200);
    const completed = await app.finished(session.id);
    expect(requests[0]?.tools?.some((tool) => tool.function.name === 'host_write_file')).toBe(true);
    expect(requests[0]?.tools?.some((tool) => tool.function.name === 'run_host_command')).toBe(
      false,
    );
    const output = completed.messages
      .at(-1)
      ?.continuation?.find((message) => message.role === 'tool');
    expect(JSON.parse(output!.content)).toMatchObject({
      error: 'SKILL_TOOL_POLICY',
      executed: false,
    });
    await expect(readFile(join(app.dir, 'must-not-change.txt'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('runs an explicitly invoked manual-only skill in Plan with literal arguments and durable provenance', async () => {
    const requests: InferenceRequest[] = [];
    const app = await fixture(
      plainProvider(requests),
      true,
      'allowed-tools: Read, Bash',
      'Review $0 using ${CLAUDE_SKILL_DIR}/references. Keep $ARGUMENTS[1] literal.',
    );
    let session = await app.configure(await app.create());
    expect((await app.send(session)).status).toBe(200);
    session = await app.finished(session.id);
    expect(JSON.stringify(requests[0])).not.toContain('A selected review workflow.');
    expect((await app.send(session, '/skill sample-skill "source file" "$ARGUMENTS"')).status).toBe(
      200,
    );
    session = await app.finished(session.id);
    const direct = requests[1]!;
    expect(JSON.stringify(direct.messages)).toContain('Review source file using');
    expect(JSON.stringify(direct.messages)).toContain('Keep $ARGUMENTS literal.');
    const skillDirectory = await realpath(app.root);
    expect(direct.messages.some((message) => message.content.includes(skillDirectory))).toBe(true);
    expect(
      direct.tools?.some((tool) =>
        /run_(host_)?command|propose_edit|propose_changes/.test(tool.function.name),
      ),
    ).toBe(false);
    expect(session.messages.at(-2)?.content).toBe('/skill sample-skill "source file" "$ARGUMENTS"');
    expect(
      session.messages.at(-1)?.activities?.find((activity) => activity.skillRead)?.skillRead,
    ).toMatchObject({
      skillId: app.skill.id,
      revision: app.skill.revision,
    });
    const persisted = await app.store.session(session.id);
    expect(persisted.hasSkillHistory).toBe(true);
    expect(persisted.skills).toEqual([{ id: app.skill.id, revision: app.skill.revision }]);
    expect((await app.send(persisted, '/sample-skill next')).status).toBe(200);
    await app.finished(session.id);
    expect(JSON.stringify(requests.at(-1)?.messages)).toContain('Review next using');
  });

  it('rejects direct invocation before provider access for disabled user invocation, unsupported policies, or modified files', async () => {
    const app = await fixture(plainProvider([]), false, 'user-invocable: false');
    const session = await app.configure(await app.create());
    const response = await app.send(session, '/sample-skill file');
    expect((await response.json()).error.code).toBe('SKILL_INVOCATION');
    expect(app.factory).not.toHaveBeenCalled();
    const invalid = await fixture(plainProvider([]), true, 'allowed-tools: Bash(git *)');
    const selected = await invalid.configure(await invalid.create());
    expect((await (await invalid.send(selected, '/sample-skill')).json()).error.code).toBe(
      'SKILL_TOOL_POLICY',
    );
    expect(invalid.factory).not.toHaveBeenCalled();
    const changed = await fixture(plainProvider([]), true);
    const selectedChanged = await changed.configure(await changed.create());
    await writeFile(join(changed.root, 'SKILL.md'), 'Changed after registration');
    expect((await (await changed.send(selectedChanged, '/sample-skill')).json()).error.code).toBe(
      'SKILL_CHANGED',
    );
    expect(changed.factory).not.toHaveBeenCalled();
  });

  it('applies an automatic skill policy to the remaining tool calls in the same model response and the next request', async () => {
    const requests: InferenceRequest[] = [];
    let selected!: RegisteredSkill;
    let round = 0;
    const provider: InferenceProvider = {
      listModels: async () => [],
      capabilities: async () => ({ tools: true, streaming: true }),
      async *generate(request) {
        requests.push(structuredClone(request));
        if (round++ === 0) {
          yield {
            type: 'tool_call_delta',
            index: 0,
            id: 'read-selected',
            name: 'read_skill',
            arguments: JSON.stringify({ skillId: selected.id, revision: selected.revision }),
          };
          yield {
            type: 'tool_call_delta',
            index: 1,
            id: 'blocked-web',
            name: 'web_fetch',
            arguments: JSON.stringify({ url: 'http://127.0.0.1:1/must-not-call' }),
          };
          yield { type: 'finished', reason: 'tool_calls' };
        } else {
          yield { type: 'text_delta', text: 'Respected the selected skill policy.' };
          yield { type: 'finished', reason: 'stop' };
        }
      },
    };
    const app = await fixture(provider, false, 'allowed-tools: Read');
    selected = app.skill;
    const session = await app.configure(await app.create());
    expect((await app.send(session)).status).toBe(200);
    const completed = await app.finished(session.id);
    expect(requests[0]!.tools?.some((tool) => tool.function.name === 'web_fetch')).toBe(true);
    expect(requests[1]!.tools?.some((tool) => tool.function.name === 'web_fetch')).toBe(false);
    const webResult = completed.messages
      .at(-1)
      ?.continuation?.find(
        (message) => message.role === 'tool' && message.toolName === 'web_fetch',
      );
    expect(JSON.parse(webResult!.content)).toMatchObject({
      error: 'TOOL_UNAVAILABLE',
      tool: 'web_fetch',
    });
    expect(
      completed.messages.at(-1)?.activities?.find((activity) => activity.label === 'web_fetch')
        ?.approval,
    ).toBeUndefined();
  });

  it('discovers skills from a registered project and rejects unknown project IDs', async () => {
    const app = await fixture(plainProvider([]));
    const projectRoot = join(app.dir, 'project');
    const skillRoot = join(projectRoot, '.claude', 'skills', 'project-review');
    await mkdir(skillRoot, { recursive: true });
    await writeFile(
      join(skillRoot, 'SKILL.md'),
      '---\nname: project-review\ndescription: Review this project.\n---\nRead the project.\n',
    );
    const projectResponse = await app.request('/v1/projects', { path: projectRoot });
    expect(projectResponse.status).toBe(200);
    const project = (await projectResponse.json()).project as { id: string };
    const discovered = await app.request(
      `/v1/skills/discover?projectId=${encodeURIComponent(project.id)}`,
    );
    expect(discovered.status).toBe(200);
    expect((await discovered.json()).skills).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: await realpath(skillRoot),
          dialect: 'claude',
          scope: 'project',
          source: 'Claude Code',
        }),
      ]),
    );
    const missing = await app.request(
      `/v1/skills/discover?projectId=${encodeURIComponent(crypto.randomUUID())}`,
    );
    expect(missing.status).toBe(404);
    expect((await missing.json()).error.code).toBe('PROJECT_NOT_FOUND');
  });

  it('registers passive metadata without adding unselected skills or their bodies to requests', async () => {
    const requests: InferenceRequest[] = [];
    const app = await fixture(plainProvider(requests));
    expect(app.factory).not.toHaveBeenCalled();
    const listing = await app.request('/v1/skills');
    expect(listing.status).toBe(200);
    const inventory = await listing.text();
    expect(inventory).toContain('sample-skill');
    expect(inventory).not.toContain(BODY);
    expect(inventory).not.toContain(RESOURCE);
    const session = await app.create();
    expect((await app.send(session)).status).toBe(200);
    await app.finished(session.id);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.tools?.some((tool) => tool.function.name === 'read_skill')).toBe(false);
    expect(JSON.stringify(requests[0])).not.toContain('A selected review workflow.');
    expect(JSON.stringify(requests[0])).not.toContain(BODY);
  });

  it('reads selected instructions and resources in Plan without a project and persists provenance and continuation', async () => {
    const requests: InferenceRequest[] = [];
    let selected!: RegisteredSkill;
    const app = await fixture(readingProvider(() => selected, requests, true));
    selected = app.skill;
    const session = await app.configure(await app.create());
    expect(session.projectId).toBeNull();
    expect(session.mode).toBe('plan');
    expect((await app.send(session)).status).toBe(200);
    const completed = await app.finished(session.id);
    expect(requests).toHaveLength(3);
    expect(requests[0]!.tools?.map((tool) => tool.function.name)).toEqual(
      expect.arrayContaining(['read_skill', 'read_skill_resource']),
    );
    expect(JSON.stringify(requests[0])).toContain('A selected review workflow.');
    expect(JSON.stringify(requests[0])).not.toContain(BODY);
    expect(JSON.stringify(requests[1])).toContain(BODY);
    expect(JSON.stringify(requests[2])).toContain(RESOURCE);
    const reply = completed.messages.at(-1)!;
    const reads = reply.activities?.filter((activity) => activity.skillRead) ?? [];
    expect(reads).toHaveLength(2);
    expect(reads.map((activity) => activity.status)).toEqual(['completed', 'completed']);
    expect(reads[0]!.skillRead).toMatchObject({
      skillId: selected.id,
      revision: selected.revision,
      path: 'SKILL.md',
    });
    expect(reads[1]!.skillRead).toMatchObject({
      path: 'references/guide.md',
      bytes: Buffer.byteLength(RESOURCE),
    });
    const results = reply.continuation
      ?.filter((message) => message.role === 'tool')
      .map((message) => JSON.parse(message.content));
    expect(results?.map((result) => result.content)).toEqual([
      expect.stringContaining(BODY),
      RESOURCE,
    ]);
    expect(reply.content).toBe('Loaded the selected instructions.');
  });

  it('rejects stale registrations before a message or provider invocation and preserves the registration ID', async () => {
    const app = await fixture(plainProvider([]));
    const session = await app.configure(await app.create());
    await writeFile(
      join(app.root, 'SKILL.md'),
      '---\nname: sample-skill\ndescription: Changed workflow.\n---\nChanged instructions.\n',
    );
    const updated = await app.request('/v1/skills/register', {
      path: app.root,
      id: app.skill.id,
      expectedRevision: app.skill.revision,
    });
    expect(updated.status).toBe(200);
    const current = (await updated.json()).skill as RegisteredSkill;
    expect(current.id).toBe(app.skill.id);
    expect(current.revision).not.toBe(app.skill.revision);
    const stale = await app.send(session);
    expect(stale.status).toBe(409);
    expect((await stale.json()).error.code).toBe('SKILL_CHANGED');
    expect(app.factory).not.toHaveBeenCalled();
    expect((await app.store.session(session.id)).messages).toHaveLength(0);
    const staleUpdate = await app.request('/v1/skills/register', {
      path: app.root,
      id: app.skill.id,
      expectedRevision: app.skill.revision,
    });
    expect(staleUpdate.status).toBe(409);
    expect((await staleUpdate.json()).error.code).toBe('VERSION_CONFLICT');
  });

  it('blocks removal while a selected skill is in use, then removes only its registry entry', async () => {
    let release: (() => void) | undefined;
    const provider: InferenceProvider = {
      listModels: async () => [],
      capabilities: async () => ({ tools: true, streaming: true }),
      async *generate(_request, signal) {
        await new Promise<void>((resolve) => {
          release = resolve;
          if (signal.aborted) resolve();
          else signal.addEventListener('abort', () => resolve(), { once: true });
        });
        yield { type: 'text_delta', text: 'Finished.' };
        yield { type: 'finished', reason: 'stop' };
      },
    };
    const app = await fixture(provider);
    const session = await app.configure(await app.create());
    expect((await app.send(session)).status).toBe(200);
    await expect.poll(() => !!release).toBe(true);
    const blocked = await app.request('/v1/skills/remove', {
      id: app.skill.id,
      expectedRevision: app.skill.revision,
    });
    expect(blocked.status).toBe(409);
    expect((await blocked.json()).error.code).toBe('BUSY');
    await expect(
      app.store.removeRegisteredSkill(app.skill.id, app.skill.revision),
    ).rejects.toMatchObject({ code: 'BUSY' });
    release!();
    await app.finished(session.id);
    const removed = await app.request('/v1/skills/remove', {
      id: app.skill.id,
      expectedRevision: app.skill.revision,
    });
    expect(removed.status).toBe(200);
    expect((await removed.json()).skills).toEqual([]);
    expect(await readFile(join(app.root, 'SKILL.md'), 'utf8')).toContain(BODY);
  });

  it('requires skill cloud consent before invoking a mocked OpenRouter provider even with chat consent', async () => {
    const requests: InferenceRequest[] = [];
    const app = await fixture(plainProvider(requests));
    const session = await app.configure(await app.create(true));
    expect(session.config.cloudConsent).toBe(true);
    const blocked = await app.send(session);
    expect(blocked.status).toBe(403);
    expect((await blocked.json()).error.code).toBe('SKILL_CLOUD_CONSENT');
    expect(app.factory).not.toHaveBeenCalled();
    expect(requests).toEqual([]);
    expect((await app.store.session(session.id)).messages).toHaveLength(0);
    const direct = await app.send(session, '/sample-skill private-input');
    expect((await direct.json()).error.code).toBe('SKILL_CLOUD_CONSENT');
    expect(requests).toEqual([]);
  });

  it('still guards historical skill content after selection is removed and cloud consent is revoked', async () => {
    const requests: InferenceRequest[] = [];
    let selected!: RegisteredSkill;
    const app = await fixture(readingProvider(() => selected, requests));
    selected = app.skill;
    const session = await app.configure(await app.create(true), undefined, true);
    expect((await app.send(session)).status).toBe(200);
    const completed = await app.finished(session.id);
    expect(completed.messages.at(-1)?.activities?.some((activity) => activity.skillRead)).toBe(
      true,
    );
    const cleared = await app.configure(completed, [], false);
    expect(cleared.skills).toEqual([]);
    const invocationsBefore = app.factory.mock.calls.length;
    const requestsBefore = requests.length;
    const blocked = await app.send(cleared);
    expect(blocked.status).toBe(403);
    expect((await blocked.json()).error.code).toBe('SKILL_CLOUD_CONSENT');
    expect(app.factory).toHaveBeenCalledTimes(invocationsBefore);
    expect(requests).toHaveLength(requestsBefore);
    expect((await app.store.session(session.id)).messages).toHaveLength(completed.messages.length);
  });

  it('guards catalog-only history after deselection and consent revocation without any skill read activity', async () => {
    const description = 'A selected review workflow.';
    const requests: InferenceRequest[] = [];
    const provider: InferenceProvider = {
      listModels: async () => [],
      capabilities: async () => ({ tools: true, streaming: true }),
      async *generate(request) {
        requests.push(structuredClone(request));
        expect(JSON.stringify(request.messages)).toContain(description);
        yield { type: 'text_delta', text: `The available skill is described as: ${description}` };
        yield { type: 'finished', reason: 'stop' };
      },
    };
    const app = await fixture(provider);
    const session = await app.configure(await app.create(true), undefined, true);
    expect((await app.send(session)).status).toBe(200);
    const completed = await app.finished(session.id);
    expect(completed.messages.at(-1)?.content).toContain(description);
    expect(
      completed.messages.some((message) =>
        message.activities?.some((activity) => activity.skillRead),
      ),
    ).toBe(false);
    expect(requests).toHaveLength(1);
    const cleared = await app.configure(completed, [], false);
    const blocked = await app.send(cleared);
    expect(blocked.status).toBe(403);
    expect((await blocked.json()).error.code).toBe('SKILL_CLOUD_CONSENT');
    expect(app.factory).toHaveBeenCalledTimes(2);
    expect(requests).toHaveLength(1);
    expect((await app.store.session(session.id)).messages).toHaveLength(completed.messages.length);
  });

  it('accepts manual-only selection without advertising it to the model and validates registration payloads', async () => {
    const app = await fixture(plainProvider([]), true);
    const session = await app.create();
    const rejected = await app.request(
      '/v1/commands',
      makeCommand({
        type: 'configure_skills',
        sessionId: session.id,
        expectedVersion: session.version,
        skills: [{ id: app.skill.id, revision: app.skill.revision }],
        skillCloudConsent: false,
      }),
    );
    expect(rejected.status).toBe(200);
    expect((await app.store.session(session.id)).skills).toEqual([
      { id: app.skill.id, revision: app.skill.revision },
    ]);
    expect((await app.request('/v1/skills/register', null)).status).toBe(400);
    expect(
      (await app.request('/v1/skills/register', { path: app.root, execute: true })).status,
    ).toBe(400);
    expect(app.factory).not.toHaveBeenCalled();
  });
});
