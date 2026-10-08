import { useEffect, useId, useRef, useState, type ReactNode, type KeyboardEvent } from 'react';
import { Icon } from './icons';
import { SettingsBusyContext } from './SettingsSurface';
import { GlassDialog } from './GlassMotion';

export const settingsSections = [
  { id: 'connection', label: '모델 연결·생성', icon: 'cloud' },
  { id: 'local', label: '로컬 모델 관리', icon: 'chip' },
  { id: 'routing', label: '역할별 모델', icon: 'bolt' },
  { id: 'skills', label: '스킬', icon: 'bolt' },
  { id: 'mcp', label: 'MCP', icon: 'bolt' },
  { id: 'telegram', label: 'Telegram', icon: 'chat' },
  { id: 'worktree', label: 'Worktree', icon: 'folder' },
  { id: 'data', label: '데이터와 백업', icon: 'settings' },
] as const;
export type SettingsSectionId = (typeof settingsSections)[number]['id'];

export function SettingsScreen({
  selected,
  onSelect,
  onClose,
  children,
}: {
  selected: SettingsSectionId;
  onSelect: (value: SettingsSectionId) => void;
  onClose: () => void;
  children: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  const prefix = useId();
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  function navigate(event: KeyboardEvent, index: number) {
    if (
      busy ||
      !['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)
    )
      return;
    event.preventDefault();
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? settingsSections.length - 1
          : (index +
              (['ArrowDown', 'ArrowRight'].includes(event.key) ? 1 : -1) +
              settingsSections.length) %
            settingsSections.length;
    onSelect(settingsSections[next]!.id);
    tabs.current[next]?.focus();
  }
  return (
    <GlassDialog
      className="settings-screen"
      ref={dialog}
      aria-labelledby={`${prefix}-title`}
      onCancel={(event) => {
        if (busy) event.preventDefault();
        else onClose();
      }}
    >
      <header className="settings-screen-header">
        <h2 id={`${prefix}-title`}>설정</h2>
        <button
          type="button"
          className="icon-button"
          aria-label="설정 화면 닫기"
          disabled={busy}
          onClick={onClose}
        >
          <Icon name="close" />
        </button>
      </header>
      <div className="settings-screen-layout">
        <nav
          className="settings-screen-nav"
          role="tablist"
          aria-label="설정 카테고리"
          aria-orientation="vertical"
        >
          {settingsSections.map((section, index) => (
            <button
              type="button"
              role="tab"
              key={section.id}
              id={`${prefix}-${section.id}`}
              aria-controls={`${prefix}-panel`}
              aria-selected={selected === section.id}
              tabIndex={selected === section.id ? 0 : -1}
              className={`settings-nav-item${selected === section.id ? ' active' : ''}`}
              disabled={busy}
              ref={(element) => {
                tabs.current[index] = element;
              }}
              onKeyDown={(event) => navigate(event, index)}
              onClick={() => onSelect(section.id)}
            >
              <Icon name={section.icon} size={18} />
              {section.label}
            </button>
          ))}
        </nav>
        <div
          className="settings-screen-content"
          role="tabpanel"
          id={`${prefix}-panel`}
          aria-labelledby={`${prefix}-${selected}`}
        >
          <SettingsBusyContext.Provider value={setBusy}>{children}</SettingsBusyContext.Provider>
        </div>
      </div>
    </GlassDialog>
  );
}
