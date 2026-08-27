const DEFAULT_MAX_INTERVAL_MS = 1_800;

function isModifierOnlyKey(key) {
  return key === "Shift" || key === "CapsLock";
}

export function createMjSequenceMatcher({
  clock = Date.now,
  maxIntervalMs = DEFAULT_MAX_INTERVAL_MS,
} = {}) {
  if (typeof clock !== "function") throw new TypeError("clock 必须是函数。");
  if (!Number.isFinite(maxIntervalMs) || maxIntervalMs <= 0) {
    throw new TypeError("maxIntervalMs 必须是正数。");
  }

  let armedAt = null;

  function reset() {
    armedAt = null;
  }

  function feed(event = {}) {
    if (
      event.isComposing
      || event.keyCode === 229
      || event.ctrlKey
      || event.altKey
      || event.metaKey
    ) {
      reset();
      return false;
    }

    if (event.repeat) return false;

    const rawKey = typeof event.key === "string" ? event.key : "";
    if (isModifierOnlyKey(rawKey)) return false;
    if (Array.from(rawKey).length !== 1) {
      reset();
      return false;
    }

    const key = rawKey.toLowerCase();
    const pressedAt = Number(clock());
    if (!Number.isFinite(pressedAt)) {
      reset();
      return false;
    }

    if (key === "m") {
      armedAt = pressedAt;
      return false;
    }

    const matched = key === "j"
      && armedAt !== null
      && pressedAt >= armedAt
      && pressedAt - armedAt <= maxIntervalMs;
    reset();
    return matched;
  }

  return { feed, reset };
}

export function installMjSequenceListener({
  clock,
  maxIntervalMs,
  onTrigger,
  target = globalThis.window,
} = {}) {
  if (!target || typeof target.addEventListener !== "function" || typeof target.removeEventListener !== "function") {
    throw new TypeError("target 必须支持 DOM 事件监听。");
  }
  if (typeof onTrigger !== "function") throw new TypeError("onTrigger 必须是函数。");

  const matcher = createMjSequenceMatcher({ clock, maxIntervalMs });
  const onKeyDown = (event) => {
    if (matcher.feed(event)) onTrigger(event);
  };
  const onBlur = () => matcher.reset();

  target.addEventListener("keydown", onKeyDown, true);
  target.addEventListener("blur", onBlur);

  return () => {
    matcher.reset();
    target.removeEventListener("keydown", onKeyDown, true);
    target.removeEventListener("blur", onBlur);
  };
}
