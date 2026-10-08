import { t as localize } from './i18n';
import type { BackupImportPreview } from '@lodex/contracts';

export function BackupRestorePreview({
  preview,
  busy,
  onRestore,
  onCancel,
}: {
  preview: BackupImportPreview;
  busy: boolean;
  onRestore: () => void;
  onCancel: () => void;
}) {
  return (
    <section className="backup-restore-preview" aria-label={localize('백업 복원 미리보기')}>
      <h3>{localize('복원 미리보기')}</h3>
      <p>
        {preview.fileName} · {new Date(preview.exportedAt).toLocaleString()}
      </p>
      <p>SHA-256 {preview.sha256.slice(0, 16)}…</p>
      <table>
        <thead>
          <tr>
            <th>{localize('항목')}</th>
            <th>{localize('복원')}</th>
            <th>{localize('이미 있음')}</th>
            <th>{localize('복원 불가')}</th>
          </tr>
        </thead>
        <tbody>
          {preview.items.map((item) => (
            <tr key={item.kind}>
              <th scope="row">{item.label}</th>
              <td>{item.importable}</td>
              <td>{item.conflicts}</td>
              <td>{item.skipped}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <ul>
        {preview.warnings.map((warning) => (
          <li key={warning}>{warning}</li>
        ))}
      </ul>
      <div className="edit-actions">
        <button
          type="button"
          className="primary-button"
          disabled={busy || !preview.items.some((item) => item.importable)}
          onClick={onRestore}
        >
          {localize('확인하고 복원')}
        </button>
        <button type="button" className="secondary-button" disabled={busy} onClick={onCancel}>
          {localize('취소')}
        </button>
      </div>
    </section>
  );
}
