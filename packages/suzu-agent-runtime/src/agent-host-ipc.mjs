export const SUZU_AGENT_HOST_IPC_PROTOCOL = "suzu-agent-host/v1";

function clean(value) {
  return String(value ?? "").trim();
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function isPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function validRequestId(value) {
  const id = clean(value);
  return id && id.length <= 256 && !/[\r\n\0]/u.test(id) ? id : "";
}

function validMethod(value) {
  const method = clean(value);
  return method && method.length <= 128 && /^[a-z][a-z0-9./-]*$/iu.test(method) ? method : "";
}

/** Validate the narrow, local-only parent/child Agent Core protocol. */
export function isSuzuAgentHostIpcMessage(value) {
  const source = plainObject(value);
  if (source.protocol !== SUZU_AGENT_HOST_IPC_PROTOCOL) return false;
  const kind = clean(source.kind);
  if (kind === "ready") return source.details === undefined || isPlainObject(source.details);
  if (kind === "request") return Boolean(validRequestId(source.requestId) && validMethod(source.method) && isPlainObject(source.payload));
  if (kind === "response") return Boolean(validRequestId(source.requestId) && isPlainObject(source.result));
  if (kind === "event") {
    return Boolean((source.channel === "mux" || source.channel === "host") && isPlainObject(source.envelope));
  }
  return false;
}

export function normalizeSuzuAgentHostIpcMessage(value) {
  if (!isSuzuAgentHostIpcMessage(value)) return null;
  const source = plainObject(value);
  const kind = clean(source.kind);
  return Object.freeze({
    protocol: SUZU_AGENT_HOST_IPC_PROTOCOL,
    kind,
    ...(validRequestId(source.requestId) ? { requestId: validRequestId(source.requestId) } : {}),
    ...(validMethod(source.method) ? { method: validMethod(source.method) } : {}),
    ...(kind === "request" ? { payload: Object.freeze({ ...plainObject(source.payload) }) } : {}),
    ...(kind === "response" ? { result: Object.freeze({ ...plainObject(source.result) }) } : {}),
    ...(kind === "event" ? {
      channel: source.channel,
      envelope: Object.freeze({ ...plainObject(source.envelope) }),
    } : {}),
    ...(kind === "ready" ? { details: Object.freeze({ ...plainObject(source.details) }) } : {}),
  });
}
