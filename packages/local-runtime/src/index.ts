import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, dirname, join } from 'node:path';
import { createServer } from 'node:net';
import { randomBytes, randomUUID } from 'node:crypto';
import { freemem, platform, totalmem } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { StringDecoder } from 'node:string_decoder';
import {
  AppError,
  localProfileInputSchema,
  runtimeSettingsSchema,
  type EngineSettings,
  type LocalProfile,
  type LocalProfileInput,
  type RuntimeInstance,
  type RuntimeSettings,
  type RuntimeSnapshot,
  type GpuResourceSnapshot,
  type RuntimeResources,
} from '@lodex/contracts';
import { privateServerFetch } from '@lodex/providers';

export interface RuntimeRepository {
  localProfiles(): Promise<LocalProfile[]>;
  saveLocalProfile(profile: LocalProfile, expectedVersion?: number): Promise<LocalProfile>;
  removeLocalProfile(id: string): Promise<void>;
  runtimeSettings(): Promise<RuntimeSettings>;
  saveRuntimeSettings(settings: RuntimeSettings): Promise<void>;
}
function environment() {
  const allowed = new Set([
    'path',
    'pathext',
    'systemroot',
    'windir',
    'home',
    'userprofile',
    'localappdata',
    'appdata',
    'temp',
    'tmp',
    'tmpdir',
    'cuda_path',
    'cuda_visible_devices',
    'hip_visible_devices',
    'rocr_visible_devices',
  ]);
  return Object.fromEntries(
    Object.entries(process.env).filter(([key]) => allowed.has(key.toLowerCase())),
  );
}
function fingerprint(info: Awaited<ReturnType<typeof lstat>>) {
  return `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}`;
}
async function inspectFile(path: string) {
  if (!isAbsolute(path) || /[\0\r\n]/.test(path))
    throw new AppError('LOCAL_PATH', '로컬 파일의 절대 경로가 필요합니다.');
  const canonical = await realpath(path);
  const info = await lstat(canonical);
  if (!info.isFile()) throw new AppError('LOCAL_FILE', '일반 파일을 선택하세요.');
  return { path: canonical, size: info.size, identity: fingerprint(info) };
}
async function probe(path: string, arg: '--help' | '--version'): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(path, [arg], {
      cwd: dirname(path),
      env: environment(),
      windowsHide: true,
      shell: false,
    });
    let output = '';
    const timeout = setTimeout(() => child.kill('SIGKILL'), 10000);
    const receive = (chunk: Buffer) => {
      output += chunk.toString('utf8');
      if (output.length > 262144) child.kill('SIGKILL');
    };
    child.stdout.on('data', receive);
    child.stderr.on('data', receive);
    child.stdin.end();
    child.on('error', () => {
      clearTimeout(timeout);
      reject(
        new AppError(
          'ENGINE_PROBE',
          '엔진 실행 파일을 열 수 없습니다. 경로·실행 권한·필요한 라이브러리를 확인하세요.',
        ),
      );
    });
    child.on('close', (code) => {
      clearTimeout(timeout);
      if (code !== 0 || output.length > 262144)
        reject(
          new AppError(
            'ENGINE_PROBE',
            '엔진 정보 조회에 실패했습니다. 호환 llama-server 실행 파일인지 확인하세요.',
          ),
        );
      else resolve(output);
    });
  });
}

