function clean(value) {
  return String(value ?? "").trim();
}

function unavailableRoute(id, title, description) {
  return Object.freeze({
    description,
    id,
    title,
  });
}

/**
 * These are software-level management areas.  They are independent of the
 * installable capability catalog, so a companion can manage its owner,
 * runtime, and usage before any product capability is installed.
 */
export const SUZU_ADMIN_TABS = Object.freeze([
  "agent",
  "usage",
]);

// "创造" is a normal software area rather than a capability placeholder.
// Its existing image and audio pages decide which separately installed
// capabilities are currently available; navigation itself must not hide those
// working product surfaces behind a fake unavailable route.
const DEFERRED_CAPABILITY_VIEWS = Object.freeze({});

const UNAVAILABLE_RELATIONSHIP_PAGES = Object.freeze({
});

export function getDeferredCapabilityView(view) {
  return DEFERRED_CAPABILITY_VIEWS[clean(view)] || null;
}

export function normalizeSuzuNavigationView(view) {
  const value = clean(view);
  return value;
}

export function resolveSuzuRelationshipPage(page) {
  const value = clean(page);
  if (!value || value === "overview") {
    return Object.freeze({ page: "overview", unavailable: null });
  }
  if (value === "conversation") {
    return Object.freeze({ page: "conversation", unavailable: null });
  }
  if (value === "compactor") return Object.freeze({ page: "compactor", unavailable: null });
  if (value === "journal") return Object.freeze({ page: "journal", unavailable: null });
  if (value === "memory") return Object.freeze({ page: "memory", unavailable: null });
  if (value === "settings") return Object.freeze({ page: "settings", unavailable: null });
  return Object.freeze({
    page: "unavailable",
    unavailable: UNAVAILABLE_RELATIONSHIP_PAGES[value]
      || unavailableRoute("relationship-feature", "关系功能", "这个功能暂未接入当前聊天优先版本。"),
  });
}
