import { activityProposal, type Activity } from '@lodex/contracts';
import { EditReview, editStatusText } from './EditReview';
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
            <span>{activity.label}</span>
            <small>
              {activityProposal(activity)
                ? editStatusText[activityProposal(activity)!.status]
                : statusText[activity.status]}
            </small>
          </summary>
          {activityProposal(activity) && sessionId ? (
            <EditReview
              edit={activityProposal(activity)!}
              activityId={activity.id}
              sessionId={sessionId}
            />
          ) : (
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
