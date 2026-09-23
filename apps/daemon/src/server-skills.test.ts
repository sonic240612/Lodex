import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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

async function fixture(provider: InferenceProvider, manualOnly = false) {
  const dir = await mkdtemp(join(tmpdir(), 'lodex-skills-api-'));
  const root = join(dir, 'sample-skill');
  await mkdir(join(root, 'references'), { recursive: true });
  await writeFile(
    join(root, 'SKILL.md'),
    `---\nname: sample-skill\ndescription: A selected review workflow.\ndisable-model-invocation: ${manualOnly}\n---\n${BODY}\n`,
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
  const send = (session: Session) =>
    request(
      '/v1/commands',
      makeCommand({
        type: 'send_message',
        sessionId: session.id,
        expectedVersion: session.version,
        content: 'Inspect the selected workflow.',
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
          path: skillRoot,
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

  it('refuses manual-only skills as session tools and validates registration payloads', async () => {
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
    expect(rejected.status).toBe(400);
    expect((await rejected.json()).error.code).toBe('SKILL_INVOCATION');
    expect((await app.store.session(session.id)).skills).toEqual([]);
    expect((await app.request('/v1/skills/register', null)).status).toBe(400);
    expect(
      (await app.request('/v1/skills/register', { path: app.root, execute: true })).status,
    ).toBe(400);
    expect(app.factory).not.toHaveBeenCalled();
  });
});