export async function inspectProfile(input: LocalProfileInput): Promise<LocalProfile> {
  const parsed = localProfileInputSchema.parse(input);
  const engine = await inspectFile(parsed.enginePath),
    model = await inspectFile(parsed.modelPath);
  const handle = await open(model.path, 'r');
  let version: number;
  try {
    const header = Buffer.alloc(24),
      result = await handle.read(header, 0, header.length, 0);
    if (result.bytesRead !== 24 || header.toString('ascii', 0, 4) !== 'GGUF')
      throw new AppError('GGUF_FORMAT', 'GGUF 모델 파일이 아닙니다.');
    version = header.readUInt32LE(4);
    if (![2, 3].includes(version))
      throw new AppError('GGUF_VERSION', 'GGUF v2/v3 모델을 지원합니다.');
    if (header.readBigUInt64LE(8) === 0n)
      throw new AppError('GGUF_FORMAT', '모델 tensor 정보가 비어 있습니다.');
  } finally {
    await handle.close();
  }
  // --help/--version execute only the engine explicitly selected by the user.
  const help = await probe(engine.path, '--help');
  const engineVersion = (await probe(engine.path, '--version')).trim().slice(0, 2000);
  const supportedFlags = [...new Set(help.match(/--[a-z][a-z0-9-]+/g) ?? [])];
  const profile: LocalProfile = {
    id: parsed.id ?? randomUUID(),
    version: 1,
    name: parsed.name,
    enginePath: engine.path,
    modelPath: model.path,
    settings: parsed.settings,
    vramReservationMb: parsed.settings.gpuLayers === 0 ? 0 : parsed.vramReservationMb,
    modelBytes: model.size,
    modelIdentity: model.identity,
    engineIdentity: engine.identity,
    engineVersion,
    supportedFlags,
    ggufVersion: version,
  };
  engineArguments(profile, 1, 'probe'); // Reject unsupported/reserved options before persisting.
  return profile;
}

const controlled = new Set([
  '-m',
  '--model',
  '-mu',
  '--model-url',
  '-hf',
  '-hfr',
  '--hf-repo',
  '-hff',
  '--hf-file',
  '-hft',
  '--hf-token',
  '-dr',
  '--docker-repo',
  '--host',
  '--port',
  '-a',
  '--alias',
  '--api-key',
  '--api-key-file',
  '--log-file',
  '--log-dir',
  '--models-dir',
  '--models-preset',
  '--models-max',
  '--models-autoload',
  '--webui',
  '--path',
  '--ssl-key-file',
  '--ssl-cert-file',
  '--daemon',
]);
export function engineArguments(profile: LocalProfile, port: number, key: string): string[] {
  const s = profile.settings,
    flags = new Set(profile.supportedFlags);
  const managed: string[] = [];
  const option = (name: string, value?: string | number) => {
    if (!flags.has(name))
      throw new AppError(
        'ENGINE_OPTION',
        `선택한 엔진이 ${name} 옵션을 지원하지 않습니다. 엔진 버전과 설정을 확인하세요.`,
      );
    managed.push(name);
    if (value !== undefined) managed.push(String(value));
  };
  option('--model', profile.modelPath);
  option('--host', '127.0.0.1');
  option('--port', port);
  option('--alias', 'lodex-' + profile.id);
  option('--api-key', key);
  option('--ctx-size', s.contextSize);
  option(flags.has('--gpu-layers') ? '--gpu-layers' : '--n-gpu-layers', s.gpuLayers);
  option('--threads', s.threads);
  option('--threads-batch', s.batchThreads);
  option('--batch-size', s.batchSize);
  option('--ubatch-size', s.microBatchSize);
  option('--flash-attn', s.flashAttention);
  option('--cache-type-k', s.cacheTypeK);
  option('--cache-type-v', s.cacheTypeV);
  option('--parallel', 1);
  option('--jinja');
  if (!s.kvOffload) option('--no-kv-offload');
  if (flags.has('--fit')) option('--fit', 'off'); // Do not silently resize explicitly configured context/KV settings.
  if (s.chatTemplate) option('--chat-template', s.chatTemplate);
  for (const arg of s.extraArgs) {
    const flag = arg.split('=')[0]!;
    if (
      arg === '--' ||
      /^-[a-zA-Z]/.test(arg) ||
      controlled.has(flag) ||
      (flag.startsWith('--') && managed.includes(flag)) ||
      (flag.startsWith('--') && !flags.has(flag))
    )
      throw new AppError(
        'ENGINE_ARGUMENT',
        `추가 옵션 ${flag}은 관리 필드에서 설정하거나 지원되는 엔진 옵션으로 바꿔 주세요.`,
      );
  }
  return [...s.extraArgs, ...managed];
}

