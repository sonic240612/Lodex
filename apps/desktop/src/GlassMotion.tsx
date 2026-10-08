import {
  createContext,
  forwardRef,
  useContext,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type ForwardedRef,
  type ReactNode,
  type RefObject,
} from 'react';
import {
  AnimatePresence,
  MotionConfig,
  animate,
  motion,
  useIsPresent,
  usePresence,
  type MotionStyle,
} from 'motion/react';

export const GlassMotionContext = createContext(false);
export const glassSpring = { type: 'spring', stiffness: 330, damping: 30, mass: 0.85 } as const;

export const GlassRoot = forwardRef<
  HTMLDivElement,
  ComponentPropsWithoutRef<'div'> & { allowMotion: boolean }
>(function GlassRoot({ allowMotion, children, ...props }, ref) {
  return (
    <MotionConfig reducedMotion="never">
      <GlassMotionContext.Provider value={allowMotion}>
        <div {...props} ref={ref}>
          {children}
        </div>
      </GlassMotionContext.Provider>
    </MotionConfig>
  );
});

export function glassPanelLayout(width: number, sidebarOpen: boolean, planOpen: boolean) {
  const sidebarWidth = width >= 1600 ? 260 : width >= 1180 ? 246 : 220;
  const planWidth = width >= 1600 ? 320 : 300;
  return {
    sidebarTrack: sidebarOpen && width > 760 ? sidebarWidth : 0,
    planTrack: planOpen && width >= 1180 ? planWidth : 0,
    sidebarWidth: width > 760 ? sidebarWidth - 16 : undefined,
    planWidth: width >= 1180 ? planWidth - 16 : undefined,
  };
}

/** Reflow the reading column once, then animate its position on the compositor. */
export function useGlassPanelLayout(
  root: RefObject<HTMLElement | null>,
  enabled: boolean,
  allowMotion: boolean,
  sidebarOpen: boolean,
  planOpen: boolean,
) {
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);
  useEffect(() => {
    const update = () => setViewportWidth(window.innerWidth);
    window.addEventListener('resize', update, { passive: true });
    return () => window.removeEventListener('resize', update);
  }, []);
  const layout = glassPanelLayout(viewportWidth, sidebarOpen, planOpen);
  const initialized = useRef(false);
  const previousViewport = useRef(viewportWidth);
  useLayoutEffect(() => {
    const resized = previousViewport.current !== viewportWidth;
    previousViewport.current = viewportWidth;
    const element = root.current;
    const main = element?.querySelector<HTMLElement>('.main');
    if (!element || !enabled) {
      element?.style.removeProperty('grid-template-columns');
      element?.removeAttribute('data-glass-layout-moving');
      main?.style.removeProperty('transform');
      initialized.current = false;
      return;
    }
    const previousLeft = main?.getBoundingClientRect().left;
    main?.style.removeProperty('transform');
    element.style.gridTemplateColumns = `${layout.sidebarTrack}px minmax(0, 1fr) ${layout.planTrack}px`;
    const offset =
      main && previousLeft !== undefined ? previousLeft - main.getBoundingClientRect().left : 0;
    const shouldAnimate = initialized.current && allowMotion && !resized && Math.abs(offset) > 0.5;
    initialized.current = true;
    if (!shouldAnimate || !main) return;
    element.setAttribute('data-glass-layout-moving', '');
    const playback = animate(
      main,
      { x: [offset, 0] },
      {
        duration: 0.22,
        ease: [0.22, 1, 0.36, 1],
      },
    );
    let active = true;
    void playback.then(() => {
      if (!active) return;
      main.style.removeProperty('transform');
      element.removeAttribute('data-glass-layout-moving');
    });
    return () => {
      active = false;
      playback.stop();
      element.removeAttribute('data-glass-layout-moving');
    };
  }, [root, enabled, allowMotion, layout.sidebarTrack, layout.planTrack, viewportWidth]);
  return layout;
}

export function GlassPanel({
  side,
  className,
  label,
  style,
  children,
}: {
  side: 'left' | 'right';
  className: string;
  label: string;
  style?: MotionStyle | undefined;
  children: ReactNode;
}) {
  const animated = useContext(GlassMotionContext);
  const present = useIsPresent();
  const offset = side === 'left' ? -36 : 36;
  return (
    <motion.aside
      className={className}
      aria-label={label}
      aria-hidden={!present || undefined}
      inert={!present || undefined}
      data-motion-managed
      style={style ?? {}}
      initial={animated ? { opacity: 0, x: offset } : false}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: animated ? offset : 0 }}
      transition={animated ? glassSpring : { duration: 0 }}
    >
      {children}
    </motion.aside>
  );
}

