import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { BackupImportPreview } from '@lodex/contracts';
import { BackupRestorePreview } from './BackupRestorePreview';

const preview: BackupImportPreview = {
  token: 'fixture',
  fileName: 'Lodex backup.json',
  sha256: 'a'.repeat(64),
  exportedAt: '2026-10-08T00:00:00Z',
  expiresAt: '2026-10-08T01:00:00Z',
  items: [{ kind: 'sessions', label: '대화·계획', importable: 2, conflicts: 1, skipped: 3 }],
  warnings: ['기존 데이터를 덮어쓰지 않습니다.'],
};
describe('backup restore confirmation', () => {
  it('shows counts, conflicts and limitations before the explicit confirmation action', () => {
    const restore = vi.fn();
    const html = renderToStaticMarkup(
      <BackupRestorePreview
        preview={preview}
        busy={false}
        onRestore={restore}
        onCancel={vi.fn()}
      />,
    );
    expect(html).toContain('백업 복원 미리보기');
    expect(html).toContain('이미 있음');
    expect(html).toContain('복원 불가');
    expect(html).toContain('<td>2</td><td>1</td><td>3</td>');
    expect(html).toContain('기존 데이터를 덮어쓰지 않습니다.');
    expect(html).toContain('확인하고 복원');
    expect(html).not.toContain('disabled');
    expect(restore).not.toHaveBeenCalled();
  });
  it('disables restoration while busy or when every record was skipped', () => {
    const render = (value: BackupImportPreview, busy: boolean) =>
      renderToStaticMarkup(
        <BackupRestorePreview preview={value} busy={busy} onRestore={vi.fn()} onCancel={vi.fn()} />,
      );
    expect(render(preview, true).match(/disabled=""/g)).toHaveLength(2);
    expect(
      render(
        { ...preview, items: preview.items.map((item) => ({ ...item, importable: 0 })) },
        false,
      ).match(/disabled=""/g),
    ).toHaveLength(1);
  });
});
