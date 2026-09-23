import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  AppError,
  backupSettingsSchema,
  type BackupRecord,
  type BackupSettings,
  type BackupSnapshot,
} from '@lodex/contracts';

const settingsName = 'settings.json';
const backupName = /^lodex-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z)-([a-f0-9]{64})\.json$/;

export class Backups {
  private settings: BackupSettings = backupSettingsSchema.parse({});
  private timer?: NodeJS.Timeout;
  private operation: Promise<unknown> = Promise.resolve();
  private constructor(
    private root: string,
    private build: () => Promise<unknown>,
  ) {}
  static async open(root: string, build: () => Promise<unknown>) {
    const manager = new Backups(root, build);
    await mkdir(root, { recursive: true, mode: 0o700 });
    try {
      manager.settings = backupSettingsSchema.parse(
        JSON.parse(await readFile(join(root, settingsName), 'utf8')),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        throw new AppError('BACKUP_SETTINGS', '백업 설정 파일을 읽을 수 없습니다.');
      await manager.saveSettings();
    }
    await manager.prune();
    manager.timer = setInterval(() => void manager.maybeAutomatic(), 60 * 60 * 1000);
    manager.timer.unref();
    void manager.maybeAutomatic();
    return manager;
  }
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const task = this.operation.then(work);
    this.operation = task.catch(() => undefined);
    return task;
  }
  private async saveSettings() {
    const temporary = join(this.root, settingsName + '.tmp');
    await writeFile(temporary, JSON.stringify(this.settings), { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, join(this.root, settingsName));
  }
  private async records(): Promise<(BackupRecord & { path: string })[]> {
    const entries = await readdir(this.root, { withFileTypes: true });
    const records = await Promise.all(
      entries.flatMap((entry) => {
        const match = entry.isFile() ? backupName.exec(entry.name) : null;
        if (!match) return [];
        return [
          (async () => {
            const path = join(this.root, entry.name);
            const info = await stat(path);
            return {
              name: entry.name,
              createdAt: match[1]!.replace(
                /^(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2}\.\d{3}Z)$/,
                '$1:$2:$3',
              ),
              bytes: info.size,
              sha256: match[2]!,
              path,
            };
          })(),
        ];
      }),
    );
    return records.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }
  async snapshot(): Promise<BackupSnapshot> {
    return {
      settings: structuredClone(this.settings),
      backups: (await this.records()).map(({ path: _path, ...record }) => record),
    };
  }
  configure(value: BackupSettings) {
    return this.serial(async () => {
      this.settings = backupSettingsSchema.parse(value);
      await this.saveSettings();
      await this.prune();
      return this.snapshot();
    });
  }
  create(reason: 'manual' | 'automatic' | 'export' = 'manual') {
    return this.serial(() => this.createUnlocked(reason));
  }
  private async createUnlocked(reason: 'manual' | 'automatic' | 'export') {
    const payload = {
      format: 'lodex-backup-v1',
      backupId: randomUUID(),
      exportedAt: new Date().toISOString(),
      reason,
      secretsIncluded: false,
      data: await this.build(),
    };
    const bytes = Buffer.from(JSON.stringify(payload));
    if (bytes.length > 268_435_456)
      throw new AppError('BACKUP_SIZE', '백업 데이터가 256 MiB를 초과했습니다.');
    const digest = createHash('sha256').update(bytes).digest('hex');
    const stamp = payload.exportedAt.replace(/:/g, '-');
    const name = `lodex-${stamp}-${digest}.json`;
    const path = join(this.root, name);
    const handle = await open(path, 'wx', 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await this.prune();
    return {
      backup: {
        name,
        createdAt: payload.exportedAt,
        bytes: bytes.length,
        sha256: digest,
      } satisfies BackupRecord,
      path,
      snapshot: await this.snapshot(),
    };
  }
  remove(name: string) {
    return this.serial(async () => {
      if (!backupName.test(name)) throw new AppError('BACKUP_NAME', '백업 파일 이름이 올바르지 않습니다.');
      await unlink(join(this.root, name));
      return this.snapshot();
    });
  }
  private async prune() {
    const records = await this.records();
    const cutoff = Date.now() - this.settings.retentionDays * 86_400_000;
    for (const [index, record] of records.entries())
      if (index >= this.settings.retentionCount || Date.parse(record.createdAt) < cutoff)
        await unlink(record.path).catch(() => undefined);
  }
  private maybeAutomatic() {
    return this.serial(async () => {
      if (!this.settings.automatic) return;
      const latest = (await this.records())[0];
      if (latest && Date.now() - Date.parse(latest.createdAt) < 24 * 60 * 60 * 1000) return;
      await this.createUnlocked('automatic');
    }).catch(() => undefined);
  }
  async close() {
    if (this.timer) clearInterval(this.timer);
    await this.operation;
  }
}
