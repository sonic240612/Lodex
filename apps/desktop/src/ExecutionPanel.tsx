import { useState } from 'react';
import { defaultExecutionConfig, type ExecutionConfig, type Session } from '@lodex/contracts';
import { checkExecution, cleanupCommands, nativeDesktop, sendCommand } from './bridge';
import { useWorkspace } from './state';

export function ExecutionPanel({ session }: { session: Session }) {
  const workspace = useWorkspace();
  const [draft, setDraft] = useState<ExecutionConfig>(
    session.execution ?? defaultExecutionConfig(),
  );
  const [busy, setBusy] = useState(false),
    [note, setNote] = useState('');
  const pending = session.messages.some((m) =>
    m.activities?.some((a) => a.execution?.cleanupPending),
  );
  async function operation(work: () => Promise<void>) {
    setBusy(true);
    setNote('');
    try {
      await work();
    } catch (error) {
      setNote(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <details className="execution-panel">
      <summary>
        명령 실행 · {session.execution?.backend === 'docker' ? 'Docker' : '꺼짐'}
        {pending ? ' · 정리 필요' : ''}
      </summary>
      <p>
        Build 모드에서 모델이 명령을 실행하고 결과를 읽습니다. Docker의 Linux 이미지와 /bin/sh가
        필요합니다.
      </p>
      <fieldset
        disabled={
          busy || !nativeDesktop || !workspace.connected || session.run?.status === 'running'
        }
      >
        <label>
          개발 이미지
          <input
            aria-label="Docker 이미지"
            value={draft.image}
            maxLength={256}
            onChange={(event) => setDraft({ ...draft, image: event.target.value })}
          />
        </label>
        <button
          onClick={() =>
            void operation(async () => {
              const result = await checkExecution(draft.image);
              setDraft({ ...draft, image: result.imageId });
              setNote('로컬 엔진과 이미지를 확인했습니다. 이미지 ID로 고정했습니다.');
            })
          }
        >
          엔진·이미지 확인
        </button>
        <div className="execution-limits">
          <label>
            CPU
            <input
              type="number"
              min={0.5}
              max={16}
              step={0.5}
              value={draft.cpus}
              onChange={(e) => setDraft({ ...draft, cpus: Number(e.target.value) })}
            />
          </label>
          <label>
            메모리 MB
            <input
              type="number"
              min={256}
              max={32768}
              step={256}
              value={draft.memoryMb}
              onChange={(e) => setDraft({ ...draft, memoryMb: Number(e.target.value) })}
            />
          </label>
        </div>
        <label className="check-field">
          <input
            type="checkbox"
            checked={draft.network === 'bridge'}
            onChange={(e) => setDraft({ ...draft, network: e.target.checked ? 'bridge' : 'none' })}
          />
          컨테이너 외부 네트워크 허용
        </label>
        <label className="check-field">
          <input
            type="checkbox"
            checked={draft.projectAccess}
            onChange={(e) => setDraft({ ...draft, projectAccess: e.target.checked })}
          />
          이 대화의 명령에 프로젝트 폴더 전체 읽기·쓰기 허용
        </label>
        <p>
          명령은 폴더 안의 .env 등 비공개 파일도 읽거나 수정할 수 있습니다. 명령으로 변경한 파일에는
          수정안 되돌리기가 적용되지 않습니다. OpenRouter 사용 시 명령 출력도 전송됩니다. Lodex의
          API 키 환경 변수와 홈 폴더는 컨테이너에 전달하지 않습니다.
        </p>
        <div className="edit-actions">
          <button
            disabled={!draft.projectAccess}
            onClick={() =>
              void operation(async () => {
                const runtime = await checkExecution(draft.image);
                const execution: ExecutionConfig = {
                  ...draft,
                  image: runtime.imageId,
                  backend: 'docker',
                };
                workspace.upsert(
                  (
                    await sendCommand({
                      type: 'configure_execution',
                      sessionId: session.id,
                      expectedVersion: session.version,
                      execution,
                    })
                  ).session,
                );
                setDraft(execution);
                setNote('이 대화의 Build 모드에서 명령 실행을 허용했습니다.');
              })
            }
          >
            설정 적용·실행 허용
          </button>
          <button
            onClick={() =>
              void operation(async () => {
                workspace.upsert(
                  (
                    await sendCommand({
                      type: 'configure_execution',
                      sessionId: session.id,
                      expectedVersion: session.version,
                      execution: { ...draft, backend: 'disabled' },
                    })
                  ).session,
                );
                setNote('명령 실행을 껐습니다.');
              })
            }
          >
            끄기
          </button>
        </div>
        {pending && (
          <button
            onClick={() =>
              void operation(async () => {
                workspace.upsert(await cleanupCommands(session.id));
                setNote('컨테이너 정리 결과를 갱신했습니다.');
              })
            }
          >
            남은 컨테이너 정리
          </button>
        )}
      </fieldset>
      {note && <p role="status">{note}</p>}
    </details>
  );
}
