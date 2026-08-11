import { useEffect, useRef } from "react";

export function CreateStudioDialog({ ariaLabel, children, className = "", onClose, open }) {
  const dialogRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const previousFocus = document.activeElement;
    const onKeyDown = (event) => {
      if (event.key === "Escape") onClose?.();
    };
    document.addEventListener("keydown", onKeyDown);
    window.requestAnimationFrame(() => dialogRef.current?.focus());
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      previousFocus?.focus?.();
    };
  }, [onClose, open]);

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
