import { t as localize } from './i18n';
import type { ArtifactCheck } from '@lodex/contracts';

export function ArtifactChecksEditor({
  checks,
  onChange,
  label,
}: {
  checks: ArtifactCheck[];
  onChange: (checks: ArtifactCheck[]) => void;
  label: string;
}) {
  return (
    <fieldset className="artifact-checks">
      <legend>{label}</legend>
      <p>
        {localize(
          '프로젝트의 UTF-8 파일을 확인합니다. 필요한 내용이나 SHA-256을 추가할 수 있습니다.',
        )}
      </p>
      {checks.map((check, index) => (
        <div key={index}>
          <input
            aria-label={localize('{0} {1} 경로', label, index + 1)}
            placeholder={localize('예: src/app.ts')}
            value={check.path}
            onChange={(event) =>
              onChange(
                checks.map((entry, at) =>
                  at === index ? { ...entry, path: event.target.value } : entry,
                ),
              )
            }
          />
          <input
            aria-label={localize('{0} {1} 필요한 내용', label, index + 1)}
            placeholder={localize('필요한 내용 (선택)')}
            value={check.contains ?? ''}
            onChange={(event) =>
              onChange(
                checks.map((entry, at) => {
                  if (at !== index) return entry;
                  const { contains, ...rest } = entry;
                  return event.target.value ? { ...rest, contains: event.target.value } : rest;
                }),
              )
            }
          />
          <input
            aria-label={`${label} ${index + 1} SHA-256`}
            placeholder={localize('SHA-256 (선택)')}
            value={check.sha256 ?? ''}
            onChange={(event) =>
              onChange(
                checks.map((entry, at) => {
                  if (at !== index) return entry;
                  const { sha256, ...rest } = entry;
                  return event.target.value ? { ...rest, sha256: event.target.value } : rest;
                }),
              )
            }
          />
          <button type="button" onClick={() => onChange(checks.filter((_, at) => at !== index))}>
            {localize('삭제')}
          </button>
        </div>
      ))}
      <button
        type="button"
        disabled={checks.length >= 16}
        onClick={() => onChange([...checks, { path: '' }])}
      >
        {localize('검증 파일 추가')}
      </button>
    </fieldset>
  );
}
