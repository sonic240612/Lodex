import { t as localize } from './i18n';
import { useId } from 'react';
import type { Activity, AgentMode, PermissionDecision } from '@lodex/contracts';

const titles: Record<PermissionDecision['kind'], string> = {
  file: '파일 변경 권한 요청',
  command: '명령 실행 권한 요청',
  fusion: '파일 변경 및 검증 권한 요청',
  mcp: 'MCP 작업 권한 요청',
  web: '웹 조회 권한 요청',
  verification: '완료 결과 확인',
};

export function ApprovalBanner({
  activity,
  mode,
  busy,
  onDecide,
}: {
  activity: Activity;
  mode: AgentMode;
  busy: boolean;
  onDecide: (action: 'approve' | 'reject') => void;
}) {
  const titleId = useId();
  const descriptionId = useId();
  const approval = activity.approval;
  if (!approval || approval.status !== 'pending') return null;
  return (
    <div
      className="permission-banner"
      role="alertdialog"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
    >
      <div>
        <strong id={titleId}>{localize(titles[approval.kind])}</strong>
        <span id={descriptionId}>{approval.reason}</span>
        <span className="permission-target">{approval.target}</span>
      </div>
      <button disabled={busy} onClick={() => onDecide('reject')}>
        {localize('거절')}
      </button>
      <button
        className="permission-allow"
        disabled={busy || (mode === 'plan' && !['web', 'verification'].includes(approval.kind))}
        onClick={() => onDecide('approve')}
      >
        {localize('수락')}
      </button>
    </div>
  );
}
