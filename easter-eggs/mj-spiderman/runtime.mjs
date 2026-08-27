import { installMjSequenceListener } from "./trigger.mjs";

const ROOT_CLASS_NAME = "mj-spiderman-easter-egg";

function normalizedEffects(effects) {
  if (!Array.isArray(effects) || effects.length === 0) {
    throw new TypeError("至少需要一个蜘蛛侠特效素材。");
  }

  return effects.map((effect, index) => {
    const src = String(effect?.src || "").trim();
    if (!src) throw new TypeError(`第 ${index + 1} 个蜘蛛侠特效缺少素材地址。`);
    return {
      id: String(effect?.id || `effect-${index + 1}`),
      label: String(effect?.label || `蜘蛛侠特效 ${index + 1}`),
      src,
    };
  });
}

function createEffectVideo(documentRef, effect) {
  const video = documentRef.createElement("video");
  video.className = `${ROOT_CLASS_NAME}__video`;
  video.dataset.effectId = effect.id;
  video.setAttribute("aria-hidden", "true");
  video.setAttribute("playsinline", "");
  video.setAttribute("tabindex", "-1");
  video.autoplay = false;
  video.controls = false;
  video.disablePictureInPicture = true;
  video.disableRemotePlayback = true;
  video.hidden = true;
  video.loop = false;
  video.muted = false;
  video.playsInline = true;
  video.preload = "auto";
  video.src = effect.src;
  return video;
}

function randomIndex(length, random) {
  const sample = Number(random());
  if (!Number.isFinite(sample)) return 0;
  return Math.min(length - 1, Math.max(0, Math.floor(sample * length)));
}

export function installMjSpidermanEasterEgg({
  documentRef = globalThis.document,
  effects,
  random = Math.random,
  target = globalThis.window,
} = {}) {
  if (!documentRef?.body || typeof documentRef.createElement !== "function") {
    throw new TypeError("documentRef 必须是已创建 body 的 DOM 文档。");
  }
  if (typeof random !== "function") throw new TypeError("random 必须是函数。");

  const availableEffects = normalizedEffects(effects);
  const root = documentRef.createElement("div");
  root.className = ROOT_CLASS_NAME;
  root.setAttribute("aria-hidden", "true");
  root.hidden = true;

  const entries = availableEffects.map((effect) => {
    const video = createEffectVideo(documentRef, effect);
    root.append(video);
    return { effect, video };
  });
  documentRef.body.append(root);

  let activeEntry = null;
  let disposed = false;
  let playbackToken = 0;

  function deactivate(entry = activeEntry) {
    if (!entry || entry !== activeEntry) return;
    entry.video.pause();
    entry.video.hidden = true;
    root.hidden = true;
    delete root.dataset.effectId;
    activeEntry = null;
  }

  const mediaListeners = entries.map((entry) => {
    const onEnded = () => deactivate(entry);
    const onError = () => deactivate(entry);
    entry.video.addEventListener("ended", onEnded);
    entry.video.addEventListener("error", onError);
    return { entry, onEnded, onError };
  });

  function playRandomEffect() {
    if (disposed) return;

    const token = ++playbackToken;
    const selected = entries[randomIndex(entries.length, random)];
    for (const entry of entries) {
      entry.video.pause();
      entry.video.hidden = entry !== selected;
      try {
        entry.video.currentTime = 0;
      } catch {
        // A not-yet-loaded local video starts at zero automatically.
      }
    }

    activeEntry = selected;
    root.dataset.effectId = selected.effect.id;
    root.hidden = false;

    let playback;
    try {
      playback = selected.video.play();
    } catch {
      if (!disposed && token === playbackToken) deactivate(selected);
      return;
    }
    if (playback && typeof playback.catch === "function") {
      playback.catch(() => {
        if (!disposed && token === playbackToken) deactivate(selected);
      });
    }
  }

  const uninstallTrigger = installMjSequenceListener({ onTrigger: playRandomEffect, target });

  return () => {
    if (disposed) return;
    disposed = true;
    playbackToken += 1;
    uninstallTrigger();
    for (const { entry, onEnded, onError } of mediaListeners) {
      entry.video.pause();
      entry.video.removeEventListener("ended", onEnded);
      entry.video.removeEventListener("error", onError);
      entry.video.removeAttribute("src");
      entry.video.load();
    }
    activeEntry = null;
    root.remove();
  };
}
