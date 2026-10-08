import { t as localize } from './i18n';
import { useEffect, useRef, useState } from 'react';
import type { Terminal } from '@xterm/xterm';
import type { CommandJob } from '@lodex/contracts';
import { commandJobAction, resizeCommandTerminal } from './bridge';
import '@xterm/xterm/css/xterm.css';
import './command-terminal.css';

export function CommandTerminal({
  job,
  readOnly,
  onUpdate,
}: {
  job: CommandJob;
  readOnly: boolean;
  onUpdate: (job: CommandJob) => void;
}) {
  const element = useRef<HTMLDivElement>(null),
    terminal = useRef<Terminal | null>(null);
  const latest = useRef({ job, readOnly, onUpdate });
  latest.current = { job, readOnly, onUpdate };
  const previous = useRef('');
  const [error, setError] = useState('');
  useEffect(() => {
    let disposed = false,
      observer: ResizeObserver | undefined,
      resizeTimer: ReturnType<typeof setTimeout> | undefined;
    let inputTimer: ReturnType<typeof setTimeout> | undefined,
      input = '',
      queue = Promise.resolve();
    let cleanup: (() => void) | undefined;
    async function open() {
      const [{ Terminal }, { FitAddon }] = await Promise.all([
        import('@xterm/xterm'),
        import('@xterm/addon-fit'),
      ]);
      if (disposed || !element.current) return;
      const fit = new FitAddon();
      const term = new Terminal({
        cols: latest.current.job.terminal?.cols ?? 100,
        rows: latest.current.job.terminal?.rows ?? 30,
        fontFamily: 'Consolas, Menlo, monospace',
        fontSize: 14,
        lineHeight: 1.2,
        scrollback: 1500,
        cursorBlink: false,
        convertEol: false,
        disableStdin: latest.current.readOnly || !latest.current.job.inputOpen,
        theme: { background: '#101010', foreground: '#e8e8e3', cursor: '#e8e8e3' },
      });
      terminal.current = term;
      term.loadAddon(fit);
      // Terminal output cannot read or overwrite the desktop clipboard.
      const clipboard = term.parser.registerOscHandler(52, () => true);
      term.open(element.current);
      previous.current = latest.current.job.execution?.output ?? '';
      term.write(previous.current);
      const data = term.onData((value) => {
        if (latest.current.readOnly || !latest.current.job.inputOpen) return;
        input += value;
        clearTimeout(inputTimer);
        inputTimer = setTimeout(() => {
          const text = input;
          input = '';
          queue = queue
            .then(async () => {
              if (disposed || latest.current.readOnly || !latest.current.job.inputOpen) return;
              const current = latest.current;
              // Keep pasted terminal input within the same API byte limit as
              // the text form; do not split surrogate pairs between requests.
              let remaining = text;
              while (
                remaining &&
                !disposed &&
                !latest.current.readOnly &&
                latest.current.job.inputOpen
              ) {
                let end = Math.min(4000, remaining.length);
                if (end < remaining.length && /[\uD800-\uDBFF]/.test(remaining[end - 1]!)) end--;
                const next = await commandJobAction('input', {
                  sessionId: current.job.sessionId,
                  jobId: current.job.id,
                  input: remaining.slice(0, end),
                  eof: false,
                });
                remaining = remaining.slice(end);
                if (!disposed) {
                  setError('');
                  current.onUpdate(next);
                }
              }
            })
            .catch((failure) => {
              if (!disposed) setError(failure instanceof Error ? failure.message : String(failure));
            });
        }, 20);
      });
      const resize = () => {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => {
          if (disposed || !element.current?.clientWidth || !element.current?.clientHeight) return;
          const dimensions = fit.proposeDimensions();
          if (!dimensions) return;
          const cols = Math.max(20, Math.min(500, dimensions.cols)),
            rows = Math.max(5, Math.min(200, dimensions.rows));
          term.resize(cols, rows);
          const current = latest.current;
          if (
            current.readOnly ||
            !current.job.inputOpen ||
            (current.job.terminal?.cols === cols && current.job.terminal.rows === rows)
          )
            return;
          void resizeCommandTerminal({
            sessionId: current.job.sessionId,
            jobId: current.job.id,
            cols,
            rows,
          })
            .then((next) => {
              if (!disposed) current.onUpdate(next);
            })
            .catch((failure) => {
              if (!disposed) setError(failure instanceof Error ? failure.message : String(failure));
            });
        }, 120);
      };
      observer = new ResizeObserver(resize);
      observer.observe(element.current);
      resize();
      cleanup = () => {
        data.dispose();
        clipboard.dispose();
        term.dispose();
        terminal.current = null;
      };
    }
    void open().catch((failure) => {
      if (!disposed) setError(failure instanceof Error ? failure.message : String(failure));
    });
    return () => {
      disposed = true;
      observer?.disconnect();
      clearTimeout(resizeTimer);
      clearTimeout(inputTimer);
      cleanup?.();
    };
  }, [job.id]);
  useEffect(() => {
    const current = terminal.current;
    if (!current) return;
    current.options.disableStdin = readOnly || !job.inputOpen;
    const output = job.execution?.output ?? '';
    if (output.startsWith(previous.current)) current.write(output.slice(previous.current.length));
    else {
      current.reset();
      current.write(output);
    }
    previous.current = output;
  }, [job.execution?.output, job.inputOpen, readOnly]);
  return (
    <>
      <div
        className="command-terminal"
        ref={element}
        aria-label={localize('터미널 {0}', job.execution?.command ?? job.id)}
      />
      {error && <p role="alert">{error}</p>}
    </>
  );
}
