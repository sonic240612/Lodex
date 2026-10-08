import { t as localize } from './i18n';
import { useEffect, useState } from 'react';
import {
  automationInputSchema,
  type AutomationInput,
  type AutomationRecord,
  type AutomationSnapshot,
  type Session,
} from '@lodex/contracts';
import { automationList, saveAutomation, removeAutomation } from './bridge';
import { SettingsSurface } from './SettingsSurface';
const initial = (sessionId: string): AutomationInput => ({
  name: '',
  sessionId,
  prompt: '',
  enabled: false,
  trigger: { kind: 'interval', minutes: 60 },
});
const statuses = {
  starting: '시작 중',
  running: '실행 중',
  completed: '완료',
  failed: '실패',
  cancelled: '취소됨',
  interrupted: '중단됨',
};
export function AutomationSettings({ session }: { session: Session }) {
  const [snapshot, setSnapshot] = useState<AutomationSnapshot>({ version: 0, records: [] });
  const [input, setInput] = useState<AutomationInput>(() => initial(session.id));
  const [paths, setPaths] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    const refresh = () => {
      void automationList()
        .then((value) => {
          if (alive) setSnapshot(value);
        })
        .catch((error: Error) => {
          if (alive) setError(error.message);
        });
    };
    refresh();
    const timer = setInterval(refresh, 10000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);
  const reset = () => {
    setInput(initial(session.id));
    setPaths('');
  };
  async function act(action: () => Promise<AutomationSnapshot>) {
    setBusy(true);
    setError('');
    try {
      setSnapshot(await action());
      reset();
    } catch (error) {
      setError(error instanceof Error ? error.message : localize('예약 실행 설정에 실패했습니다.'));
    } finally {
      setBusy(false);
    }
  }
  function edit(record: AutomationRecord) {
    setInput({
      id: record.id,
      name: record.name,
      sessionId: record.sessionId,
      prompt: record.prompt,
      enabled: record.enabled,
      trigger: record.trigger,
    });
    setPaths(record.trigger.kind === 'files' ? record.trigger.paths.join('\n') : '');
  }
  function save() {
    const parsed = automationInputSchema.safeParse({
      ...input,
      trigger:
        input.trigger.kind === 'files'
          ? {
              ...input.trigger,
              paths: paths
                .split('\n')
                .map((path) => path.trim())
                .filter(Boolean),
            }
          : input.trigger,
    });
    if (!parsed.success) {
      setError(localize('이름·작업 내용·실행 간격 또는 파일 경로를 확인하세요.'));
      return;
    }
    void act(() => saveAutomation(parsed.data, snapshot.version));
  }
  return (
    <SettingsSurface embedded className="settings-form" aria-busy={busy}>
      <h3>{localize('예약 실행')}</h3>
      <p>
        {localize(
          '앱이 실행 중일 때 선택한 대화의 모델·권한으로 작업합니다. 진행 중인 작업이 있으면 기다리며, 앱이 꺼져 있던 동안의 예약은 다시 실행하지 않습니다. OpenRouter에는 사용 요금이 발생합니다.',
        )}
      </p>
      <p>
        {localize(
          '파일 변경 감시는 프로젝트의 일반 UTF-8 파일(파일당 1 MiB 이하)을 대상으로 합니다. 작업 중에 바뀐 파일은 다음 실행을 자동으로 유발하지 않습니다.',
        )}
      </p>
      <div className="settings-record-list">
        {snapshot.records.map((record) => (
          <article key={record.id} className="settings-record">
            <strong>{record.name}</strong>
            <p>
              {record.enabled ? localize('켜짐') : localize('꺼짐')} ·{' '}
              {record.lastRun ? localize(statuses[record.lastRun.status]) : localize('실행 대기')}
              {record.nextAt && record.enabled
                ? localize(' · 다음: {0}', new Date(record.nextAt).toLocaleString())
                : ''}
            </p>
            {record.lastRun?.message && <p>{record.lastRun.message}</p>}
            <button className="secondary-button" disabled={busy} onClick={() => edit(record)}>
              {localize('편집')}
            </button>
            <button
              className="secondary-button"
              disabled={busy}
              onClick={() => void act(() => removeAutomation(record.id, snapshot.version))}
            >
              {localize('삭제')}
            </button>
          </article>
        ))}
      </div>
      <fieldset disabled={busy} style={{ border: 0, padding: 0 }}>
        <legend>{input.id ? localize('예약 편집') : localize('새 예약')}</legend>
        <p>
          {localize('실행 대화: ')}
          {input.sessionId === session.id ? session.title : input.sessionId}
        </p>
        <label>
          {localize('이름')}
          <input
            value={input.name}
            onChange={(event) => setInput({ ...input, name: event.target.value })}
          />
        </label>
        <label>
          {localize('작업 내용')}
          <textarea
            rows={4}
            value={input.prompt}
            onChange={(event) => setInput({ ...input, prompt: event.target.value })}
          />
        </label>
        <label>
          {localize('실행 조건')}
          <select
            value={input.trigger.kind}
            onChange={(event) =>
              setInput({
                ...input,
                trigger:
                  event.target.value === 'files'
                    ? { kind: 'files', paths: [], debounceSeconds: 30 }
                    : event.target.value === 'daily'
                      ? { kind: 'daily', hour: 9, minute: 0 }
                      : { kind: 'interval', minutes: 60 },
              })
            }
          >
            <option value="interval">{localize('일정 간격')}</option>
            <option value="daily">{localize('매일 지정 시간 (이 PC의 시간대)')}</option>
            <option value="files">{localize('파일 변경')}</option>
          </select>
        </label>
        {input.trigger.kind === 'interval' && (
          <label>
            {localize('간격 (분)')}
            <input
              type="number"
              min={1}
              max={10080}
              value={input.trigger.minutes}
              onChange={(event) =>
                setInput({
                  ...input,
                  trigger: { kind: 'interval', minutes: Number(event.target.value) },
                })
              }
            />
          </label>
        )}
        {input.trigger.kind === 'daily' && (
          <label>
            {localize('시간')}
            <input
              type="time"
              value={`${String(input.trigger.hour).padStart(2, '0')}:${String(input.trigger.minute).padStart(2, '0')}`}
              onChange={(event) => {
                const [hour, minute] = event.target.value.split(':').map(Number);
                setInput({
                  ...input,
                  trigger: { kind: 'daily', hour: hour ?? 9, minute: minute ?? 0 },
                });
              }}
            />
          </label>
        )}
        {input.trigger.kind === 'files' && (
          <>
            <label>
              {localize('프로젝트 상대 경로 (한 줄에 하나)')}
              <textarea
                value={paths}
                onChange={(event) => setPaths(event.target.value)}
                placeholder={'src/app.ts\npackage.json'}
              />
            </label>
            <label>
              {localize('변경이 멈춘 뒤 대기 (초)')}
              <input
                type="number"
                min={10}
                max={600}
                value={input.trigger.debounceSeconds}
                onChange={(event) => {
                  if (input.trigger.kind === 'files')
                    setInput({
                      ...input,
                      trigger: { ...input.trigger, debounceSeconds: Number(event.target.value) },
                    });
                }}
              />
            </label>
          </>
        )}
        <label className="checkbox-field">
          <input
            type="checkbox"
            checked={input.enabled}
            onChange={(event) => setInput({ ...input, enabled: event.target.checked })}
          />
          {localize('예약 실행 켜기')}
        </label>
        <div className="settings-actions">
          <button className="secondary-button" onClick={save}>
            {localize('예약 저장')}
          </button>
          {input.id && (
            <button className="secondary-button" onClick={reset}>
              {localize('새 예약')}
            </button>
          )}
        </div>
      </fieldset>
      {error && <p role="alert">{error}</p>}
    </SettingsSurface>
  );
}
