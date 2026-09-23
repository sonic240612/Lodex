import { useState, type FormEvent } from 'react';
import type { Activity, ElicitationValue } from '@lodex/contracts';

type DraftValue = string | boolean | string[] | undefined;

function initialValues(activity: Activity): Record<string, DraftValue> {
  return Object.fromEntries(
    (activity.elicitation?.fields ?? []).map((field) => {
      const value = field.default;
      return [
        field.name,
        typeof value === 'number' ? String(value) : value === undefined ? undefined : value,
      ];
    }),
  );
}

export function McpElicitationBanner({
  activity,
  busy,
  onDecide,
  onOpen,
}: {
  activity: Activity;
  busy: boolean;
  onDecide: (
    action: 'accept' | 'decline' | 'cancel',
    content?: Record<string, ElicitationValue>,
  ) => Promise<void>;
  onOpen: (url: string) => Promise<void>;
}) {
  const elicitation = activity.elicitation!;
  const [values, setValues] = useState<Record<string, DraftValue>>(() => initialValues(activity));
  const [opened, setOpened] = useState(false);
  const [openError, setOpenError] = useState('');
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const content: Record<string, ElicitationValue> = {};
    for (const field of elicitation.fields ?? []) {
      const value = values[field.name];
      if (value === undefined) continue;
      content[field.name] =
        field.type === 'number' || field.type === 'integer' ? Number(value) : value;
    }
    void onDecide('accept', content);
  };
  return (
    <form
      className="permission-banner elicitation-banner"
      role="dialog"
      aria-label="MCP 사용자 입력 요청"
      onSubmit={submit}
    >
      <div className="elicitation-content">
        <strong>MCP 사용자 입력 · {elicitation.source}</strong>
        <p>{elicitation.message}</p>
        {elicitation.mode === 'url' ? (
          <div className="elicitation-url">
            <code>{elicitation.url}</code>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setOpenError('');
                void onOpen(elicitation.url!)
                  .then(() => setOpened(true))
                  .catch((error: unknown) =>
                    setOpenError(error instanceof Error ? error.message : '링크를 열지 못했습니다.'),
                  );
              }}
            >
              링크 열기
            </button>
            {openError && <span role="alert">{openError}</span>}
          </div>
        ) : (
          <div className="elicitation-fields">
            {elicitation.fields?.map((field) => {
              const value = values[field.name];
              return (
                <div className="elicitation-field" key={field.name}>
                  <span>
                    {field.title}
                    {field.required ? ' *' : ''}
                  </span>
                  {field.description && <small>{field.description}</small>}
                  {field.type === 'boolean' ? (
                    <select
                      aria-label={field.title}
                      required={field.required}
                      value={value === undefined ? '' : value ? 'true' : 'false'}
                      onChange={(event) =>
                        setValues((old) => ({
                          ...old,
                          [field.name]:
                            event.target.value === '' ? undefined : event.target.value === 'true',
                        }))
                      }
                    >
                      <option value="">선택 안 함</option>
                      <option value="true">예</option>
                      <option value="false">아니요</option>
                    </select>
                  ) : field.type === 'select' ? (
                    <select
                      aria-label={field.title}
                      required={field.required}
                      value={typeof value === 'string' ? value : ''}
                      onChange={(event) =>
                        setValues((old) => ({
                          ...old,
                          [field.name]: event.target.value || undefined,
                        }))
                      }
                    >
                      <option value="">선택 안 함</option>
                      {field.options?.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.title}
                        </option>
                      ))}
                    </select>
                  ) : field.type === 'multiselect' ? (
                    <div className="elicitation-options">
                      {field.options?.map((option) => {
                        const selected = Array.isArray(value) && value.includes(option.value);
                        return (
                          <label key={option.value}>
                            <input
                              type="checkbox"
                              checked={selected}
                              onChange={(event) =>
                                setValues((old) => {
                                  const stored = old[field.name];
                                  const current: string[] = Array.isArray(stored) ? stored : [];
                                  return {
                                    ...old,
                                    [field.name]: event.target.checked
                                      ? [...current, option.value]
                                      : current.filter((item) => item !== option.value),
                                  };
                                })
                              }
                            />
                            {option.title}
                          </label>
                        );
                      })}
                    </div>
                  ) : (
                    <input
                      aria-label={field.title}
                      type={
                        field.type === 'number' || field.type === 'integer'
                          ? 'number'
                          : field.format === 'email'
                            ? 'email'
                            : field.format === 'uri'
                              ? 'url'
                              : field.format === 'date'
                                ? 'date'
                                : 'text'
                      }
                      required={field.required}
                      value={typeof value === 'string' ? value : ''}
                      min={field.minimum}
                      max={field.maximum}
                      step={
                        field.type === 'integer' ? 1 : field.type === 'number' ? 'any' : undefined
                      }
                      minLength={field.minLength}
                      maxLength={field.maxLength ?? 8192}
                      placeholder={
                        field.format === 'date-time' ? '2026-09-23T12:00:00Z' : undefined
                      }
                      onChange={(event) =>
                        setValues((old) => ({
                          ...old,
                          [field.name]:
                            (field.type === 'number' || field.type === 'integer') &&
                            event.target.value === ''
                              ? undefined
                              : event.target.value,
                        }))
                      }
                    />
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
      <div className="elicitation-actions">
        <button type="button" disabled={busy} onClick={() => void onDecide('cancel')}>
          취소
        </button>
        <button type="button" disabled={busy} onClick={() => void onDecide('decline')}>
          거절
        </button>
        <button
          className="permission-allow"
          type="submit"
          disabled={busy || (elicitation.mode === 'url' && !opened)}
        >
          {elicitation.mode === 'url' ? '완료 후 계속' : '제출'}
        </button>
      </div>
    </form>
  );
}
