import { useEffect, useRef, useState } from 'react';
import type { McpResourceSubscription, Session } from '@lodex/contracts';
import type { McpRegistration } from '@lodex/mcp';
import { changeMcpResourceSubscription, mcpResourceSubscriptions } from './bridge';
import { t as localize } from './i18n';

export function McpResourceUpdates({
  session,
  servers,
  disabled,
}: {
  session: Session;
  servers: McpRegistration[];
  disabled: boolean;
}) {
  const [subscriptions, setSubscriptions] = useState<McpResourceSubscription[]>([]);
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const attachments = session.mcpAttachments?.filter((item) => item.kind !== 'prompt') ?? [];
  const ids = attachments.map((item) => item.id).join(',');
  useEffect(() => {
    generation.current += 1;
    let active = true,
      timer: ReturnType<typeof setTimeout> | undefined;
    setSubscriptions([]);
    setError('');
    setBusy(false);
    if (disabled || !ids)
      return () => {
        generation.current += 1;
      };
    const load = async () => {
      try {
        const value = await mcpResourceSubscriptions(session.id);
        if (active) setSubscriptions(value);
      } catch (cause) {
        if (active) setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (active) timer = setTimeout(() => void load(), 3000);
      }
    };
    void load();
    return () => {
      active = false;
      generation.current += 1;
      clearTimeout(timer);
    };
  }, [session.id, ids, disabled]);
  if (!attachments.length) return null;
  return (
    <div className="mcp-resource-updates">
      <h4>{localize('리소스 변경 알림')}</h4>
      <p className="field-hint">
        {localize(
          '알림만 받습니다. 새 내용은 아래 자료 목록에서 미리 보고, 기존 첨부를 제거한 뒤 다시 첨부하세요. 앱을 재시작하면 알림 연결이 꺼집니다.',
        )}
      </p>
      {attachments.map((attachment) => {
        const registration = servers.find((item) => item.id === attachment.serverId);
        const current = subscriptions.find((item) => item.attachmentId === attachment.id);
        const supported =
          registration?.supportsResourceSubscriptions &&
          registration.revision === attachment.serverRevision;
        const enabled = current && ['watching', 'changed'].includes(current.status);
        return (
          <div className="skill-card" key={attachment.id}>
            <p className="skill-source">{attachment.resolvedUri ?? attachment.entryKey}</p>
            <p role="status">
              {current?.status === 'changed'
                ? localize('서버에서 내용이 변경되었습니다. 첨부된 내용은 그대로 유지됩니다.')
                : current?.status === 'disconnected'
                  ? localize('변경 알림 연결이 끊겼습니다. 다시 연결할 수 있습니다.')
                  : current?.status === 'watching'
                    ? localize('서버의 변경 알림을 받고 있습니다.')
                    : !supported
                      ? localize(
                          '현재 등록 정보에 변경 알림 지원이 없습니다. 서버 연결 검사로 다시 확인할 수 있습니다.',
                        )
                      : localize('변경 알림 꺼짐')}
            </p>
            {current?.changedAt && <small>{new Date(current.changedAt).toLocaleString()}</small>}
            <button
              type="button"
              className="secondary-button"
              disabled={disabled || busy || (!supported && !current)}
              onClick={() => {
                const started = generation.current;
                setBusy(true);
                setError('');
                void changeMcpResourceSubscription({
                  sessionId: session.id,
                  attachmentId: attachment.id,
                  expectedVersion: session.version,
                  action: enabled || !supported ? 'unsubscribe' : 'subscribe',
                })
                  .then((value) => {
                    if (started === generation.current) setSubscriptions(value);
                  })
                  .catch((cause) => {
                    if (started === generation.current)
                      setError(cause instanceof Error ? cause.message : String(cause));
                  })
                  .finally(() => {
                    if (started === generation.current) setBusy(false);
                  });
              }}
            >
              {enabled || (!supported && current)
                ? localize('알림 연결 끄기')
                : current?.status === 'disconnected'
                  ? localize('알림 다시 연결')
                  : localize('변경 알림 받기')}
            </button>
          </div>
        );
      })}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