interface Instance extends RuntimeInstance {
  child: ChildProcessWithoutNullStreams;
  key: string;
  baseUrl: string;
  closed: boolean;
  engineStopped: boolean;
}
export interface RuntimeLease {
  profileId: string;
  baseUrl: string;
  key: string;
  model: string;
  release: () => Promise<void>;
}
async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing local port');
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}
async function stopChild(instance: Instance) {
  const { child } = instance;
  if (!instance.closed) {
    child.stdin.end(); // Graceful supervisor shutdown also works on Windows.
    await Promise.race([
      new Promise<void>((resolve) => child.once('close', () => resolve())),
      delay(3000),
    ]);
  }
  if (!instance.engineStopped || !instance.closed)
    throw new AppError(
      'ENGINE_STOP',
      '엔진 종료를 확인할 수 없어 VRAM 예약을 유지합니다. 운영체제에서 선택한 엔진의 상태를 확인하세요.',
    );
}

const mib = 1024 * 1024;
function numberField(value: string): number | null {
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}
export function parseNvidiaSmi(output: string): GpuResourceSnapshot[] {
  return output
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .flatMap((line) => {
      const fields = line.split(',').map((value) => value.trim());
      if (fields.length !== 6) return [];
      const index = numberField(fields[0]!);
      const totalVramMb = numberField(fields[2]!);
      const usedVramMb = numberField(fields[3]!);
      const freeVramMb = numberField(fields[4]!);
      const utilizationPercent = numberField(fields[5]!);
      if (
        index === null ||
        !Number.isInteger(index) ||
        !fields[1] ||
        totalVramMb === null ||
        usedVramMb === null ||
        freeVramMb === null
      )
        return [];
      return [
        {
          index,
          name: fields[1].slice(0, 200),
          totalVramMb,
          usedVramMb,
          freeVramMb,
          utilizationPercent:
            utilizationPercent === null ? null : Math.min(100, utilizationPercent),
        },
      ];
    });
}
function nvidiaSmiPath(): string | null {
  const candidates =
    platform() === 'win32'
      ? [
          process.env.SystemRoot && join(process.env.SystemRoot, 'System32', 'nvidia-smi.exe'),
          process.env.ProgramW6432 &&
            join(process.env.ProgramW6432, 'NVIDIA Corporation', 'NVSMI', 'nvidia-smi.exe'),
          process.env.ProgramFiles &&
            join(process.env.ProgramFiles, 'NVIDIA Corporation', 'NVSMI', 'nvidia-smi.exe'),
        ]
      : ['/usr/bin/nvidia-smi', '/usr/local/bin/nvidia-smi'];
  return candidates.find((path): path is string => !!path && existsSync(path)) ?? null;
}
async function gpuResources(): Promise<GpuResourceSnapshot[]> {
  const executable = nvidiaSmiPath();
  if (!executable) return [];
  return new Promise((resolve) => {
    const child = spawn(
      executable,
      [
        '--query-gpu=index,name,memory.total,memory.used,memory.free,utilization.gpu',
        '--format=csv,noheader,nounits',
      ],
      { env: environment(), windowsHide: true, shell: false },
    );
    let output = '';
    let settled = false;
    const done = (value: GpuResourceSnapshot[]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(value);
    };
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      done([]);
    }, 2000);
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
      if (output.length > 65536) {
        child.kill('SIGKILL');
        done([]);
      }
    });
    child.on('error', () => done([]));
    child.on('close', (code) => done(code === 0 ? parseNvidiaSmi(output) : []));
  });
}
async function measureResources(): Promise<RuntimeResources> {
  const systemRamTotalMb = Math.round(totalmem() / mib);
  const systemRamFreeMb = Math.round(freemem() / mib);
  const gpus = await gpuResources();
  return {
    measuredAt: new Date().toISOString(),
    systemRamTotalMb,
    systemRamUsedMb: Math.max(0, systemRamTotalMb - systemRamFreeMb),
    systemRamFreeMb,
    gpuSource: gpus.length ? 'nvidia-smi' : 'unavailable',
    gpus,
  };
}

