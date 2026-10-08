import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { Icon } from './icons';
import { GlassPopover } from './GlassMotion';
import type { GlassEffectsPreference } from './glass-motion-preference';

const choices = [
  { value: 'system', label: '시스템 설정 따르기', detail: '기기의 움직임 줄이기 설정을 따릅니다.' },
  { value: 'full', label: '전체 효과', detail: '부드러운 움직임과 반응하는 유리 효과를 켭니다.' },
  {
    value: 'reduced',
    label: '효과 줄이기',
    detail: '움직임과 굴절 효과를 끄고 차분하게 표시합니다.',
  },
] as const;

export function GlassEffectsSettings({
  preference,
  onChange,
  systemReducedMotion,
  allowMotion,
}: {
  preference: GlassEffectsPreference;
  onChange: (value: GlassEffectsPreference) => void;
  systemReducedMotion: boolean;
  allowMotion: boolean;
}) {
  const [open, setOpen] = useState(false);
  const control = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const items = useRef<(HTMLButtonElement | null)[]>([]);
  const menuId = useId();
  useEffect(() => {
    if (!open) return;
    items.current[choices.findIndex((choice) => choice.value === preference)]?.focus();
    const outside = (event: PointerEvent) => {
      if (!control.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);
  function keyboard(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.preventDefault();
      setOpen(false);
      trigger.current?.focus();
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const current = items.current.findIndex((item) => item === document.activeElement);
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? choices.length - 1
          : (current + (event.key === 'ArrowDown' ? 1 : -1) + choices.length) % choices.length;
    items.current[next]?.focus();
  }
  return (
    <div className="glass-effects-control" ref={control}>
      <button
        type="button"
        className="glass-effects-toggle icon-button"
        ref={trigger}
        aria-label={`유리 효과: ${allowMotion ? '전체 효과 켜짐' : '움직임 줄임'}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        title="유리 효과 설정"
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        <Icon name="settings" size={17} />
        <span className="glass-effects-label">효과</span>
      </button>
      <GlassPopover
        open={open}
        className="glass-effects-menu"
        origin="top right"
        onKeyDown={keyboard}
      >
        <strong className="glass-effects-heading">유리 효과</strong>
        <p className="glass-effects-status" role="status">
          {preference === 'system' && systemReducedMotion
            ? '시스템에서 움직임 줄이기가 켜져 있습니다. 전체 효과를 선택하면 이 앱에서만 움직임을 켭니다.'
            : allowMotion
              ? '부드러운 움직임이 켜져 있습니다.'
              : '움직임을 줄여 표시하고 있습니다.'}
        </p>
        <div id={menuId} role="menu" aria-label="유리 효과 설정">
          {choices.map((choice, index) => (
            <button
              key={choice.value}
              type="button"
              role="menuitemradio"
              aria-checked={preference === choice.value}
              className={preference === choice.value ? 'selected' : ''}
              ref={(element) => {
                items.current[index] = element;
              }}
              onClick={() => onChange(choice.value)}
            >
              <span>
                <strong>{choice.label}</strong>
                {preference === choice.value && <Icon name="check" size={16} />}
              </span>
              <small>{choice.detail}</small>
            </button>
          ))}
        </div>
        <div className="glass-optics-preview" aria-hidden="true">
          <div className="glass-optics-preview-lines" />
          <div className="glass-optics-preview-lens">Liquid Glass</div>
        </div>
        <small className="glass-optics-caption">유리 효과 미리보기</small>
      </GlassPopover>
    </div>
  );
}
