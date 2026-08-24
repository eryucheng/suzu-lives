import { useEffect, useRef } from "react";

import { subscribePointerCaptureRecovery } from "../core/pointer-capture.mjs";

export function usePointerCaptureRecovery(onRecover) {
  const onRecoverRef = useRef(onRecover);
  onRecoverRef.current = onRecover;

  useEffect(() => {
    const unsubscribe = subscribePointerCaptureRecovery(() => onRecoverRef.current?.());
    return () => {
      unsubscribe();
      onRecoverRef.current?.();
    };
  }, []);
}
