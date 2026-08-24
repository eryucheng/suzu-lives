export function releasePointerCapture(target, pointerId) {
  try {
    if (target?.hasPointerCapture?.(pointerId)) target.releasePointerCapture(pointerId);
  } catch {
    // The platform may have already released capture while recovery runs.
  }
}

export function subscribePointerCaptureRecovery(onRecover) {
  if (typeof window === "undefined" || typeof document === "undefined") return () => {};
  const recover = () => onRecover?.();
  const recoverWhenHidden = () => {
    if (document.visibilityState === "hidden") recover();
  };
  window.addEventListener("blur", recover);
  document.addEventListener("visibilitychange", recoverWhenHidden);
  return () => {
    window.removeEventListener("blur", recover);
    document.removeEventListener("visibilitychange", recoverWhenHidden);
  };
}
