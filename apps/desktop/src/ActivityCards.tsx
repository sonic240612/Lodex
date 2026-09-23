import { activityProposal, type Activity } from '@lodex/contracts';
import { EditReview, editStatusText } from './EditReview';
import { PlanReview } from './PlanReview';
const statusText = {
  running: '진행 중',
  completed: '완료',
  failed: '실패',
  cancelled: '중지됨',
  interrupted: '중단됨',
};
export function ActivityCards({
  activities,
  sessionId,
}: {
  activities: Activity[];
  sessionId?: string;
}) {
  return (
    <div className="activity-cards" aria-label="Thinking과 도구 활동">
      {activities.map((activity) => (
        <details className={'activity-card activity-' + activity.kind} key={activity.id}>
          <summary>
            <span className={'activity-dot ' + activity.status} />
            <span>{activity.mcpCall ? `MCP · ${activity.mcpCall.toolName}` : activity.label}</span>
            <small>
              {activity.mcpCall?.status === 'unknown'
                ? '실행 결과 미확인'
                : activity.execution
                  ? activity.execution.cleanupPending
                    ? '컨테이너 정리 필요'
                    : activity.execution.status === 'completed'
                      ? '종료 코드 0'
                      : activity.execution.status === 'running' ||
                          activity.execution.status === 'starting'
                        ? '명령 실행 중'
                        : '명령 중단·실패'
                  : activityProposal(activity)
                    ? editStatusText[activityProposal(activity)!.status]
                    : statusText[activity.status]}
            </small>
          </summary>
          {activity.subagents && (
            <div className="subagent-records" aria-label="서브에이전트 작업">
              {activity.subagents.map((child) => (
                <details className="activity-card" key={child.id}>
                  <summary>
                    <span className={'activity-dot ' + child.status} />
                    <span>{child.task}</span>
                    <small>
                      {child.status === 'queued' ? '대기 중' : statusText[child.status]}
                    </small>
                  </summary>
                  <div className="activity-section">
                    <span>
                      {child.provider} · {child.model} · 모델 {child.modelCalls}회 · 도구{' '}
                      {child.toolCalls}회
                      {typeof child.usage?.inputTokens === 'number'
                        ? ` · 입력 ${child.usage.inputTokens.toLocaleString()} 토큰`
                        : ''}
                      {typeof child.usage?.outputTokens === 'number'
                        ? ` · 출력 ${child.usage.outputTokens.toLocaleString()} 토큰`
                        : ''}
                      {typeof child.usage?.costUsd === 'number'
                        ? ` · $${child.usage.costUsd.toFixed(6)}`
                        : ''}
                    </span>
                    <pre>{child.text || '결과 대기 중…'}</pre>
                    {child.error && <p role="alert">{child.error}</p>}
                  </div>
                </details>
              ))}
            </div>
          )}
          {activity.mcpCall && (
            <div className="activity-section">
              <span>MCP · {activity.mcpCall.toolName}</span>
              <small>
                {activity.mcpCall.startedAt} · {activity.mcpCall.status}
              </small>
              {activity.mcpCall.error && <p role="alert">{activity.mcpCall.error}</p>}
            </div>
          )}
          {activity.approval && (
            <div className="activity-section approval-record">
              <span>
                권한 ·{' '}
                {activity.approval.mode === 'ask'
                  ? '승인 요청'
                  : activity.approval.mode === 'auto'
                    ? '대신 승인'
                    : '전체 접근'}
              </span>
              <small>
                {activity.approval.status === 'pending'
                  ? '사용자 결정 대기 중'
                  : activity.approval.status === 'approved'
                    ? activity.approval.decidedBy === 'user'
                      ? '사용자 승인'
                      : '정책 자동 승인'
                    : '사용자 거절'}{' '}
                · {activity.approval.risk === 'high' ? '높은 위험' : '일반'}
                {' · '}
                {activity.approval.actor === 'telegram' ? 'Telegram' : 'Desktop'}
              </small>
              <p>{activity.approval.reason}</p>
              <pre>{activity.approval.target}</pre>
            </div>
          )}
          {activity.elicitation && (
            <div className="activity-section">
              <span>
                MCP 사용자 입력 · {activity.elicitation.mode === 'url' ? '외부 링크' : '폼'}
              </span>
              <small>
                {activity.elicitation.status === 'pending'
                  ? '사용자 입력 대기 중'
                  : activity.elicitation.status === 'accepted'
                    ? '제출됨 · 입력값은 저장하지 않음'
                    : activity.elicitation.status === 'declined'
                      ? '거절됨'
                      : '취소됨'}
              </small>
              <p>{activity.elicitation.message}</p>
            </div>
          )}
          {activity.execution && (
            <div className="activity-section">
              <span>명령 · {activity.execution.cwd}</span>
              <pre>{activity.execution.command}</pre>
              <span>출력 · 종료 코드 {activity.execution.exitCode ?? '미확인'}</span>
              <pre>{activity.execution.output || '출력 없음'}</pre>
              {activity.execution.truncated && <p>출력 일부가 생략되었습니다.</p>}
              {activity.execution.error && <p role="alert">{activity.execution.error}</p>}
            </div>
          )}
          {activity.planProposal && sessionId && (
            <PlanReview
              proposal={activity.planProposal}
              sessionId={sessionId}
              activityId={activity.id}
            />
          )}
          {activityProposal(activity) && sessionId && (
            <EditReview
              edit={activityProposal(activity)!}
              activityId={activity.id}
              sessionId={sessionId}
            />
          )}
          {!activity.execution && !activity.planProposal && !activityProposal(activity) && (
            <>
              {activity.arguments !== undefined && (
                <div className="activity-section">
                  <span>입력</span>
                  <pre>{activity.arguments || '인자 수신 중…'}</pre>
                </div>
              )}
              <div className="activity-section">
                {activity.kind === 'tool' && <span>결과</span>}
                <pre>
                  {activity.text ||
                    (activity.status === 'running'
                      ? '수신 중…'
                      : activity.kind === 'thinking'
                        ? '제공자가 읽을 수 있는 thinking 내용을 반환하지 않았습니다.'
                        : '결과가 없습니다.')}
                </pre>
              </div>
            </>
          )}
        </details>
      ))}
    </div>
  );
}
