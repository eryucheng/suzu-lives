const BOTTOM_TOLERANCE_PX = 48;

function clean(value) {
  return String(value ?? "").trim();
}

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function messageNodes(list) {
  if (typeof list?.querySelectorAll !== "function") return [];
  return [...list.querySelectorAll("[data-conversation-anchor-id]")]
    .filter((node) => clean(node?.dataset?.conversationAnchorId));
}

function viewportBounds(list) {
  const rect = typeof list?.getBoundingClientRect === "function" ? list.getBoundingClientRect() : null;
  const top = finite(rect?.top);
  const clientHeight = finite(list?.clientHeight);
  const height = clientHeight > 0 ? clientHeight : Math.max(0, finite(rect?.bottom) - top);
  return { bottom: top + height, top };
}

function anchorsInViewport(list) {
  const viewport = viewportBounds(list);
  return messageNodes(list).flatMap((node) => {
    if (typeof node?.getBoundingClientRect !== "function") return [];
    const rect = node.getBoundingClientRect();
    if (finite(rect?.bottom) <= viewport.top || finite(rect?.top) >= viewport.bottom) return [];
    return [{
      anchorId: clean(node.dataset.conversationAnchorId),
      offset: finite(rect.top) - viewport.top,
    }];
  });
}

/**
 * Captures the visible message rows rather than a raw scrollTop value. A later
 * display-preference change can remove rows above the viewport without moving
 * the conversation the person was reading.
 */
export function captureConversationViewportAnchor(list, { bottomTolerance = BOTTOM_TOLERANCE_PX } = {}) {
  if (!list) return null;
  const scrollTop = finite(list.scrollTop);
  const distanceToBottom = finite(list.scrollHeight) - scrollTop - finite(list.clientHeight);
  if (distanceToBottom <= Math.max(0, finite(bottomTolerance, BOTTOM_TOLERANCE_PX))) return { mode: "bottom" };
  const anchors = anchorsInViewport(list);
  return anchors.length ? { anchors, mode: "messages" } : null;
}

/**
 * Restores the first surviving visible anchor. Keeping several anchors allows
 * a switch that hides the topmost system row to fall back to the next message.
 */
export function restoreConversationViewportAnchor(list, anchor) {
  if (!list || !anchor || typeof anchor !== "object") return false;
  if (anchor.mode === "bottom") {
    list.scrollTop = Math.max(0, finite(list.scrollHeight) - finite(list.clientHeight));
    return true;
  }
  if (anchor.mode !== "messages" || !Array.isArray(anchor.anchors)) return false;
  const nodes = messageNodes(list);
  const viewport = viewportBounds(list);
  for (const saved of anchor.anchors) {
    const id = clean(saved?.anchorId);
    const target = nodes.find((node) => clean(node.dataset.conversationAnchorId) === id);
    if (!target || typeof target.getBoundingClientRect !== "function") continue;
    const offset = finite(target.getBoundingClientRect().top) - viewport.top;
    list.scrollTop = Math.max(0, finite(list.scrollTop) + offset - finite(saved.offset));
    return true;
  }
  return false;
}
