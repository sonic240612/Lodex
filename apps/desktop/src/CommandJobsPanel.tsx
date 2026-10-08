import { t as localize } from './i18n';
import { useEffect, useState } from 'react';
import type { CommandJob } from '@lodex/contracts';
import { nativeDesktop, commandJobs, commandJobAction } from './bridge';
import { CommandTerminal } from './CommandTerminal';

export function CommandJobsPanel({
  sessionId,
  connected,
  readOnly,
}: {
  sessionId: string;
  connected: boolean;
  readOnly: boolean;
}) {
  const [jobs, setJobs] = useState<CommandJob[]>([]),
    [error, setError] = useState('');
  useEffect(() => {
    let active = true,
      pending = false;
    setJobs([]);
    setError('');
    const refresh = async () => {
      if (!nativeDesktop || !connected || pending) return;
      pending = true;
      try {
        const next = await commandJobs(sessionId);
        if (active) {
          setJobs(next);
          setError('');
        }
      } catch (e) {
        if (active) setError(e instanceof Error ? e.message : String(e));
      } finally {
        pending = false;
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 500);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [sessionId, connected]);
  const visible = jobs
    .filter((job) => job.background || job.inputOpen || job.execution?.cleanupPending)
    .slice(-16);
  if (!visible.length && !error) return null;
  return (
    <section className="command-jobs-panel" aria-label={localize('실행 작업')}>
      <strong>
        {localize('실행 작업 · ')}
        {visible.length}
      </strong>
      {error && <p role="alert">{error}</p>}
      {visible.map((job) => (
        <CommandJobRow
          key={job.id}
          job={job}
          readOnly={readOnly}
          onUpdate={(value) =>
            setJobs((current) => current.map((item) => (item.id === value.id ? value : item)))
          }
        />
      ))}
    </section>
  );
}
export function CommandJobRow({
  job,
  readOnly,
  onUpdate,
}: {
  job: CommandJob;
  readOnly: boolean;
  onUpdate: (job: CommandJob) => void;
}) {
  const [input, setInput] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const running = !job.execution || ['starting', 'running'].includes(job.execution.status);
  async function action(type: 'input' | 'stop', eof = false) {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      onUpdate(
        await commandJobAction(type, {
          sessionId: job.sessionId,
          jobId: job.id,
          input: type === 'input' ? input : '',
          eof,
        }),
      );
      if (type === 'input') setInput('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="command-job-row">
      <div className="command-job-heading">
        <code>{job.execution?.command ?? job.id}</code>
        <span>
          {job.execution?.status ?? localize('시작 중')}
          {job.execution?.exitCode !== null && job.execution?.exitCode !== undefined
            ? localize(' · 종료 {0}', job.execution.exitCode)
            : ''}
        </span>
        <button type="button" disabled={busy || !running} onClick={() => void action('stop')}>
          {localize('중지')}
        </button>
      </div>
      <details>
        <summary>
          {job.background ? localize('백그라운드') : localize('실행 중')} ·{' '}
          {job.terminal ? localize('터미널 보기') : localize('출력 보기')}
        </summary>
        {job.terminal ? (
          <CommandTerminal job={job} readOnly={readOnly} onUpdate={onUpdate} />
        ) : (
          <pre>{job.execution?.output || localize('출력 대기 중')}</pre>
        )}
        {job.execution?.truncated && <p>{localize('출력 일부가 생략되었습니다.')}</p>}
        <small>{job.id}</small>
      </details>
      {job.inputOpen && (
        <form
          className="command-input-form"
          onSubmit={(event) => {
            event.preventDefault();
            void action('input');
          }}
        >
          <textarea
            aria-label={localize('명령 입력 {0}', job.id)}
            value={input}
            onChange={(event) => setInput(event.target.value)}
            placeholder={
              job.terminal
                ? localize('터미널을 클릭해 직접 입력하거나, 전달할 내용을 여기에 입력하세요.')
                : localize('실행 중인 프로그램에 보낼 내용 · 줄바꿈을 포함하세요')
            }
            disabled={busy || readOnly}
            maxLength={8000}
            rows={2}
          />
          <button type="submit" disabled={busy || readOnly || !input}>
            {localize('입력 전달')}
          </button>
          <button
            type="button"
            disabled={busy || readOnly}
            onClick={() => void action('input', true)}
          >
            {job.terminal ? localize('EOF 전달') : localize('입력 종료(EOF)')}
          </button>
        </form>
      )}
      {(error || job.error || job.execution?.error) && (
        <p role="alert">{error || job.error || job.execution?.error}</p>
      )}
    </div>
  );
}
