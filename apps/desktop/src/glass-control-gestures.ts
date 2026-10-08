import { animate, type AnimationPlaybackControls } from 'motion';

const controls =
  'button:is(.icon-button,.design-switch,.glass-effects-toggle,.send-button,.new-chat,.nav-item,.settings-nav-item,.provider-tag,.autopilot-toggle,.primary-button,.secondary-button), .suggestions button';

/** Spring gestures on controls only: native click, focus, and selection are untouched. */
export function attachGlassControlGestures(root: HTMLElement): () => void {
  const animations = new Map<
    HTMLElement,
    { animation: AnimationPlaybackControls | undefined; transform: string }
  >();
  let hovered: HTMLElement | null = null;
  let pressed: HTMLElement | null = null;
  function buttonAt(target: EventTarget | null) {
    const button = (target as Element | null)?.closest?.<HTMLButtonElement>(controls);
    return button &&
      !button.disabled &&
      !button.hasAttribute('data-motion-managed') &&
      root.contains(button)
      ? button
      : null;
  }
  function spring(button: HTMLElement, scale: number, y: number, restore = false) {
    const previous = animations.get(button);
    previous?.animation?.stop();
    const record = {
      transform: previous?.transform ?? button.style.transform,
      animation: undefined as AnimationPlaybackControls | undefined,
    };
    animations.set(button, record);
    record.animation = animate(
      button,
      { scale, y },
      {
        type: 'spring',
        stiffness: 420,
        damping: 21,
        mass: 0.6,
        onComplete: () => {
          if (restore && animations.get(button) === record) {
            button.style.transform = record.transform;
            animations.delete(button);
          }
        },
      },
    );
  }
  function over(event: PointerEvent) {
    if (event.pointerType === 'touch') return;
    const button = buttonAt(event.target);
    if (hovered === button) return;
    if (hovered && hovered !== pressed) spring(hovered, 1, 0, true);
    hovered = button;
    if (button && button !== pressed) spring(button, 1.045, -1.5);
  }
  function out(event: PointerEvent) {
    const next = buttonAt(event.relatedTarget);
    if (hovered === next) return;
    if (hovered && hovered !== pressed) spring(hovered, 1, 0, true);
    // The following pointerover starts the next button's hover spring.
    hovered = null;
  }
  function press(event: PointerEvent | KeyboardEvent) {
    if ('key' in event && (event.repeat || ![' ', 'Enter'].includes(event.key))) return;
    if ('button' in event && event.button !== 0) return;
    const button = buttonAt(event.target);
    if (!button) return;
    pressed = button;
    spring(button, 0.91, 1);
  }
  function release(event: PointerEvent | KeyboardEvent) {
    if ('key' in event && ![' ', 'Enter'].includes(event.key)) return;
    if (!pressed) return;
    spring(
      pressed,
      pressed === hovered ? 1.045 : 1,
      pressed === hovered ? -1.5 : 0,
      pressed !== hovered,
    );
    pressed = null;
  }
  function reset() {
    hovered = pressed = null;
    for (const button of animations.keys()) spring(button, 1, 0, true);
  }
  root.addEventListener('pointerover', over, { passive: true });
  root.addEventListener('pointerout', out, { passive: true });
  root.addEventListener('pointerdown', press, { passive: true });
  root.addEventListener('pointerup', release, { passive: true });
  root.addEventListener('pointerleave', reset, { passive: true });
  root.addEventListener('pointercancel', reset, { passive: true });
  root.addEventListener('keydown', press);
  root.addEventListener('keyup', release);
  return () => {
    root.removeEventListener('pointerover', over);
    root.removeEventListener('pointerout', out);
    root.removeEventListener('pointerdown', press);
    root.removeEventListener('pointerup', release);
    root.removeEventListener('pointerleave', reset);
    root.removeEventListener('pointercancel', reset);
    root.removeEventListener('keydown', press);
    root.removeEventListener('keyup', release);
    for (const [button, record] of animations) {
      record.animation?.stop();
      button.style.transform = record.transform;
    }
    animations.clear();
  };
}
