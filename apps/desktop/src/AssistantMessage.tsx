import { useEffect, useState } from 'react';
import type { Activity, Message } from '@lodex/contracts';
import { ActivityCards, needsAttention } from './ActivityCards';
import { Markdown } from './Markdown';
import { Icon } from './icons';

export function workDuration(start: string, end: string | number) {
  const elapsed = Math.max(
    0,
    Math.floor(((typeof end === 'number' ? end : Date.parse(end)) - Date.parse(start)) / 1000),
  );
  if (!Number.isFinite(elapsed)) return '';
  const hours = Math.floor(elapsed / 3600),
    minutes = Math.floor(elapsed / 60) % 60,
    seconds = elapsed % 60;
  return [hours ? `${hours}시간` : '', minutes ? `${minutes}분` : '', !hours ? `${seconds}초` : '']
    .filter(Boolean)
    .join(' ');
}

/** Offsets refer to the unchanged text, so tool summaries can sit between streamed paragraphs. */
export function transcriptParts(content: string, activities: Activity[]) {
  const parts: ({ text: string; key: string } | { activities: Activity[]; key: string })[] = [];
  let offset = 0;
  for (const activity of activities) {
    const next = Math.max(offset, Math.min(content.length, activity.contentOffset ?? 0));
    if (next > offset) parts.push({ key: `text-${offset}`, text: content.slice(offset, next) });
    const last = parts.at(-1);
    if (next === offset && last && 'activities' in last) last.activities.push(activity);
    else parts.push({ key: activity.id, activities: [activity] });
    offset = next;
  }
  if (offset < content.length) parts.push({ key: `text-${offset}`, text: content.slice(offset) });
  return parts;
}

export function AssistantMessage({
  message,
  sessionId,
  showActivities,
}: {
  message: Message;
  sessionId: string;
  showActivities: boolean;
}) {
  const live = message.status === 'streaming';
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [live]);
  const activities = message.activities ?? [];
  const hasWork = activities.length > 0;
  const finalOffset =
    !live && message.status === 'complete'
      ? (message.finalResponseOffset ?? 0)
      : message.content.length;
  const history = message.content.slice(0, finalOffset);
  const final = message.content.slice(finalOffset);
  const attention = activities.filter(needsAttention).length;
  const duration =
    live || message.workFinishedAt
      ? workDuration(message.createdAt, message.workFinishedAt ?? now)
      : '';
  const body = (value: string) => (
    <div className="message-body">
      <Markdown text={value} />
    </div>
  );
  const transcript = transcriptParts(history, activities).map((part) =>
    'text' in part ? (
      <div className="work-commentary" key={part.key}>
        {body(part.text)}
      </div>
    ) : (
      <ActivityCards key={part.key} activities={part.activities} sessionId={sessionId} inline />
    ),
  );
  if (!showActivities || !hasWork)
    return (
      <>
        {body(message.content)}
        {live && !message.content && (
          <span className="thinking">
            <i />
            <i />
            <i />
          </span>
        )}
      </>
    );
  return (
    <div className="assistant-transcript">
      {live ? (
        <>
          <div className="work-transcript">{transcript}</div>
          <div className="work-live-status" role="status">
            <span className="activity-dot running" />
            {duration}째 작업 중
          </div>
        </>
      ) : (
        <>
          <details className="work-history" key={message.status}>
            <summary>
              <Icon name="chevron" size={14} />
              <span>{duration ? `${duration} 동안 작업` : '작업 기록'}</span>
              <span className="work-count">
                도구 {activities.filter((a) => a.kind === 'tool').length}개
              </span>
              {attention > 0 && <span className="activity-attention">확인 필요 {attention}</span>}
              {message.status !== 'complete' && <span>중단된 작업</span>}
            </summary>
            <div className="work-transcript">{transcript}</div>
          </details>
          {final && body(final)}
        </>
      )}
    </div>
  );
}
