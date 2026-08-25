import { useEffect, useRef } from "react";

import "./wallpaper-stage.css";

function playVideo(video) {
  if (!video) return;
  void video.play().catch(() => undefined);
}

export function WallpaperStage({ appearance = null, onError }) {
  const videoRef = useRef(null);
  const wallpaper = appearance?.wallpaper || null;
  const active = appearance?.styleId === "wallpaper-glass" && wallpaper?.status === "ready" && Boolean(wallpaper.url);

  useEffect(() => {
    const video = videoRef.current;
    if (!active || wallpaper?.kind !== "video" || !video) return undefined;
    const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)") || null;
    const syncPlayback = () => {
      if (document.hidden || reducedMotion?.matches) video.pause();
      else playVideo(video);
    };
    syncPlayback();
    document.addEventListener("visibilitychange", syncPlayback);
    reducedMotion?.addEventListener?.("change", syncPlayback);
    return () => {
      document.removeEventListener("visibilitychange", syncPlayback);
      reducedMotion?.removeEventListener?.("change", syncPlayback);
      video.pause();
    };
  }, [active, wallpaper?.kind, wallpaper?.url]);

  if (!active) return null;

  const handleError = () => onError?.(wallpaper.url);
  return (
    <>
      <div aria-hidden="true" className="wallpaper-stage">
        {wallpaper.kind === "video" ? (
          <video
            autoPlay
            className="wallpaper-stage__media"
            key={wallpaper.url}
            loop
            muted
            onError={handleError}
            playsInline
            preload="metadata"
            ref={videoRef}
            src={wallpaper.url}
          />
        ) : (
          <img
            alt=""
            className="wallpaper-stage__media"
            draggable="false"
            key={wallpaper.url}
            onError={handleError}
            src={wallpaper.url}
          />
        )}
      </div>
      <div aria-hidden="true" className="wallpaper-scrim" />
    </>
  );
}
