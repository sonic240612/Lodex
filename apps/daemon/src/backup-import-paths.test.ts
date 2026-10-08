import { beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { lstat, open, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Store } from '@lodex/storage';
import { BackupImporter, isLocalBackupImportPath } from './backup-import';

// No UNC fixture may reach the operating system or contact a share, even if a guard regresses.
vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof import('node:fs/promises')>()),
  open: vi.fn(),
  realpath: vi.fn(),
  lstat: vi.fn(),
}));
beforeEach(() => vi.resetAllMocks());

const remotePaths = [
  String.raw`\\server.invalid\share\backup.json`,
  '//server.invalid/share/backup.json',
  String.raw`/\server.invalid\share\backup.json`,
  String.raw`\\?\UNC\server.invalid\share\backup.json`,
  '//?/UNC/server.invalid/share/backup.json',
  String.raw`\\.\UNC\server.invalid\share\backup.json`,
  String.raw`\\?\GLOBALROOT\Device\Mup\server.invalid\share\backup.json`,
  String.raw`\??\UNC\server.invalid\share\backup.json`,
  String.raw`\Device\Mup\server.invalid\share\backup.json`,
  'smb://server.invalid/share/backup.json',
  'file://server.invalid/share/backup.json',
];

function importer() {
  return new BackupImporter({
    backupImportCatalog: vi.fn().mockResolvedValue({
      fingerprint: 'fixture',
      projects: [],
      profiles: [],
      skills: [],
      mcp: [],
      sessionIds: [],
      deletedSessionIds: [],
    }),
  } as unknown as Store);
}

function mockDocument(kind: 'projects' | 'skills' | 'profiles', item: unknown) {
  const bytes = Buffer.from(
    JSON.stringify({
      format: 'lodex-backup-v1',
      backupId: randomUUID(),
      exportedAt: new Date().toISOString(),
      secretsIncluded: false,
      data: {
        state: { protocolVersion: 1, projects: kind === 'projects' ? [item] : [], sessions: [] },
        skills: kind === 'skills' ? [item] : [],
        profiles: kind === 'profiles' ? [item] : [],
      },
    }),
  );
  const handle = {
    stat: vi.fn().mockResolvedValue({ isFile: () => true, size: bytes.length, mtimeMs: 1 }),
    read: vi.fn(async (target: Buffer, offset: number, length: number, position: number) => ({
      bytesRead: bytes.copy(target, offset, position, position + length),
    })),
    close: vi.fn().mockResolvedValue(undefined),
  };
  vi.mocked(open).mockResolvedValue(handle as unknown as Awaited<ReturnType<typeof open>>);
}

describe('local-only backup import paths', () => {
  it.each(remotePaths)('rejects a remote backup before any filesystem lookup: %s', async (path) => {
    await expect(importer().preview(path)).rejects.toMatchObject({ code: 'BACKUP_PATH' });
    expect(open).not.toHaveBeenCalled();
    expect(realpath).not.toHaveBeenCalled();
    expect(lstat).not.toHaveBeenCalled();
    expect(isLocalBackupImportPath(path, 'win32')).toBe(false);
  });

  it('allows ordinary Windows drive paths and macOS/Linux absolute paths', () => {
    for (const path of [String.raw`C:\Users\사용자\backup.json`, 'D:/Models/model.gguf', 'c:\\'])
      expect(isLocalBackupImportPath(path, 'win32')).toBe(true);
    for (const platform of ['darwin', 'linux'] as const)
      for (const path of [
        '/Users/name/Library/Application Support/Lodex/backup.json',
        '/tmp/모델.gguf',
      ])
        expect(isLocalBackupImportPath(path, platform)).toBe(true);
    for (const path of [
      String.raw`\\?\C:\backup.json`,
      'C:backup.json',
      '\\backup.json',
      'C:/NUL',
      'C:/tmp/file:stream',
      'relative.json',
      'C:/bad\nfile',
    ])
      expect(isLocalBackupImportPath(path, 'win32')).toBe(false);
  });

  it.each(['projects', 'skills', 'enginePath', 'modelPath', 'modelFiles'] as const)(
    'skips a remote %s item before inspecting any referenced file',
    async (field) => {
      const remote = remotePaths[3]!;
      const kind = field === 'projects' || field === 'skills' ? field : 'profiles';
      const entry =
        field === 'projects'
          ? { id: randomUUID(), path: remote, identity: 'fixture' }
          : field === 'skills'
            ? {
                id: randomUUID(),
                source: { rootPath: remote, rootIdentity: 'fixture' },
                dialect: 'standard',
              }
            : {
                id: randomUUID(),
                enginePath: field === 'enginePath' ? remote : resolve('fixture-engine'),
                modelPath: field === 'modelPath' ? remote : resolve('fixture-model.gguf'),
                ...(field === 'modelFiles' ? { modelFiles: [{ path: remote }] } : {}),
              };
      mockDocument(kind, entry);
      const path = resolve('fixture-backup.json');
      const preview = await importer().preview(path);
      expect(preview.items.find((item) => item.kind === kind)).toMatchObject({
        importable: 0,
        skipped: 1,
      });
      expect(open).toHaveBeenCalledExactlyOnceWith(path, 'r');
      expect(realpath).not.toHaveBeenCalled();
      expect(lstat).not.toHaveBeenCalled();
    },
  );
});
