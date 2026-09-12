import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';

const resourceRoot = process.argv[2] ? resolve(process.argv[2]) : null;
const runtime = resourceRoot
  ? join(resourceRoot, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node')
  : resolve('.runtime', process.platform === 'win32' ? 'node.exe' : 'node');
const script = resourceRoot
  ? join(resourceRoot, 'daemon/main.cjs')
  : resolve('apps/daemon/dist/main.cjs');
const supervisor = resourceRoot
  ? join(resourceRoot, 'daemon/supervisor.cjs')
  : resolve('apps/daemon/dist/supervisor.cjs');
const dataDir = await mkdtemp(join(tmpdir(), 'lodex-런타임 검증 '));
const token = randomBytes(32).toString('hex');
const children = new Set();
const dotenvFixture = 'fixture-only-no-real-provider-call';
await writeFile(join(dataDir, '.env'), 'OPENROUTER_API_KEY=' + dotenvFixture + '\n', {
  mode: 0o600,
});
async function boot() {
  const child = spawn(runtime, [script], {
    cwd: dataDir,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      NODE_OPTIONS: '',
      NODE_PATH: '',
      OPENROUTER_API_KEY: '',
      LODEX_ENV_FILE: '',
    },
  });
  children.add(child);
  child.exited = new Promise((resolve) => {
    const finish = (code, signal) => {
      children.delete(child);
      resolve({ code, signal });
    };
    child.once('exit', finish);
    child.once('error', () => finish(null, 'spawn-error'));
  });
  child.stderr.resume();
  const lines = createInterface({ input: child.stdout });
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Daemon startup timed out')), 10000);
    lines.once('line', (line) => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(line));
      } catch (error) {
        reject(error);
      }
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error('Daemon exited before ready: ' + code));
    });
  });
  child.stdin.write(JSON.stringify({ token, dataDir, parentPid: process.pid }) + '\n');
  const handshake = await ready;
  assert.equal(handshake.protocolVersion, 1);
  const base = 'http://127.0.0.1:' + handshake.port;
  const request = (path, init = {}) =>
    fetch(base + path, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + token,
        ...init.headers,
      },
    });
  const command = async (value) => {
    const response = await request('/v1/commands', {
      method: 'POST',
      body: JSON.stringify({
        protocolVersion: 1,
        policyVersion: 1,
        actor: 'desktop',
        commandId: randomUUID(),
        ...value,
      }),
    });
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    return result.session;
  };
  const state = () => request('/v1/state').then((r) => r.json());
  const secretState = await state();
  assert.equal(secretState.openrouterKeySource, 'env_file');
  assert.equal(secretState.openrouterConfigured, true);
  assert.equal(JSON.stringify(secretState).includes(dotenvFixture), false);
  return { child, base, command, state, request };
}
async function stop(app) {
  app.child.stdin.end();
  let timeout;
  const exit = await Promise.race([
    app.child.exited,
    new Promise((_, reject) => {
      timeout = setTimeout(
        () => reject(new Error('Daemon did not stop on private pipe close')),
        10000,
      );
    }),
  ]).finally(() => clearTimeout(timeout));
  assert.equal(exit.code, 0);
}
async function checkSupervisor() {
  await access(supervisor);
  const child = spawn(runtime, [supervisor], {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '' },
  });
  children.add(child);
  child.exited = new Promise((resolve) => {
    child.once('exit', (code, signal) => {
      children.delete(child);
      resolve({ code, signal });
    });
    child.once('error', () => {
      children.delete(child);
      resolve({ code: null, signal: 'spawn-error' });
    });
  });
  child.stderr.resume();
  let engineStopped = false;
  child.on('message', (message) => {
    if (message?.type === 'engine_stopped') engineStopped = true;
  });
  const lines = createInterface({ input: child.stdout });
  let timeout;
  const ready = new Promise((resolve, reject) => {
    timeout = setTimeout(
      () => reject(new Error('Bundled supervisor did not launch fixture')),
      10000,
    );
    lines.once('line', (line) => resolve(Number(line)));
    child.once('error', reject);
  });
  child.stdin.write(
    JSON.stringify({
      executable: runtime,
      args: ['-e', 'console.log(process.pid); setTimeout(() => process.exit(0), 15000);'],
      cwd: dataDir,
    }) + '\n',
  );
  const pid = await ready.finally(() => clearTimeout(timeout));
  assert.ok(Number.isInteger(pid) && pid > 0);
  await stop({ child });
  assert.equal(engineStopped, true);
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
}
try {
  await checkSupervisor();
  let app = await boot();
  const runtimeSettings = await app.request('/v1/runtime').then((r) => r.json());
  assert.deepEqual(runtimeSettings.profiles, []);
  const updatedRuntime = await app.request('/v1/runtime/settings', {
    method: 'POST',
    body: JSON.stringify({ ...runtimeSettings.settings, vramBudgetMb: 16384 }),
  });
  assert.equal(updatedRuntime.status, 200);
  if (process.argv[3]) {
    const response = await app.request(
      '/v1/models?' + new URLSearchParams({ provider: 'llama-server', baseUrl: process.argv[3] }),
    );
    const catalog = await response.json();
    assert.equal(response.status, 200, JSON.stringify(catalog));
    assert.ok(Array.isArray(catalog.models));
    console.log(
      'PASS: requested model server catalog through bundled daemon (' +
        catalog.models.length +
        ' models; no inference).',
    );
  }
  assert.equal((await fetch(app.base + '/v1/state')).status, 401);
  const registered = await app.request('/v1/projects', {
    method: 'POST',
    body: JSON.stringify({ path: dataDir }),
  });
  assert.equal(registered.status, 200);
  const { project } = await registered.json();
  const skillPath = join(dataDir, 'bundled-fixture');
  await mkdir(skillPath);
  await writeFile(
    join(skillPath, 'SKILL.md'),
    '---\nname: bundled-fixture\ndescription: Bundled skill integration fixture.\n---\nRead the selected project carefully.\n',
  );
  const importedSkill = await app.request('/v1/skills/register', {
    method: 'POST',
    body: JSON.stringify({ path: skillPath, dialect: 'standard' }),
  });
  assert.equal(importedSkill.status, 200);
  const { skill } = await importedSkill.json();
  const mcpFixture = join(dataDir, 'mcp-fixture.cjs');
  await writeFile(
    mcpFixture,
    `
    require('node:readline').createInterface({input:process.stdin}).on('line', line => {
      const m = JSON.parse(line); if (m.id === undefined) return;
      const result = m.method === 'initialize' ? { protocolVersion:'2025-11-25', capabilities:{tools:{},resources:{},prompts:{}}, serverInfo:{name:'bundled-fixture',version:'1'} }
        : m.method === 'tools/list' ? {tools:[{name:'fixture_echo',inputSchema:{type:'object',properties:{}}}]}
        : m.method === 'resources/list' ? {resources:[{uri:'fixture://guide',name:'Guide',mimeType:'text/plain'}]}
        : m.method === 'resources/templates/list' ? {resourceTemplates:[]}
        : m.method === 'resources/read' ? {contents:[{uri:'fixture://guide',mimeType:'text/plain',text:'Bundled resource fixture'}]}
        : m.method === 'prompts/list' ? {prompts:[{name:'review'}]}
        : m.method === 'prompts/get' ? {messages:[{role:'user',content:{type:'text',text:'Bundled prompt fixture'}}]} : {};
      process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');
    });
    process.stdin.on('end',()=>process.exit(0));
  `,
  );
  const mcpResponse = await app.request('/v1/mcp/register', {
    method: 'POST',
    body: JSON.stringify({
      approved: true,
      config: {
        name: 'Bundled MCP',
        transport: 'stdio',
        executable: runtime,
        args: [mcpFixture],
        cwd: dataDir,
        protocol: 'legacy',
      },
    }),
  });
  const mcpPayload = await mcpResponse.json();
  assert.equal(mcpResponse.status, 200, JSON.stringify(mcpPayload));
  const mcpServer = mcpPayload.server;
  assert.equal(mcpServer.resources.length, 1);
  assert.equal(mcpServer.prompts.length, 1);
  const previewResponse = await app.request('/v1/mcp/content', {
    method: 'POST',
    body: JSON.stringify({
      serverId: mcpServer.id,
      serverRevision: mcpServer.revision,
      kind: 'resource',
      entryKey: 'fixture://guide',
      entryRevision: mcpServer.resources[0].revision,
    }),
  });
  assert.equal(previewResponse.status, 200);
  const resourcePreview = await previewResponse.json();
  assert.equal(resourcePreview.text, 'Bundled resource fixture');
  let session = await app.command({
    type: 'create_session',
    sessionId: randomUUID(),
    title: '패키지 검증',
    config: { provider: 'demo', model: 'demo' },
    projectId: project.id,
  });
  session = await app.command({
    type: 'configure_skills',
    sessionId: session.id,
    expectedVersion: session.version,
    skills: [{ id: skill.id, revision: skill.revision }],
    skillCloudConsent: false,
  });
  session = await app.command({
    type: 'attach_mcp_content',
    sessionId: session.id,
    expectedVersion: session.version,
    previewId: resourcePreview.id,
    mcpCloudConsent: false,
  });
  const mcpSelection = [
    {
      serverId: mcpServer.id,
      serverRevision: mcpServer.revision,
      toolName: mcpServer.tools[0].name,
      toolRevision: mcpServer.tools[0].revision,
    },
  ];
  session = await app.command({
    type: 'configure_mcp',
    sessionId: session.id,
    expectedVersion: session.version,
    mcp: mcpSelection,
    mcpCloudConsent: false,
  });
  session = await app.command({
    type: 'save_plan',
    sessionId: session.id,
    expectedVersion: session.version,
    plan: {
      goal: '번들 런타임 복구 검증',
      tasks: [{ id: randomUUID(), title: '한글 경로에서 실행', done: true }],
    },
  });
  session = await app.command({
    type: 'send_message',
    sessionId: session.id,
    expectedVersion: session.version,
    content: '첫 실행',
  });
  session = await app.command({ type: 'cancel_run', sessionId: session.id, runId: session.run.id });
  assert.equal(session.run.status, 'cancelled');
  await stop(app);
  app = await boot();
  assert.equal(
    (await app.request('/v1/runtime').then((r) => r.json())).settings.vramBudgetMb,
    16384,
  );
  session = (await app.state()).sessions[0];
  assert.equal((await app.state()).projects[0].id, project.id);
  assert.equal(session.projectId, project.id);
  assert.equal(session.plan.goal, '번들 런타임 복구 검증');
  assert.equal(session.plan.tasks[0].done, true);
  assert.deepEqual(session.skills, [{ id: skill.id, revision: skill.revision }]);
  assert.deepEqual(session.mcp, mcpSelection);
  assert.equal(session.mcpAttachments[0].text, 'Bundled resource fixture');
  assert.equal((await app.request('/v1/mcp').then((r) => r.json())).servers[0].id, mcpServer.id);
  assert.equal((await app.request('/v1/skills').then((r) => r.json())).skills[0].id, skill.id);
  session = await app.command({
    type: 'send_message',
    sessionId: session.id,
    expectedVersion: session.version,
    content: '충돌 복구',
  });
  app.child.kill('SIGKILL');
  await app.child.exited;
  app = await boot();
  session = (await app.state()).sessions[0];
  assert.equal(session.run.status, 'interrupted');
  assert.equal(session.messages.at(-1).status, 'interrupted');
  const deletion = await app.request('/v1/sessions/delete', {
    method: 'POST',
    body: JSON.stringify({
      protocolVersion: 1,
      commandId: randomUUID(),
      actor: 'desktop',
      policyVersion: 1,
      type: 'delete_sessions',
      targets: [{ sessionId: session.id, expectedVersion: session.version }],
    }),
  });
  assert.equal(deletion.status, 200);
  await stop(app);
  app = await boot();
  assert.equal((await app.state()).sessions.length, 0);
  assert.equal((await app.state()).projects[0].id, project.id);
  await stop(app);
  console.log(
    'PASS: dotenv without key exposure / bundled Node and engine supervisor / runtime settings / skill and stdio MCP registration and selection / Korean-space paths / auth / projects / chat / cancel / plan persistence / pipe shutdown / crash recovery / durable deletion.',
  );
} finally {
  for (const child of children) {
    child.kill('SIGKILL');
    await child.exited;
  }
  if (dirname(resolve(dataDir)) !== resolve(tmpdir())) throw new Error('Unsafe smoke test path');
  await rm(dataDir, { recursive: true, force: true });
}
