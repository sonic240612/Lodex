import { activityProposal, type Activity } from '@lodex/contracts';
import { EditReview, editStatusText } from './EditReview';
import { PlanReview } from './PlanReview';
import { Icon } from './icons';
const statusText = {
  running: '진행 중',
  completed: '완료',
  failed: '실패',
  cancelled: '중지됨',
  interrupted: '중단됨',
};
const toolTitles: Record<string, string> = {
  read_file: '파일 읽기',
  list_files: '파일 목록',
  search_files: '파일 검색',
  search_text: '코드 검색',
  propose_edit: '파일 수정',
  propose_changes: '파일 변경',
  host_write_file: '파일 쓰기',
  run_command: '명령 실행',
  run_host_command: '호스트 명령 실행',
  web_search: '웹 검색',
  web_fetch: '웹 페이지 읽기',
  read_skill: '스킬 읽기',
  search_history: '대화 기록 검색',
  read_tool_result: '저장된 결과 읽기',
  recall_observation: '원문 조회',
  delegate_tasks: '서브에이전트 작업',
  set_task_list: '작업 계획 작성',
  update_task: '작업 상태 갱신',
};
export function activityTitle(activity: Activity) {
  if (activity.kind === 'thinking') return activity.status === 'running' ? '생각 중' : '생각 과정';
  if (activity.mcpCall) return `MCP · ${activity.mcpCall.toolName}`;
  return toolTitles[activity.label] ?? activity.label;
}
function activityTarget(activity: Activity): string {
  if (activity.execution) return activity.execution.command;
  const proposal = activityProposal(activity);
  if (proposal)
    return 'files' in proposal ? proposal.files.map((file) => file.path).join(', ') : proposal.path;
  try {
    const input = JSON.parse(activity.arguments ?? '{}');
    const value = input.path ?? input.command ?? input.query ?? input.url;
    return typeof value === 'string' ? value.replace(/\s+/g, ' ').slice(0, 160) : '';
  } catch {
    return '';
  }
}
function needsAttention(activity: Activity) {
  return (
    activity.approval?.status === 'pending' ||
    activity.elicitation?.status === 'pending' ||
    activity.mcpCall?.status === 'unknown' ||
    activity.execution?.cleanupPending ||
    activity.status === 'failed' ||
    activity.planProposal?.status === 'proposed' ||
    ['proposed', 'partial', 'conflict'].includes(activityProposal(activity)?.status ?? '')
  );
}
function activityStatus(activity: Activity) {
  if (activity.approval?.status === 'pending') return '승인 대기';
  if (activity.elicitation?.status === 'pending') return '입력 대기';
  if (activity.mcpCall?.status === 'unknown') return '실행 결과 미확인';
  if (activity.execution?.cleanupPending) return '실행 환경 정리 필요';
  if (activity.execution)
    return activity.execution.status === 'completed'
      ? '종료 코드 0'
      : ['running', 'starting'].includes(activity.execution.status)
        ? '명령 실행 중'
        : '명령 중단·실패';
  const proposal = activityProposal(activity);
  return proposal ? editStatusText[proposal.status] : statusText[activity.status];
}
export function ActivityCards({
  activities,
  sessionId,
}: {
  activities: Activity[];
  sessionId?: string;
}) {
  if (!activities.length) return null;
  const current = activities.findLast((activity) => activity.status === 'running');
  const attention = activities.filter(needsAttention).length;
  const tools = activities.filter((activity) => activity.kind === 'tool').length;
  const thoughts = activities.length - tools;
  return (
    <details className="activity-feed" aria-label="생각과 도구 활동">
      <summary className="activity-feed-summary">
        <span
          className={'activity-feed-indicator' + (current ? ' running' : '')}
          aria-hidden="true"
        >
          <Icon name={current ? 'bolt' : attention ? 'info' : 'check'} size={16} />
        </span>
        <span className="activity-feed-heading">
          {current ? activityTitle(current) : `활동 ${activities.length}개`}
          {current && activityTarget(current) && (
            <span className="activity-target">{activityTarget(current)}</span>
          )}
        </span>
        {attention > 0 && <span className="activity-attention">확인 필요 {attention}</span>}
        <span className="activity-count">
          {[tools ? `도구 ${tools}` : '', thoughts ? `생각 ${thoughts}` : '']
            .filter(Boolean)
            .join(' · ')}
        </span>
        <span className="activity-chevron">
          <Icon name="chevron" size={14} />
        </span>
      </summary>
      <div className="activity-cards">
        {activities.map((activity) => (
          <details
            className={
              'activity-card activity-' +
              activity.kind +
              (needsAttention(activity) ? ' needs-attention' : '')
            }
            key={activity.id}
          >
            <summary>
              <span className={'activity-dot ' + activity.status} aria-hidden="true" />
              <span className="activity-description">
                <span>{activityTitle(activity)}</span>
                {activityTarget(activity) && (
                  <code className="activity-target">{activityTarget(activity)}</code>
                )}
                {activity.fusion && <span className="activity-fusion-label">수정 후 검증</span>}
              </span>
              <small>{activityStatus(activity)}</small>
              <span className="activity-chevron">
                <Icon name="chevron" size={14} />
              </span>
            </summary>
            {activity.fusion && (
              <div className="activity-section">
                <span>
                  Action Fusion · 파일 변경·후속 명령 묶음
                  {activity.fusion.environment
                    ? ` · ${activity.fusion.environment === 'host' ? '호스트' : 'Docker'}`
                    : ''}
                </span>
                <p>
                  {activity.fusion.status === 'succeeded'
                    ? '변경 적용 후 명령이 종료 코드 0으로 완료됐습니다.'
                    : activity.fusion.status === 'failed'
                      ? '변경은 유지되며 후속 명령은 실패하거나 중단됐습니다.'
                      : activity.fusion.status === 'skipped'
                        ? '후속 명령을 실행하지 않았습니다. 권한·변경 상태·충돌 결과를 확인하세요.'
                        : '변경과 후속 명령을 함께 처리합니다.'}
                </p>
              </div>
            )}
            {activity.observation && (
              <div className="activity-section">
                <span>
                  ObservationPack · 원문 로컬 보관 · {activity.observation.bytes.toLocaleString()}{' '}
                  bytes
                </span>
                <code>{activity.observation.id}</code>
              </div>
            )}
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
                      {child.mode === 'build' && (
                        <p>
                          Worktree에서 파일 수정·명령 실행
                          {child.worktreeId && <code> · {child.worktreeId}</code>}
                          <br />
                          설정 → Worktree에서 변경을 검토하고 원본에 적용할 수 있습니다.
                        </p>
                      )}
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
                    <span>입력 · {activity.label}</span>
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
    </details>
  );
}
