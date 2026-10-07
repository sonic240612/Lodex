import {
  createContext,
  forwardRef,
  useContext,
  useEffect,
  type ComponentPropsWithoutRef,
} from 'react';

export const SettingsBusyContext = createContext<((busy: boolean) => void) | null>(null);

/** Reuses the same editor in a standalone dialog or the central settings screen. */
export const SettingsSurface = forwardRef<
  HTMLDialogElement,
  ComponentPropsWithoutRef<'dialog'> & { embedded?: boolean }
>(function SettingsSurface(
  { embedded = false, className = '', children, onCancel, open, ...props },
  ref,
) {
  const reportBusy = useContext(SettingsBusyContext);
  const busy = props['aria-busy'] === true || props['aria-busy'] === 'true';
  useEffect(() => {
    if (!embedded || !reportBusy) return;
    reportBusy(busy);
    return () => reportBusy(false);
  }, [embedded, reportBusy, busy]);
  if (embedded)
    return (
      <section {...props} className={`settings-section ${className}`}>
        {children}
      </section>
    );
  return (
    <dialog {...props} ref={ref} open={open} onCancel={onCancel} className={className}>
      {children}
    </dialog>
  );
});
