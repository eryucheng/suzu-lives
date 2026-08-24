import { useEffect, useRef } from "react";

const FOCUSABLE_DIALOG_CONTROL = "button:not([disabled]), [href], input:not([disabled]):not([type=\"hidden\"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex=\"-1\"])";

export function CreateStudioDialog({ ariaLabel, children, className = "", onClose, open }) {
  const dialogRef = useRef(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return undefined;
    const previousFocus = document.activeElement;
    const onKeyDown = (event) => {
      if (event.key === "Escape") onCloseRef.current?.();
    };
    document.addEventListener("keydown", onKeyDown);
    const animationFrame = window.requestAnimationFrame(() => {
      const dialog = dialogRef.current;
      if (!dialog || dialog.contains(document.activeElement)) return;
      const focusTarget = dialog.querySelector("[autofocus]") || dialog.querySelector(FOCUSABLE_DIALOG_CONTROL) || dialog;
      focusTarget.focus?.();
    });
    return () => {
      window.cancelAnimationFrame(animationFrame);
      document.removeEventListener("keydown", onKeyDown);
      previousFocus?.focus?.();
    };
  }, [open]);

  if (!open) return null;
  return (
    <div
      className="create-react-dialog-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose?.();
      }}
      role="presentation"
    >
      <section aria-label={ariaLabel} aria-modal="true" className={`create-react-dialog ${className}`.trim()} ref={dialogRef} role="dialog" tabIndex="-1">
        {children}
      </section>
    </div>
  );
}
