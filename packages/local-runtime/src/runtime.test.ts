import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, writeFile, lstat, realpath, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  engineSettingsSchema,
  runtimeSettingsSchema,
  type LocalProfile,
  type LocalProfileInput,
  type RuntimeSettings,
} from '@lodex/contracts';
import {
  RuntimeManager,
  engineArguments,
  inspectProfile,
  parseNvidiaSmi,
  type RuntimeRepository,
} from './index';

const managers: RuntimeManager[] = [],
  dirs: string[] = [];
afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.close();
  for (const dir of dirs.splice(0)) {
    if (dirname(resolve(dir)) !== resolve(tmpdir())) throw new Error('Unsafe test directory');
    await rm(dir, { recursive: true, force: true });
  }
});
const flags = [
  '--model',
  '--host',
  '--port',
  '--alias',
  '--api-key',
  '--ctx-size',
  '--gpu-layers',
  '--threads',
  '--threads-batch',
  '--batch-size',
  '--ubatch-size',
  '--flash-attn',
  '--cache-type-k',
  '--cache-type-v',
  '--parallel',
  '--jinja',
  '--no-kv-offload',
  '--fit',
  '--chat-template',
  '--seed',
];
function profileInput(profile: LocalProfile): LocalProfileInput {
  const { id, version, name, enginePath, modelPath, settings, vramReservationMb } = profile;
  return { id, expectedVersion: version, name, enginePath, modelPath, settings, vramReservationMb };
}
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'lodex-engine 한글-'));
  dirs.push(dir);
  const script = join(dir, 'fixture.cjs');
  await writeFile(
    script,
    `const http=require('node:http'); const args=process.argv.slice(2); const arg=(k)=>args[args.indexOf(k)+1];
const key=arg('--api-key'); console.log('fixture pid='+process.pid); console.log('transport='+key);
const server=http.createServer((req,res)=>{ if(req.headers.authorization!=='Bearer '+key){res.writeHead(401);res.end();return;}
if(req.url==='/secret-prefix') process.stdout.write('stream='+key.slice(0,32));
if(req.url==='/secret-suffix') process.stdout.write(key.slice(32)+'\\n');
if(req.url==='/long-secret') process.stdout.write('x'.repeat(17000)+key+'y'.repeat(15990)+'\\n');
res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify({status:'ok'})); });
server.listen(Number(arg('--port')),arg('--host'));`,
  );
  const model = join(dir, 'fixture.gguf'),
    header = Buffer.alloc(24);
  header.write('GGUF');
  header.writeUInt32LE(3, 4);
  header.writeBigUInt64LE(1n, 8);
  await writeFile(model, header);
  const enginePath = await realpath(process.execPath);
  const identity = async (path: string) => {
    const s = await lstat(path);
    return `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}`;
  };
  const profile: LocalProfile = {
    id: crypto.randomUUID(),
    version: 1,
    name: 'fixture',
    enginePath,
    engineIdentity: await identity(enginePath),
    modelPath: model,
    modelIdentity: await identity(model),
    modelBytes: 24,
    engineVersion: 'test fixture, not llama.cpp',
    ggufVersion: 3,
    supportedFlags: flags,
    settings: { ...engineSettingsSchema.parse({}), extraArgs: [script] },
    vramReservationMb: 64,
  };
  let profiles = [profile],
    settings: RuntimeSettings = {
      ...runtimeSettingsSchema.parse({}),
      vramBudgetMb: 128,
      headroomMb: 0,
    };
  const repo: RuntimeRepository = {
    localProfiles: async () => profiles,
    saveLocalProfile: async (p) => {
      profiles = [...profiles.filter((v) => v.id !== p.id), p];
      return p;
    },
    removeLocalProfile: async (id) => {
      profiles = profiles.filter((p) => p.id !== id);
    },
    runtimeSettings: async () => settings,
    saveRuntimeSettings: async (value) => {
      settings = { ...value, version: settings.version + 1 };
    },
  };
  const manager = new RuntimeManager(repo, resolve('apps/daemon/dist/supervisor.cjs'));
  managers.push(manager);
  return { profile, repo, manager, dir, script };
}
describe('managed local engines', () => {
  it('parses bounded NVIDIA resource measurements and ignores malformed rows', () => {
    expect(
      parseNvidiaSmi(
        '0, NVIDIA GeForce RTX 3090, 24576, 1024, 23552, 7\ninvalid\n1, GPU 2, 8192, 4096, 4096, N/A',
      ),
    ).toEqual([
      {
        index: 0,
        name: 'NVIDIA GeForce RTX 3090',
        totalVramMb: 24576,
        usedVramMb: 1024,
        freeVramMb: 23552,
        utilizationPercent: 7,
      },
      {
        index: 1,
        name: 'GPU 2',
        totalVramMb: 8192,
        usedVramMb: 4096,
        freeVramMb: 4096,
        utilizationPercent: null,
      },
    ]);
  });
  it('starts an authenticated fixture, hides its transport key, protects active leases and evicts idle engines', async () => {
    const { manager, profile, repo } = await fixture();
    const a = await manager.acquire(profile.id, AbortSignal.timeout(5000));
    expect((await fetch(a.baseUrl.replace('/v1', '/health'))).status).toBe(401);
    expect(
      (
        await fetch(a.baseUrl.replace('/v1', '/health'), {
          headers: { Authorization: 'Bearer ' + a.key },
        })
      ).status,
    ).toBe(200);
    expect(JSON.stringify(await manager.snapshot())).not.toContain(a.key);
    expect((await manager.snapshot()).instances[0]!.status).toBe('ready');
    await expect(manager.unload(profile.id)).rejects.toMatchObject({ code: 'MODEL_IN_USE' });
    const next = { ...profile, id: crypto.randomUUID(), name: 'second', vramReservationMb: 100 };
    await repo.saveLocalProfile(next);
    await expect(manager.acquire(next.id, AbortSignal.timeout(5000))).rejects.toMatchObject({
      code: 'VRAM_BUSY',
    });
    await a.release();
    await a.release();
    const b = await manager.acquire(next.id, AbortSignal.timeout(5000));
    const state = await manager.snapshot();
    expect(state.instances.find((i) => i.profileId === profile.id)!.status).toBe('stopped');
    expect(state.instances.find((i) => i.profileId === next.id)!.leases).toBe(1);
    await b.release();
    await manager.unload(next.id);
    await expect(
      fetch(b.baseUrl.replace('/v1', '/health'), { signal: AbortSignal.timeout(1000) }),
    ).rejects.toThrow();
  });
  it('rejects changed files and unsupported or reserved flags before model execution', async () => {
    const { manager, profile } = await fixture();
    const args = engineArguments(profile, 12345, 'transport');
    expect(args[args.indexOf('--host') + 1]).toBe('127.0.0.1');
    expect(args[args.indexOf('--ctx-size') + 1]).toBe('32768');
    expect(args[args.indexOf('--fit') + 1]).toBe('off');
    expect(() =>
      engineArguments(
        { ...profile, settings: { ...profile.settings, extraArgs: ['--port=9000'] } },
        1,
        'x',
      ),
    ).toThrow();
    expect(() => engineArguments({ ...profile, supportedFlags: [] }, 1, 'x')).toThrow();
    expect(
      engineArguments(
        { ...profile, settings: { ...profile.settings, extraArgs: ['--seed', '1'] } },
        1,
        'x',
      ),
    ).toContain('--seed');
    await writeFile(profile.modelPath, 'changed');
    await expect(manager.acquire(profile.id, AbortSignal.timeout(5000))).rejects.toMatchObject({
      code: 'MODEL_CHANGED',
    });
    expect((await manager.snapshot()).instances).toEqual([]);
    await expect(
      inspectProfile({
        name: 'invalid',
        enginePath: profile.enginePath,
        modelPath: profile.modelPath,
        settings: profile.settings,
        vramReservationMb: 64,
      }),
    ).rejects.toMatchObject({ code: 'GGUF_FORMAT' });
  });
  it('keeps healthy engines loaded when a profile edit or session version is stale', async () => {
    const { manager, profile } = await fixture();
    const lease = await manager.acquire(profile.id, AbortSignal.timeout(5000), profile.version);
    await lease.release();
    await expect(
      manager.register({ ...profileInput(profile), expectedVersion: profile.version + 1 }),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    await expect(
      manager.acquire(profile.id, AbortSignal.timeout(5000), profile.version + 1),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    await expect(
      manager.register({
        ...profileInput(profile),
        modelPath: join(dirname(profile.modelPath), 'missing.gguf'),
      }),
    ).rejects.toThrow();
    const state = await manager.snapshot();
    expect(state.instances[0]).toMatchObject({ status: 'ready', leases: 0, reservedVramMb: 64 });
    const reused = await manager.acquire(profile.id, AbortSignal.timeout(5000), profile.version);
    expect(reused.baseUrl).toBe(lease.baseUrl);
    await reused.release();
  });
  it('checks budget feasibility and setting versions before evicting idle engines', async () => {
    const { manager, profile, repo } = await fixture();
    const idle = await manager.acquire(profile.id, AbortSignal.timeout(5000));
    await idle.release();
    const second = { ...profile, id: crypto.randomUUID() };
    await repo.saveLocalProfile(second);
    const active = await manager.acquire(second.id, AbortSignal.timeout(5000));
    const settings = await repo.runtimeSettings();
    await expect(manager.configure({ ...settings, vramBudgetMb: 32 })).rejects.toMatchObject({
      code: 'VRAM_BUSY',
    });
    await expect(
      manager.configure({ ...settings, version: 1, vramBudgetMb: 64 }),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    expect((await manager.snapshot()).instances.every((i) => i.status === 'ready')).toBe(true);
    expect(await repo.runtimeSettings()).toEqual(settings);
    await manager.configure({ ...settings, vramBudgetMb: 64 });
    expect(
      (await manager.snapshot()).instances.find((i) => i.profileId === profile.id)?.status,
    ).toBe('stopped');
    expect(
      (await manager.snapshot()).instances.find((i) => i.profileId === second.id)?.status,
    ).toBe('ready');
    await active.release();
  });
  it('unloads expired idle engines without interrupting active leases', async () => {
    const { manager, profile } = await fixture();
    const lease = await manager.acquire(profile.id, AbortSignal.timeout(5000));
    await manager.sweepIdle(Date.now() + 11 * 60000);
    expect((await manager.snapshot()).instances[0]).toMatchObject({
      status: 'ready',
      leases: 1,
    });
    await lease.release();
    await manager.sweepIdle(Date.now() + 11 * 60000);
    expect((await manager.snapshot()).instances[0]).toMatchObject({
      status: 'stopped',
      leases: 0,
      reservedVramMb: 0,
    });
  });
  it('does not expose split transport secrets or fragments left by log truncation', async () => {
    const { manager, profile } = await fixture();
    const lease = await manager.acquire(profile.id, AbortSignal.timeout(5000));
    const send = async (path: string) => {
      const response = await fetch(lease.baseUrl.replace('/v1', path), {
        headers: { Authorization: 'Bearer ' + lease.key },
      });
      await response.body?.cancel();
    };
    await send('/secret-prefix');
    await expect
      .poll(async () => (await manager.snapshot()).instances[0]!.log)
      .toContain('stream=');
    expect(JSON.stringify(await manager.snapshot())).not.toContain(lease.key.slice(0, 32));
    await send('/secret-suffix');
    await expect
      .poll(async () => (await manager.snapshot()).instances[0]!.log)
      .toContain('stream=[redacted]');
    await send('/long-secret');
    await expect
      .poll(async () =>
        (await manager.snapshot()).instances[0]!.log.endsWith('y'.repeat(15990) + '\n'),
      )
      .toBe(true);
    expect(JSON.stringify(await manager.snapshot())).not.toContain(lease.key.slice(-8));
    await lease.release();
  });
  it('cancels an acquisition after asynchronous profile lookup without adding a lease', async () => {
    const { manager, profile, repo } = await fixture();
    const first = await manager.acquire(profile.id, AbortSignal.timeout(5000));
    await first.release();
    const original = repo.localProfiles;
    let signalEntered!: () => void, resume!: () => void;
    const entered = new Promise<void>((resolve) => {
      signalEntered = resolve;
    });
    const unblock = new Promise<void>((resolve) => {
      resume = resolve;
    });
    repo.localProfiles = async () => {
      signalEntered();
      await unblock;
      return original();
    };
    const controller = new AbortController();
    const acquisition = manager.acquire(profile.id, controller.signal);
    await entered;
    controller.abort();
    resume();
    await expect(acquisition).rejects.toMatchObject({ name: 'AbortError' });
    repo.localProfiles = original;
    expect((await manager.snapshot()).instances[0]).toMatchObject({ status: 'ready', leases: 0 });
  });
  it('stops a loading engine on cancellation and releases its reservation', async () => {
    const { manager, profile, script } = await fixture();
    await writeFile(
      script,
      "console.log('loading fixture pid='+process.pid);setInterval(()=>{},1000);",
    );
    const controller = new AbortController();
    const acquisition = manager.acquire(profile.id, controller.signal);
    const rejection = expect(acquisition).rejects.toMatchObject({ code: 'MODEL_LOAD' });
    await expect
      .poll(async () => (await manager.snapshot()).instances[0]?.log)
      .toContain('loading fixture pid=');
    const pid = Number((await manager.snapshot()).instances[0]!.log.match(/pid=(\d+)/)?.[1]);
    controller.abort();
    await rejection;
    expect((await manager.snapshot()).instances[0]).toMatchObject({
      status: 'failed',
      reservedVramMb: 0,
      leases: 0,
    });
    expect(() => process.kill(pid, 0)).toThrow();
    await Promise.all([manager.close(), manager.close()]);
  });
  it('cleans up the engine when its private parent pipe closes', async () => {
    const supervisor = spawn(process.execPath, [resolve('apps/daemon/dist/supervisor.cjs')], {
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
      windowsHide: true,
    }) as ChildProcessWithoutNullStreams;
    const stopped = new Promise<unknown>((resolve) => supervisor.once('message', resolve));
    let stderr = '';
    supervisor.stderr.on('data', (v: Buffer) => {
      stderr += v.toString();
    });
    const pid = new Promise<number>((resolve, reject) => {
      supervisor.stdout.once('data', (v: Buffer) => resolve(Number(v.toString().trim())));
      supervisor.once('error', reject);
    });
    const exited = new Promise<number | null>((resolve) => supervisor.once('close', resolve));
    supervisor.stdin.write(
      JSON.stringify({
        executable: process.execPath,
        args: ['-e', 'console.log(process.pid);setInterval(()=>{},1000)'],
        cwd: process.cwd(),
      }) + '\n',
    );
    const enginePid = await pid;
    expect(Number.isInteger(enginePid)).toBe(true);
    supervisor.stdin.end();
    expect(await stopped).toEqual({ type: 'engine_stopped' });
    expect(await exited).toBe(0);
    expect(stderr).toBe('');
    expect(() => process.kill(enginePid, 0)).toThrow();
  });
  it('retains reservations when its supervisor exits without confirming engine shutdown', async () => {
    const { profile, repo, dir } = await fixture();
    const path = join(dir, 'crashing-supervisor.cjs');
    const stopPath = join(dir, 'stop-fixture');
    const engineSource = `console.log("orphan fixture pid="+process.pid);setTimeout(()=>process.exit(),8000);setInterval(()=>{if(require('node:fs').existsSync(${JSON.stringify(stopPath)}))process.exit();},25);`;
    await writeFile(
      path,
      `const {spawn}=require('node:child_process');
require('node:readline').createInterface({input:process.stdin}).once('line',()=>{
const engine=spawn(process.execPath,['-e',${JSON.stringify(engineSource)}],{windowsHide:true});
engine.stdout.pipe(process.stdout);engine.stderr.pipe(process.stderr);
engine.stdout.once('data',()=>setTimeout(()=>process.exit(1),100));
});`,
    );
    const manager = new RuntimeManager(repo, path);
    // The test uses a private stop file for its engine. The manager must never
    // guess which operating-system PID might still belong to a crashed supervisor.
    let pid: number | undefined;
    try {
      const acquisition = manager.acquire(profile.id, AbortSignal.timeout(5000));
      const rejection = expect(acquisition).rejects.toMatchObject({ code: 'ENGINE_STOP' });
      await expect
        .poll(async () => (await manager.snapshot()).instances[0]?.log)
        .toContain('orphan fixture pid=');
      pid = Number((await manager.snapshot()).instances[0]!.log.match(/pid=(\d+)/)?.[1]);
      await rejection;
      expect((await manager.snapshot()).instances[0]).toMatchObject({
        status: 'failed',
        reservedVramMb: 64,
      });
      // Some operating systems reap the child with its parent; without the
      // acknowledgment the manager still cannot assume that cleanup succeeded.
      await expect(manager.unload(profile.id)).rejects.toMatchObject({ code: 'ENGINE_STOP' });
      expect((await manager.snapshot()).instances[0]!.reservedVramMb).toBe(64);
    } finally {
      await writeFile(stopPath, 'stop');
      if (pid && Number.isInteger(pid)) {
        await expect
          .poll(() => {
            try {
              process.kill(pid!, 0);
              return false;
            } catch {
              return true;
            }
          })
          .toBe(true);
      }
      await expect(manager.close()).rejects.toMatchObject({ code: 'ENGINE_STOP' });
    }
  });
});