export const GlassPopover = forwardRef<
  HTMLDivElement,
  ComponentPropsWithoutRef<'div'> & {
    open: boolean;
    origin?: string;
  }
>(function GlassPopover({ open, children, origin = 'bottom left', ...props }, forwardedRef) {
  const animated = useContext(GlassMotionContext);
  return (
    <AnimatePresence>
      {open && (
        <PopoverBody
          key="popover"
          {...props}
          animated={animated}
          origin={origin}
          forwardedRef={forwardedRef}
        >
          {children}
        </PopoverBody>
      )}
    </AnimatePresence>
  );
});

function PopoverBody({
  animated,
  origin,
  forwardedRef,
  children,
  ...props
}: ComponentPropsWithoutRef<'div'> & {
  animated: boolean;
  origin: string;
  forwardedRef: ForwardedRef<HTMLDivElement>;
}) {
  const present = useIsPresent();
  const ref = useRef<HTMLDivElement>(null);
  useImperativeHandle(forwardedRef, () => ref.current!);
  const [isPresent, safeToRemove] = usePresence();
  const previousPresence = useRef(isPresent);
  useEffect(() => {
    const reopening = isPresent && !previousPresence.current;
    previousPresence.current = isPresent;
    if (!ref.current) return;
    if (!animated) {
      ref.current.style.opacity = '1';
      ref.current.style.removeProperty('transform');
      if (!isPresent) safeToRemove?.();
      return;
    }
    const offset = origin.startsWith('top') ? -10 : 10;
    const playback = isPresent
      ? animate(
          ref.current,
          reopening
            ? { opacity: 1, scale: 1, y: 0 }
            : { opacity: [0, 1], scale: [0.88, 1], y: [offset, 0] },
          glassSpring,
        )
      : animate(
          ref.current,
          { opacity: 0, scale: 0.92, y: offset },
          { ...glassSpring, damping: 34 },
        );
    let active = true;
    void playback.then(() => {
      if (active && !isPresent) safeToRemove?.();
    });
    return () => {
      active = false;
      playback.stop();
    };
  }, [animated, isPresent, safeToRemove, origin]);
  return (
    <div
      {...props}
      ref={ref}
      data-motion-managed
      aria-hidden={!present || undefined}
      inert={!present || undefined}
      style={{ ...props.style, transformOrigin: origin }}
    >
      {children}
    </div>
  );
}

/** A native modal retains focus trapping through its exit animation. */
export const GlassDialog = forwardRef<HTMLDialogElement, ComponentPropsWithoutRef<'dialog'>>(
  function GlassDialog({ children, onCancel, ...props }, forwardedRef) {
    const animated = useContext(GlassMotionContext);
    const ref = useRef<HTMLDialogElement>(null);
    const [present, safeToRemove] = usePresence();
    const previousPresence = useRef(present);
    useImperativeHandle(forwardedRef, () => ref.current!);
    useEffect(() => {
      const reopening = present && !previousPresence.current;
      previousPresence.current = present;
      const dialog = ref.current;
      if (!dialog) return;
      if (!animated) {
        dialog.style.opacity = '1';
        dialog.style.removeProperty('transform');
        if (!present) safeToRemove?.();
        return;
      }
      const playback = present
        ? animate(
            dialog,
            reopening
              ? { opacity: 1, y: 0, scale: 1 }
              : { opacity: [0, 1], y: [24, 0], scale: [0.955, 1] },
            glassSpring,
          )
        : animate(dialog, { opacity: 0, y: 18, scale: 0.975 }, { ...glassSpring, damping: 34 });
      let active = true;
      void playback.then(() => {
        if (active && !present) {
          dialog.close();
          safeToRemove?.();
        }
      });
      return () => {
        active = false;
        playback.stop();
      };
    }, [animated, present, safeToRemove]);
    return (
      <dialog
        {...props}
        ref={ref}
        data-motion-managed
        onCancel={(event) => {
          if (animated) event.preventDefault();
          onCancel?.(event);
        }}
      >
        {children}
      </dialog>
    );
  },
);
