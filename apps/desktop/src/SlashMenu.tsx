import { useEffect, useRef } from 'react';
import type { SlashCommand } from './slash-commands';

export function SlashMenu({
  commands,
  active,
  onSelect,
}: {
  commands: readonly SlashCommand[];
  active: number;
  onSelect: (command: SlashCommand) => void;
}) {
  const menu = useRef<HTMLDivElement>(null);
  useEffect(() => {
    menu.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [active]);
  return (
    <div
      ref={menu}
      className="slash-menu"
      id="composer-slash-menu"
      role="listbox"
      aria-label="슬래시 명령"
    >
      <div className="slash-menu-hint">↑ ↓ 이동 · Tab 선택 · Esc 닫기</div>
      {commands.map((command, index) => (
        <button
          type="button"
          role="option"
          aria-selected={index === active}
          id={`slash-command-${command.id}`}
          tabIndex={-1}
          className={`slash-option${index === active ? ' active' : ''}`}
          key={command.id}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onSelect(command)}
        >
          <code>/{command.id}</code>
          <span>
            <strong>{command.label}</strong>
            <small>{command.description}</small>
          </span>
        </button>
      ))}
    </div>
  );
}
