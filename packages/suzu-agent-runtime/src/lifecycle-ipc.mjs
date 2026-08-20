export const SUZU_AGENT_LIFECYCLE_IPC_PROTOCOL = "suzu-agent-lifecycle/v1";

function clean(value) {
  return String(value ?? "").trim();
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function requestId(value) {
  const id = clean(value);
  return id && id.length <= 256 && !/[\r\n\0]/u.test(id) ? id : "";
}

/**
 * Validates the deliberately small IPC envelope shared by the Electron parent
 * and static Agent Core product plugins. Payloads remain product data; the
 * supervisor never executes or evaluates anything received from the child.
 */
export function isSuzuAgentLifecycleIpcMessage(value) {
  const source = plainObject(value);
  if (source.protocol !== SUZU_AGENT_LIFECYCLE_IPC_PROTOCOL) return false;
  const kind = clean(source.kind);
  if (kind === "request") {
    return Boolean(requestId(source.requestId) && clean(source.event) && plainObject(source.payload));
  }
  if (kind === "command") {
    return Boolean(requestId(source.requestId) && clean(source.event) && plainObject(source.payload));
  }
  if (kind === "response") {
    return Boolean(requestId(source.requestId) && plainObject(source.result));
  }
  if (kind === "event") return Boolean(clean(source.event) && plainObject(source.payload));
  return false;
}

export function normalizeSuzuAgentLifecycleIpcMessage(value) {
  if (!isSuzuAgentLifecycleIpcMessage(value)) return null;
  const source = plainObject(value);
  return Object.freeze({
    protocol: SUZU_AGENT_LIFECYCLE_IPC_PROTOCOL,
    kind: clean(source.kind),
    ...(clean(source.requestId) ? { requestId: clean(source.requestId) } : {}),
    ...(clean(source.event) ? { event: clean(source.event) } : {}),
    ...(source.payload ? { payload: Object.freeze({ ...plainObject(source.payload) }) } : {}),
    ...(source.result ? { result: Object.freeze({ ...plainObject(source.result) }) } : {}),
  });
}
