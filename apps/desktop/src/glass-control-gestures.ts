import {
  animate,
  cancelFrame,
  frame,
  motionValue,
  type AnimationPlaybackControls,
  type MotionValue,
} from 'motion';

const controls =
  'button:is(.icon-button,.design-switch,.glass-effects-toggle,.send-button,.new-chat,.nav-item,.settings-nav-item,.provider-tag,.autopilot-toggle,.primary-button,.secondary-button), .suggestions button, .glass-optics-preview-lens';

const properties = {
  x: '--glass-lens-x',
  y: '--glass-lens-y',
  scaleX: '--glass-lens-scale-x',
  scaleY: '--glass-lens-scale-y',
  pressure: '--glass-pressure',
  reflection: '--glass-reflection',
} as const;
type Axis = keyof typeof properties;
type LensState = Record<Axis, number>;
const axes = Object.keys(properties) as Axis[];
const neutral: LensState = { x: 0, y: 0, scaleX: 1, scaleY: 1, pressure: 0, reflection: 0 };
const pressing: LensState = {
  ...neutral,
  scaleX: 0.96,
  scaleY: 1.015,
  pressure: 1,
  reflection: 0.9,
};

type LensRecord = {
  element: HTMLElement;
  values: Record<Axis, MotionValue<number>>;
  originals: Map<string, { value: string; priority: string }>;
  originalLensMarker: string | null;
  animations: AnimationPlaybackControls[];
  render: () => void;
  renderQueued: boolean;
  lastPainted: LensState | null;
  target: LensState;
  generation: number;
};
type Press = {
  element: HTMLElement;
  pointerId: number | null;
  pointerType: string;
  key: string | null;
  x: number;
  y: number;
  dragged: boolean;
  preview: boolean;
};

