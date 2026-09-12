import { join } from 'node:path';
import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { Store } from '@lodex/storage';
import { startServer } from './server';
import { loadSecrets } from './secrets';
declare const __dirname: string;
let startupStage = 'bootstrap';

async function main() {
  const lines = createInterface({ input: process.stdin });
  const bootstrap = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Bootstrap timeout.')), 10000);
    lines.once('line', (line) => {
      clearTimeout(timer);
      resolve(line);
    });
  });
  lines.close();
  process.stdin.resume();
  const config = JSON.parse(bootstrap) as {
    token: string;
    dataDir: string;
    openrouterKey?: string | null;
    parentPid?: number;
    envFile?: string;
  };
  if (!/^[a-f0-9]{64}$/.test(config.token) || !config.dataDir)
    throw new Error('Invalid bootstrap.');
  await mkdir(config.dataDir, { recursive: true, mode: 0o700 });
  startupStage = 'secrets';
  const secrets = await loadSecrets({
    envFilePath: process.env.LODEX_ENV_FILE || config.envFile || join(config.dataDir, '.env'),
    requiredFile: !!process.env.LODEX_ENV_FILE,
    environment: { OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY },
    keychainKey: config.openrouterKey ?? null,
  });
  startupStage = 'lock';
  const lockPath = join(config.dataDir, 'daemon.lock');
  const claim = async () => {
    try {
      return await open(lockPath, 'wx', 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const previous = JSON.parse(await readFile(lockPath, 'utf8')) as { pid: number };
      if (!Number.isInteger(previous.pid) || previous.pid <= 0)
        throw new Error('Invalid daemon lock; manual inspection required.');
      try {
        process.kill(previous.pid, 0);
        throw new Error('Lodex daemon already owns this database.');
      } catch (probe) {
        if ((probe as NodeJS.ErrnoException).code !== 'ESRCH') throw probe;
        await unlink(lockPath);
        return open(lockPath, 'wx', 0o600);
      }
    }
  };
  const lock = await claim();
  await lock.writeFile(JSON.stringify({ pid: process.pid }));
  await lock.close();
  startupStage = 'storage';
  const store = await Store.open(
    join(config.dataDir, 'lodex.sqlite'),
    join(__dirname, 'worker.cjs'),
  );
  startupStage = 'server';
  const app = await startServer({
    token: config.token,
    store,
    supervisorPath: join(__dirname, 'supervisor.cjs'),
    ...secrets,
  });
  process.stdout.write(JSON.stringify({ protocolVersion: 1, port: app.port }) + '\n');
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    clearInterval(parentCheck);
    await app.close();
    const owner = JSON.parse(await readFile(lockPath, 'utf8')) as { pid: number };
    if (owner.pid === process.pid) await unlink(lockPath);
    process.exit(0);
  };
  const parentCheck = setInterval(() => {
    if (!config.parentPid) return;
    try {
      process.kill(config.parentPid, 0);
    } catch {
      void shutdown();
    }
  }, 1000);
  process.on('SIGTERM', () => {
    void shutdown();
  });
  process.on('SIGINT', () => {
    void shutdown();
  });
  // Closing the private parent pipe means the desktop has exited.
  process.stdin.on('end', () => {
    void shutdown();
  });
}
main().catch((error) => {
  process.stderr.write(
    'Lodex daemon startup failed at ' +
      startupStage +
      ' (' +
      (typeof error?.code === 'string' ? error.code : 'STARTUP_ERROR') +
      '). Check the application data directory and runtime.\n',
  );
  process.exit(1);
});
