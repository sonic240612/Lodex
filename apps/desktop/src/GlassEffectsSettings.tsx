import { t as localize } from './i18n';
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
  transparency,
  onTransparencyChange,
}: {
  preference: GlassEffectsPreference;
  onChange: (value: GlassEffectsPreference) => void;
  systemReducedMotion: boolean;
  allowMotion: boolean;
  transparency: number;
  onTransparencyChange: (value: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const control = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const items = useRef<(HTMLButtonElement | null)[]>([]);
  const menuId = useId();
  const transparencyId = useId();
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
    // Keep native range-input keys (arrows, Home, End) available to the slider.
    if (!(event.target as Element).closest('[role="menu"]')) return;
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
        aria-label={localize(
          '유리 효과: {0}',
          allowMotion ? localize('전체 효과 켜짐') : localize('움직임 줄임'),
        )}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        title={localize('유리 효과 설정')}
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        <Icon name="settings" size={17} />
        <span className="glass-effects-label">{localize('효과')}</span>
      </button>
      <GlassPopover
        open={open}
        className="glass-effects-menu"
        origin="top right"
        onKeyDown={keyboard}
      >
        <strong className="glass-effects-heading">{localize('유리 효과')}</strong>
        <p className="glass-effects-status" role="status">
          {preference === 'system' && systemReducedMotion
            ? localize(
                '시스템에서 움직임 줄이기가 켜져 있습니다. 전체 효과를 선택하면 이 앱에서만 움직임을 켭니다.',
              )
            : allowMotion
              ? localize('부드러운 움직임이 켜져 있습니다.')
              : localize('움직임을 줄여 표시하고 있습니다.')}
        </p>
        <div id={menuId} role="menu" aria-label={localize('유리 효과 설정')}>
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
                <strong>{localize(choice.label)}</strong>
                {preference === choice.value && <Icon name="check" size={16} />}
              </span>
              <small>{localize(choice.detail)}</small>
            </button>
          ))}
        </div>
        <div className="glass-transparency-control">
          <label htmlFor={transparencyId}>
            <span>{localize('유리 투명도')}</span>
            <output htmlFor={transparencyId}>{transparency}%</output>
          </label>
          <input
            id={transparencyId}
            type="range"
            min="0"
            max="100"
            step="1"
            value={transparency}
            aria-valuetext={`${transparency}%`}
            aria-describedby={`${transparencyId}-hint`}
            onChange={(event) => onTransparencyChange(Number(event.target.value))}
          />
          <div className="glass-transparency-scale" aria-hidden="true">
            <span>{localize('불투명')}</span>
            <span>{localize('투명')}</span>
          </div>
          <small id={`${transparencyId}-hint`}>
            {localize('설정·모델 연결 창은 항상 불투명하게 표시합니다.')}
          </small>
        </div>
        <div className="glass-optics-preview">
          <div className="glass-optics-preview-lines" aria-hidden="true" />
          <button
            type="button"
            className="glass-optics-preview-lens"
            aria-label={localize('유리 렌즈 체험')}
          >
            {localize('눌러서 움직이기')}
          </button>
        </div>
        <small className="glass-optics-caption">
          {localize('누르거나 드래그하면 유리의 두께와 모양이 변합니다.')}
        </small>
      </GlassPopover>
    </div>
  );
}