/** Deforms only a control's optical layers. Text, hit targets, focus and native panning stay stable. */
export function attachGlassControlGestures(root: HTMLElement): () => void {
  const view = root.ownerDocument.defaultView;
  if (!view) return () => {};
  const lenses = new Map<HTMLElement, LensRecord>();
  let hovered: HTMLElement | null = null;
  let pressed: Press | null = null;
  let suppressedClick: { element: HTMLElement; pointerId: number; expires: number } | null = null;
  let disposed = false;
  let pendingDrag: { element: HTMLElement; target: LensState } | null = null;
  let dragQueued = false;

  function controlAt(target: EventTarget | null) {
    const control = (target as Element | null)?.closest?.<HTMLButtonElement>(controls);
    return control &&
      !control.disabled &&
      !control.hasAttribute('data-motion-managed') &&
      root.contains(control)
      ? control
      : null;
  }

  function emit(record: LensRecord, state: LensState) {
    record.element.dispatchEvent(
      new CustomEvent('lodex:glass-lens', {
        bubbles: true,
        detail: { pressure: state.pressure, stretchX: state.scaleX, stretchY: state.scaleY },
      }),
    );
  }

  function paint(record: LensRecord) {
    record.renderQueued = false;
    if (disposed || lenses.get(record.element) !== record) return;
    const clamp = (value: number, low: number, high: number) =>
      Math.max(low, Math.min(high, value));
    const state: LensState = {
      x: clamp(record.values.x.get(), -12, 12),
      y: clamp(record.values.y.get(), -12, 12),
      scaleX: clamp(record.values.scaleX.get(), 0.88, 1.16),
      scaleY: clamp(record.values.scaleY.get(), 0.88, 1.16),
      pressure: clamp(record.values.pressure.get(), 0, 1),
      reflection: clamp(record.values.reflection.get(), 0, 1),
    };
    for (const axis of axes) {
      state[axis] = Number(state[axis].toFixed(4));
      if (state[axis] !== record.lastPainted?.[axis])
        record.element.style.setProperty(
          properties[axis],
          `${state[axis]}${axis === 'x' || axis === 'y' ? 'px' : ''}`,
        );
    }
    if (
      state.pressure !== record.lastPainted?.pressure ||
      state.scaleX !== record.lastPainted?.scaleX ||
      state.scaleY !== record.lastPainted?.scaleY
    )
      emit(record, state);
    record.lastPainted = state;
  }

  function schedulePaint(record: LensRecord) {
    if (disposed || lenses.get(record.element) !== record || record.renderQueued) return;
    record.renderQueued = true;
    // Motion's render phase follows all six spring updates in this same frame.
    frame.render(record.render);
  }

  function recordFor(element: HTMLElement) {
    let record = lenses.get(element);
    if (record) return record;
    record = {
      element,
      values: Object.fromEntries(axes.map((axis) => [axis, motionValue(neutral[axis])])) as Record<
        Axis,
        MotionValue<number>
      >,
      originals: new Map(
        Object.values(properties).map((property) => [
          property,
          {
            value: element.style.getPropertyValue(property),
            priority: element.style.getPropertyPriority(property),
          },
        ]),
      ),
      originalLensMarker: element.getAttribute('data-glass-lens'),
      animations: [],
      render: () => {},
      renderQueued: false,
      lastPainted: null,
      target: neutral,
      generation: 0,
    };
    const created = record;
    created.render = () => paint(created);
    lenses.set(element, record);
    if (record.originalLensMarker === null) element.setAttribute('data-glass-lens', '');
    return record;
  }

  function restore(record: LensRecord) {
    if (lenses.get(record.element) !== record) return;
    lenses.delete(record.element);
    record.generation++;
    for (const animation of record.animations) animation.stop();
    cancelFrame(record.render);
    record.renderQueued = false;
    for (const value of Object.values(record.values)) value.destroy();
    for (const [property, original] of record.originals) {
      if (original.value)
        record.element.style.setProperty(property, original.value, original.priority);
      else record.element.style.removeProperty(property);
    }
    // Keep the target marked until optics receive its final reset; otherwise the
    // bubbling event would resolve to the containing panel's lens instead.
    emit(record, neutral);
    if (record.originalLensMarker === null) record.element.removeAttribute('data-glass-lens');
    else record.element.setAttribute('data-glass-lens', record.originalLensMarker);
  }

  function spring(element: HTMLElement, target: LensState, restoreAfter = false) {
    const record = recordFor(element);
    if (!restoreAfter && axes.every((axis) => target[axis] === record.target[axis])) return;
    record.target = target;
    const generation = ++record.generation;
    for (const animation of record.animations) animation.stop();
    let remaining = axes.length;
    // MotionValues carry the current velocity when a drag retargets the spring.
    record.animations = axes.map((axis) =>
      animate(record.values[axis], target[axis], {
        type: 'spring',
        stiffness: 350,
        damping: 17,
        mass: 0.65,
        restDelta: axis === 'x' || axis === 'y' ? 0.01 : 0.0001,
        restSpeed: axis === 'x' || axis === 'y' ? 0.1 : 0.001,
        onUpdate: () => schedulePaint(record),
        onComplete: () => {
          if (disposed || record.generation !== generation) return;
          if (--remaining === 0 && restoreAfter) restore(record);
        },
      }),
    );
  }

  function endHover(element: HTMLElement) {
    const record = lenses.get(element);
    // Once the pointer leaves, even a finishing release must not leave a rim.
    if (record && pressed?.element !== element) restore(record);
  }

  function over(event: PointerEvent) {
    if (event.pointerType === 'touch') return;
    const control = controlAt(event.target);
    if (hovered === control) return;
    if (hovered && hovered !== pressed?.element) endHover(hovered);
    hovered = control;
    // Ordinary hover is CSS-only: no dynamic SVG filter or numeric springs.
  }

  function out(event: PointerEvent) {
    const next = controlAt(event.relatedTarget);
    if (hovered === next) return;
    if (hovered && hovered !== pressed?.element) endHover(hovered);
    hovered = null;
  }

  function releaseCapture(press: Press) {
    if (!press.preview || press.pointerId === null) return;
    try {
      if (press.element.hasPointerCapture(press.pointerId))
        press.element.releasePointerCapture(press.pointerId);
    } catch {
      /* The element or pointer can disappear while a panel closes. */
    }
  }

  function clearPendingDrag() {
    pendingDrag = null;
    dragQueued = false;
    cancelFrame(flushDrag);
  }

  function finish(cancelled: boolean, outside = false) {
    const current = pressed;
    if (!current) return;
    clearPendingDrag();
    pressed = null;
    if (!cancelled && current.dragged && current.pointerId !== null) {
      suppressedClick = {
        element: current.element,
        pointerId: current.pointerId,
        expires: view!.performance.now() + 700,
      };
    }
    releaseCapture(current);
    if (outside) endHover(current.element);
    else spring(current.element, neutral, true);
  }

  function pointerDown(event: PointerEvent) {
    if (event.button !== 0 || event.isPrimary === false) return;
    const element = controlAt(event.target);
    if (!element) return;
    finish(true);
    suppressedClick = null;
    const preview = element.matches('.glass-optics-preview-lens');
    pressed = {
      element,
      pointerId: event.pointerId,
      pointerType: event.pointerType,
      key: null,
      x: event.clientX,
      y: event.clientY,
      dragged: false,
      preview,
    };
    // Only the explicit playground captures pointers. Real controls retain native pan behavior.
    if (preview) {
      try {
        element.setPointerCapture(event.pointerId);
      } catch {
        /* Detached element or inactive pointer. */
      }
    }
    spring(element, pressing);
  }

  function pointerMove(event: PointerEvent) {
    if (!pressed || pressed.pointerId !== event.pointerId) return;
    if (pressed.pointerType === 'touch' && !pressed.preview) return;
    const dx = event.clientX - pressed.x;
    const dy = event.clientY - pressed.y;
    const distance = Math.hypot(dx, dy);
    if (distance > 8) pressed.dragged = true;
    const strength = Math.min(distance / 88, 1);
    const horizontal = distance ? Math.abs(dx) / distance : 0;
    const vertical = distance ? Math.abs(dy) / distance : 0;
    pendingDrag = {
      element: pressed.element,
      target: {
        x: 12 * Math.tanh(dx / 50),
        y: 12 * Math.tanh(dy / 50),
        scaleX: pressing.scaleX + strength * (0.17 * horizontal - 0.035 * vertical),
        scaleY: pressing.scaleY + strength * (0.115 * vertical - 0.06 * horizontal),
        pressure: 1,
        reflection: Math.min(1, 0.9 + strength * 0.1),
      },
    };
    if (!dragQueued) {
      dragQueued = true;
      frame.read(flushDrag);
    }
  }

  function flushDrag() {
    dragQueued = false;
    const pending = pendingDrag;
    pendingDrag = null;
    if (!disposed && pending && pressed?.element === pending.element)
      spring(pending.element, pending.target);
  }

  function pointerUp(event: PointerEvent) {
    if (pressed?.pointerId === event.pointerId)
      finish(false, controlAt(event.target) !== pressed.element);
  }

  function pointerCancel(event: PointerEvent) {
    if (pressed?.pointerId === event.pointerId) finish(true);
  }

  function keyDown(event: KeyboardEvent) {
    if (event.repeat || ![' ', 'Enter'].includes(event.key)) return;
    const element = controlAt(event.target);
    if (!element) return;
    finish(true);
    pressed = {
      element,
      pointerId: null,
      pointerType: '',
      key: event.key,
      x: 0,
      y: 0,
      dragged: false,
      preview: false,
    };
    spring(element, pressing);
  }

  function keyUp(event: KeyboardEvent) {
    if (pressed?.key === event.key) finish(false);
  }

  function focusOut(event: FocusEvent) {
    if (pressed?.key && controlAt(event.relatedTarget) !== pressed.element) finish(true);
  }

  function click(event: MouseEvent) {
    if (!suppressedClick || event.detail === 0 || view!.performance.now() > suppressedClick.expires)
      return;
    if (controlAt(event.target) !== suppressedClick.element) return;
    if ('pointerId' in event && event.pointerId !== suppressedClick.pointerId) return;
    suppressedClick = null;
    event.preventDefault();
    event.stopPropagation();
  }

  function leave() {
    if (hovered && hovered !== pressed?.element) endHover(hovered);
    hovered = null;
  }

  function reset() {
    clearPendingDrag();
    const current = pressed;
    pressed = null;
    hovered = null;
    suppressedClick = null;
    if (current) releaseCapture(current);
    for (const record of [...lenses.values()]) restore(record);
  }

  root.addEventListener('pointerover', over, { passive: true });
  root.addEventListener('pointerout', out, { passive: true });
  root.addEventListener('pointerdown', pointerDown, { passive: true });
  root.addEventListener('pointerleave', leave, { passive: true });
  root.addEventListener('lostpointercapture', pointerCancel, { passive: true });
  root.addEventListener('keydown', keyDown);
  root.addEventListener('focusout', focusOut);
  root.addEventListener('click', click, true);
  view.addEventListener('pointermove', pointerMove, { passive: true });
  view.addEventListener('pointerup', pointerUp, { passive: true });
  view.addEventListener('pointercancel', pointerCancel, { passive: true });
  view.addEventListener('keyup', keyUp);
  view.addEventListener('blur', reset);

  return () => {
    disposed = true;
    root.removeEventListener('pointerover', over);
    root.removeEventListener('pointerout', out);
    root.removeEventListener('pointerdown', pointerDown);
    root.removeEventListener('pointerleave', leave);
    root.removeEventListener('lostpointercapture', pointerCancel);
    root.removeEventListener('keydown', keyDown);
    root.removeEventListener('focusout', focusOut);
    root.removeEventListener('click', click, true);
    view.removeEventListener('pointermove', pointerMove);
    view.removeEventListener('pointerup', pointerUp);
    view.removeEventListener('pointercancel', pointerCancel);
    view.removeEventListener('keyup', keyUp);
    view.removeEventListener('blur', reset);
    reset();
  };
}
