import { useState } from 'react';
import type { PlanProposal } from '@lodex/contracts';
import { sendCommand, snapshot } from './bridge';
import { useWorkspace } from './state';

export function PlanReview({
  proposal,
  sessionId,
  activityId,
}: {
  proposal: PlanProposal;
  sessionId: string;
  activityId: string;
}) {
  const workspace = useWorkspace();
  const session = workspace.sessions.find((s) => s.id === sessionId);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  async function adopt() {
    if (!session) return;
    setBusy(true);
    setError('');
    try {
      workspace.upsert(
        (
          await sendCommand({
            type: 'adopt_plan',
            sessionId,
            activityId,
            expectedVersion: session.version,
          })
        ).session,
      );
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
      try {
        workspace.replace(await snapshot());
      } catch {
        /* Reconnect refreshes. */
      }
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="edit-review">
      <strong>{proposal.plan.goal}</strong>
      <p>{proposal.plan.criteria}</p>
      <ol>
        {proposal.plan.tasks.map((task) => (
          <li key={task.id}>
            <strong>{task.title}</strong>
            <p>{task.criteria}</p>
            {!!task.dependsOn?.length && (
              <small>
                선행 작업:{' '}
                {task.dependsOn
                  .map((id) => proposal.plan.tasks.find((t) => t.id === id)?.title)
                  .join(', ')}
              </small>
            )}
          </li>
        ))}
      </ol>
      {error && (
        <p className="danger-text" role="alert">
          {error}
        </p>
      )}
      {proposal.status === 'proposed' ? (
        <>
          <p>
            검토한 계획으로 Goal과 할 일을 교체합니다. 반영 후 오른쪽에서 항목을 편집할 수 있습니다.
          </p>
          <button
            disabled={busy || !workspace.connected || session?.run?.status === 'running'}
            onClick={() => void adopt()}
          >
            {busy ? '반영 중…' : '계획에 반영'}
          </button>
        </>
      ) : (
        <p role="status">계획에 반영했습니다.</p>
      )}
    </div>
  );
}