/** Manages only its own child handles; external llama-server processes are never stopped. */
export class RuntimeManager {
  private instances = new Map<string, Instance>();
  private queue: Promise<unknown> = Promise.resolve();
  private closing = new AbortController();
  private closePromise?: Promise<void>;
  private resourceCache?: { measuredAt: number; value: Promise<RuntimeResources> };
  private idleTimer: NodeJS.Timeout;
  constructor(
    private repository: RuntimeRepository,
    private supervisorPath: string,
  ) {
    this.idleTimer = setInterval(() => void this.sweepIdle().catch(() => undefined), 30000);
    this.idleTimer.unref();
  }
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn);
    this.queue = next.catch(() => undefined);
    return next;
  }
  async snapshot(): Promise<RuntimeSnapshot> {
    const now = Date.now();
    if (!this.resourceCache || now - this.resourceCache.measuredAt >= 2000)
      this.resourceCache = { measuredAt: now, value: measureResources() };
    const [profiles, settings, resources] = await Promise.all([
      this.repository.localProfiles(),
      this.repository.runtimeSettings(),
      this.resourceCache.value,
    ]);
    return {
      profiles,
      settings,
      instances: [...this.instances.values()].map(
        ({
          child: _child,
          key,
          baseUrl: _url,
          closed: _closed,
          engineStopped: _engineStopped,
          ...instance
        }) => ({
          ...instance,
          log: instance.log.replaceAll(key, '[redacted]'),
        }),
      ),
      resources,
    };
  }
  register(input: LocalProfileInput) {
    return this.serial(async () => {
      this.closing.signal.throwIfAborted();
      const parsed = localProfileInputSchema.parse(input);
      const previous = (await this.repository.localProfiles()).find((p) => p.id === parsed.id);
      if (
        (previous && previous.version !== parsed.expectedVersion) ||
        (!previous && parsed.expectedVersion !== undefined)
      )
        throw new AppError(
          'VERSION_CONFLICT',
          '모델 설정이 변경되었습니다. 목록을 새로 불러오세요.',
          409,
        );
      if (parsed.id && this.instances.get(parsed.id)?.leases)
        throw new AppError('MODEL_IN_USE', '응답에 사용 중인 모델은 수정할 수 없습니다.', 409);
      // Invalid paths or options must not evict an otherwise healthy loaded model.
      const profile = await inspectProfile(parsed);
      this.closing.signal.throwIfAborted();
      if (parsed.id) await this.stop(parsed.id);
      return this.repository.saveLocalProfile(profile, parsed.expectedVersion);
    });
  }
  remove(id: string) {
    return this.serial(async () => {
      this.closing.signal.throwIfAborted();
      await this.stop(id);
      await this.repository.removeLocalProfile(id);
    });
  }
  configure(settings: RuntimeSettings) {
    return this.serial(async () => {
      this.closing.signal.throwIfAborted();
      const parsed = runtimeSettingsSchema.parse(settings);
      if (parsed.version !== (await this.repository.runtimeSettings()).version)
        throw new AppError(
          'VERSION_CONFLICT',
          'VRAM 설정이 변경되었습니다. 최신 값을 불러오세요.',
          409,
        );
      await this.makeRoom(0, parsed);
      await this.repository.saveRuntimeSettings(parsed);
    });
  }
  private async stop(id: string) {
    const instance = this.instances.get(id);
    if (!instance || instance.status === 'stopped') return;
    if (instance.leases)
      throw new AppError(
        'MODEL_IN_USE',
        '응답에 사용 중인 모델은 언로드하거나 수정할 수 없습니다.',
        409,
      );
    await stopChild(instance);
    instance.status = 'stopped';
    instance.reservedVramMb = 0;
  }
  unload(id: string) {
    return this.serial(() => this.stop(id));
  }
  sweepIdle(now = Date.now()) {
    return this.serial(async () => {
      if (this.closing.signal.aborted) return;
      const settings = await this.repository.runtimeSettings();
      if (!settings.autoUnloadIdle) return;
      const cutoff = now - settings.idleUnloadMinutes * 60000;
      const expired = [...this.instances.values()]
        .filter(
          (instance) =>
            instance.status === 'ready' &&
            instance.leases === 0 &&
            Date.parse(instance.lastUsedAt) <= cutoff,
        )
        .sort((left, right) => left.lastUsedAt.localeCompare(right.lastUsedAt));
      for (const instance of expired) await this.stop(instance.profileId);
    });
  }
  private async makeRoom(required: number, settings: RuntimeSettings) {
    const available = settings.vramBudgetMb - settings.headroomMb;
    if (required > available)
      throw new AppError(
        'VRAM_BUDGET',
        '모델의 VRAM 예약량이 사용 가능한 예산보다 큽니다. 모델 설정이나 VRAM 예산을 조정하세요.',
      );
    const reserved = () =>
      [...this.instances.values()].reduce((sum, i) => sum + i.reservedVramMb, 0);
    if (reserved() + required <= available) return;
    if (settings.autoUnloadIdle) {
      const idle = [...this.instances.values()]
        .filter((i) => i.leases === 0 && i.status === 'ready')
        .sort((a, b) => a.lastUsedAt.localeCompare(b.lastUsedAt));
      const reclaimable = idle.reduce((sum, i) => sum + i.reservedVramMb, 0);
      // Reject an impossible reservation before unloading any idle engines.
      if (reserved() - reclaimable + required <= available) {
        for (const instance of idle) {
          await this.stop(instance.profileId);
          if (reserved() + required <= available) return;
        }
      }
    }
    throw new AppError(
      'VRAM_BUSY',
      'VRAM 예약 공간이 부족합니다. 사용 중인 응답을 기다리거나 모델을 언로드하세요.',
      409,
    );
  }
  acquire(id: string, parent: AbortSignal, expectedVersion?: number): Promise<RuntimeLease> {
    return this.serial(async () => {
      const signal = AbortSignal.any([parent, this.closing.signal, AbortSignal.timeout(180000)]);
      signal.throwIfAborted();
      const profile = (await this.repository.localProfiles()).find((p) => p.id === id);
      if (!profile) throw new AppError('MODEL_NOT_FOUND', '등록된 모델을 찾을 수 없습니다.', 404);
      if (expectedVersion !== undefined && profile.version !== expectedVersion)
        throw new AppError(
          'VERSION_CONFLICT',
          '모델 설정이 변경되었습니다. 모델을 다시 선택하세요.',
          409,
        );
      signal.throwIfAborted();
      let instance = this.instances.get(id);
      if (!instance || instance.status !== 'ready') {
        if (instance && instance.status !== 'stopped') await this.stop(id);
        const engine = await inspectFile(profile.enginePath),
          model = await inspectFile(profile.modelPath);
        if (engine.identity !== profile.engineIdentity || model.identity !== profile.modelIdentity)
          throw new AppError(
            'MODEL_CHANGED',
            '엔진 또는 모델 파일이 등록 이후 변경되었습니다. 정보를 다시 확인해 등록하세요.',
            409,
          );
        await this.makeRoom(profile.vramReservationMb, await this.repository.runtimeSettings());
        signal.throwIfAborted();
        const port = await freePort(),
          key = randomBytes(32).toString('hex');
        signal.throwIfAborted();
        const args = engineArguments(profile, port, key);
        const child = spawn(process.execPath, [this.supervisorPath], {
          env: environment(),
          windowsHide: true,
          shell: false,
          stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
        }) as ChildProcessWithoutNullStreams;
        instance = {
          profileId: id,
          status: 'loading',
          leases: 0,
          reservedVramMb: profile.vramReservationMb,
          startedAt: new Date().toISOString(),
          lastUsedAt: new Date().toISOString(),
          log: '',
          child,
          key,
          closed: false,
          engineStopped: false,
          baseUrl: `http://127.0.0.1:${port}/v1`,
        };
        this.instances.set(id, instance);
        const current = instance;
        for (const stream of [child.stdout, child.stderr]) {
          const decoder = new StringDecoder('utf8');
          let pending = '';
          const log = (text: string, end = false) => {
            const safe = (pending + text).replaceAll(key, '[redacted]');
            let keep = 0;
            for (let size = 1; size < key.length && size <= safe.length; size++) {
              if (key.startsWith(safe.slice(-size))) keep = size;
            }
            pending = safe.slice(safe.length - keep);
            const visible = safe.slice(0, safe.length - keep);
            // Hold a possible key prefix across chunks; snapshots must never expose it.
            current.log = (current.log + visible + (end && keep ? '[redacted]' : '')).slice(-16000);
            if (end) pending = '';
          };
          stream.on('data', (chunk: Buffer) => log(decoder.write(chunk)));
          stream.on('end', () => log(decoder.end(), true));
        }
        child.stdin.on('error', () => {
          current.status = 'failed';
          current.error = '엔진 감독 프로세스 연결이 종료되었습니다.';
        });
        child.on('error', () => {
          current.status = 'failed';
          current.error = '엔진을 시작하지 못했습니다. 실행 파일과 라이브러리를 확인하세요.';
          if (child.pid === undefined) current.engineStopped = true;
        });
        child.on('message', (message: unknown) => {
          if (
            typeof message === 'object' &&
            message !== null &&
            'type' in message &&
            message.type === 'engine_stopped'
          ) {
            current.engineStopped = true;
            current.reservedVramMb = 0;
          }
        });
        child.on('close', () => {
          current.closed = true;
          if (current.status !== 'stopped') current.status = 'failed';
          if (current.engineStopped) current.reservedVramMb = 0;
          else
            current.error =
              '엔진 감독 프로세스가 종료되었지만 엔진 종료는 확인되지 않았습니다. VRAM 예약을 유지합니다.';
        });
        child.stdin.write(
          JSON.stringify({
            executable: profile.enginePath,
            args,
            cwd: dirname(profile.enginePath),
          }) + '\n',
        );
        try {
          while (true) {
            signal.throwIfAborted();
            if (current.status === 'failed')
              throw new AppError(
                'ENGINE_EXIT',
                current.error ??
                  '모델 로딩 중 엔진이 종료되었습니다. 엔진 로그와 메모리 설정을 확인하세요.',
              );
            try {
              const response = await privateServerFetch(`http://127.0.0.1:${port}/health`, {
                headers: { Authorization: 'Bearer ' + key },
                redirect: 'error',
                signal: AbortSignal.any([signal, AbortSignal.timeout(1000)]),
              });
              await response.body?.cancel();
              signal.throwIfAborted();
              if (response.ok && current.status === 'loading') break;
            } catch {
              signal.throwIfAborted();
            }
            await delay(250, undefined, { signal });
          }
          current.status = 'ready';
        } catch (error) {
          current.error =
            error instanceof AppError
              ? error.message
              : '모델 로딩이 중지되거나 3분 한도를 초과했습니다.';
          current.status = 'failed';
          await stopChild(current);
          current.reservedVramMb = 0;
          throw new AppError('MODEL_LOAD', current.error);
        }
      }
      signal.throwIfAborted();
      instance.leases++;
      instance.lastUsedAt = new Date().toISOString();
      let released = false;
      const acquired = instance;
      return {
        profileId: id,
        baseUrl: instance.baseUrl,
        key: instance.key,
        model: 'lodex-' + id,
        release: () =>
          this.serial(async () => {
            if (!released) {
              released = true;
              acquired.leases = Math.max(0, acquired.leases - 1);
              acquired.lastUsedAt = new Date().toISOString();
            }
          }),
      };
    });
  }
  close(): Promise<void> {
    if (!this.closePromise) {
      this.closing.abort();
      clearInterval(this.idleTimer);
      this.closePromise = this.serial(async () => {
        const results = await Promise.allSettled(
          [...this.instances.values()].map(async (instance) => {
            instance.leases = 0;
            await stopChild(instance);
            instance.status = 'stopped';
            instance.reservedVramMb = 0;
          }),
        );
        const failure = results.find((result) => result.status === 'rejected');
        if (failure?.status === 'rejected') throw failure.reason;
      });
    }
    return this.closePromise;
  }
}

export type { EngineSettings };
