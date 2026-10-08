import { t as localize } from './i18n';
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
  if (activity.label === 'Eco 증분 LLM 압축') return localize('Eco 자동 요약');
  if (activity.kind === 'thinking')
    return activity.status === 'running' ? localize('생각 중') : localize('생각 과정');
  if (activity.mcpCall) return `MCP · ${activity.mcpCall.toolName}`;
  return toolTitles[activity.label] ? localize(toolTitles[activity.label]!) : activity.label;
}
function activityTarget(activity: Activity): string {
  if (['Eco 자동 요약', 'Eco 증분 LLM 압축', '컨텍스트 자동 LLM 압축'].includes(activity.label)) {
    try {
      const result = JSON.parse(activity.text);
      if (
        typeof result.originalInputTokens === 'number' &&
        typeof result.compactedInputTokens === 'number'
      )
        return localize(
          '{0} → {1} 토큰',
          result.originalInputTokens.toLocaleString(),
          result.compactedInputTokens.toLocaleString(),
        );
    } catch {
      /* The summary is still streaming, or no checkpoint was applied. */
    }
  }
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
export function needsAttention(activity: Activity) {
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
  if (activity.approval?.status === 'pending') return localize('승인 대기');
  if (activity.elicitation?.status === 'pending') return localize('입력 대기');
  if (activity.mcpCall?.status === 'unknown') return localize('실행 결과 미확인');
  if (activity.execution?.cleanupPending) return localize('실행 환경 정리 필요');
  if (activity.execution)
    return activity.execution.status === 'completed'
      ? localize('종료 코드 0')
      : ['running', 'starting'].includes(activity.execution.status)
        ? localize('명령 실행 중')
        : localize('명령 중단·실패');
  const proposal = activityProposal(activity);
  return localize(proposal ? editStatusText[proposal.status] : statusText[activity.status]);
}
export function ActivityCards({
  activities,
  sessionId,
  inline = false,
}: {
  activities: Activity[];
  sessionId?: string;
  inline?: boolean;
}) {
  if (!activities.length) return null;
  const current = activities.findLast((activity) => activity.status === 'running');
  const attention = activities.filter(needsAttention).length;
  const tools = activities.filter((activity) => activity.kind === 'tool').length;
  const thoughts = activities.length - tools;
  const cards = (
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
              {activity.fusion && (
                <span className="activity-fusion-label">{localize('수정 후 검증')}</span>
              )}
            </span>
            <small>{activityStatus(activity)}</small>
            <span className="activity-chevron">
              <Icon name="chevron" size={14} />
            </span>
          </summary>
          {activity.fusion && (
            <div className="activity-section">
              <span>
                {localize('Action Fusion · 파일 변경·후속 명령 묶음')}
                {activity.fusion.environment
                  ? ` · ${activity.fusion.environment === 'host' ? localize('호스트') : 'Docker'}`
                  : ''}
              </span>
              <p>
                {activity.fusion.status === 'succeeded'
                  ? localize('변경 적용 후 명령이 종료 코드 0으로 완료됐습니다.')
                  : activity.fusion.status === 'failed'
                    ? localize('변경은 유지되며 후속 명령은 실패하거나 중단됐습니다.')
                    : activity.fusion.status === 'skipped'
                      ? localize(
                          '후속 명령을 실행하지 않았습니다. 권한·변경 상태·충돌 결과를 확인하세요.',
                        )
                      : localize('변경과 후속 명령을 함께 처리합니다.')}
              </p>
            </div>
          )}
          {activity.observation && (
            <div className="activity-section">
              <span>
                {localize('ObservationPack · 원문 로컬 보관 · ')}
                {activity.observation.bytes.toLocaleString()} bytes
              </span>
              <code>{activity.observation.id}</code>
            </div>
          )}
          {activity.subagents && (
            <div className="subagent-records" aria-label={localize('서브에이전트 작업')}>
              {activity.subagents.map((child) => (
                <details className="activity-card" key={child.id}>
                  <summary>
                    <span className={'activity-dot ' + child.status} />
                    <span>{child.task}</span>
                    <small>
                      {child.status === 'queued'
                        ? localize('대기 중')
                        : localize(statusText[child.status])}
                    </small>
                  </summary>
                  <div className="activity-section">
                    <span>
                      {child.provider} · {child.model}
                      {localize(' · 모델 ')}
                      {child.modelCalls}
                      {localize('회 · 도구')} {child.toolCalls}
                      {localize('회')}
                      {typeof child.usage?.inputTokens === 'number'
                        ? localize(' · 입력 {0} 토큰', child.usage.inputTokens.toLocaleString())
                        : ''}
                      {typeof child.usage?.outputTokens === 'number'
                        ? localize(' · 출력 {0} 토큰', child.usage.outputTokens.toLocaleString())
                        : ''}
                      {typeof child.usage?.costUsd === 'number'
                        ? ` · $${child.usage.costUsd.toFixed(6)}`
                        : ''}
                    </span>
                    {child.mode === 'build' && (
                      <p>
                        {localize('Worktree에서 파일 수정·명령 실행')}
                        {child.worktreeId && <code> · {child.worktreeId}</code>}
                        <br />
                        {localize('설정 → Worktree에서 변경을 검토하고 원본에 적용할 수 있습니다.')}
                      </p>
                    )}
                    <pre>{child.text || localize('결과 대기 중…')}</pre>
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
                {localize('권한 ·')}{' '}
                {activity.approval.mode === 'ask'
                  ? localize('승인 요청')
                  : activity.approval.mode === 'auto'
                    ? localize('대신 승인')
                    : localize('전체 접근')}
              </span>
              <small>
                {activity.approval.status === 'pending'
                  ? localize('사용자 결정 대기 중')
                  : activity.approval.status === 'approved'
                    ? activity.approval.decidedBy === 'user'
                      ? localize('사용자 승인')
                      : localize('정책 자동 승인')
                    : localize('사용자 거절')}{' '}
                · {activity.approval.risk === 'high' ? localize('높은 위험') : localize('일반')}
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
                {localize('MCP 사용자 입력 · ')}
                {activity.elicitation.mode === 'url' ? localize('외부 링크') : localize('폼')}
              </span>
              <small>
                {activity.elicitation.status === 'pending'
                  ? localize('사용자 입력 대기 중')
                  : activity.elicitation.status === 'accepted'
                    ? localize('제출됨 · 입력값은 저장하지 않음')
                    : activity.elicitation.status === 'declined'
                      ? localize('거절됨')
                      : localize('취소됨')}
              </small>
              <p>{activity.elicitation.message}</p>
            </div>
          )}
          {activity.execution && (
            <div className="activity-section">
              <span>
                {localize('명령 · ')}
                {activity.execution.cwd}
              </span>
              <pre>{activity.execution.command}</pre>
              <span>
                {localize('출력 · 종료 코드 ')}
                {activity.execution.exitCode ?? localize('미확인')}
              </span>
              <pre>{activity.execution.output || localize('출력 없음')}</pre>
              {activity.execution.truncated && <p>{localize('출력 일부가 생략되었습니다.')}</p>}
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
                  <span>
                    {localize('입력 · ')}
                    {activity.label}
                  </span>
                  <pre>{activity.arguments || localize('인자 수신 중…')}</pre>
                </div>
              )}
              <div className="activity-section">
                {activity.kind === 'tool' && <span>{localize('결과')}</span>}
                {activity.browserImage && (
                  <img
                    className="browser-result-image"
                    src={`data:image/png;base64,${activity.browserImage.base64}`}
                    alt={localize('브라우저 화면: {0}', activity.browserImage.url)}
                    loading="lazy"
                    style={{ maxWidth: '100%', borderRadius: 10 }}
                  />
                )}
                <pre>
                  {activity.text ||
                    (activity.status === 'running'
                      ? localize('수신 중…')
                      : activity.kind === 'thinking'
                        ? localize('제공자가 읽을 수 있는 thinking 내용을 반환하지 않았습니다.')
                        : localize('결과가 없습니다.'))}
                </pre>
              </div>
            </>
          )}
        </details>
      ))}
    </div>
  );
  if (inline) return cards;
  return (
    <details className="activity-feed" aria-label={localize('생각과 도구 활동')}>
      <summary className="activity-feed-summary">
        <span
          className={'activity-feed-indicator' + (current ? ' running' : '')}
          aria-hidden="true"
        >
          <Icon name={current ? 'bolt' : attention ? 'info' : 'check'} size={16} />
        </span>
        <span className="activity-feed-heading">
          {current ? activityTitle(current) : localize('활동 {0}개', activities.length)}
          {current && activityTarget(current) && (
            <span className="activity-target">{activityTarget(current)}</span>
          )}
        </span>
        {attention > 0 && (
          <span className="activity-attention">
            {localize('확인 필요 ')}
            {attention}
          </span>
        )}
        <span className="activity-count">
          {[
            tools ? localize('도구 {0}', tools) : '',
            thoughts ? localize('생각 {0}', thoughts) : '',
          ]
            .filter(Boolean)
            .join(' · ')}
        </span>
        <span className="activity-chevron">
          <Icon name="chevron" size={14} />
        </span>
      </summary>
      {cards}
    </details>
  );
}
