const DEFAULT_REALTIME_ASR_MODEL = "qwen3-asr-flash-realtime";

function clean(value) {
  return String(value ?? "").trim();
}

/**
 * DashScope accepts both the public endpoint and workspace-hosted endpoints.
 * Keep the websocket host aligned with the API connection the user selected.
 */
export function realtimeAsrWebSocketUrl(baseUrl = "", model = DEFAULT_REALTIME_ASR_MODEL) {
  let parsed = null;
  try { parsed = new URL(clean(baseUrl)); } catch { /* Fall back to DashScope's public endpoint. */ }
  const protocol = parsed?.protocol === "http:" ? "ws:" : "wss:";
  const host = parsed?.host || "dashscope.aliyuncs.com";
  return `${protocol}//${host}/api-ws/v1/realtime?model=${encodeURIComponent(clean(model) || DEFAULT_REALTIME_ASR_MODEL)}&heartbeat=true`;
}

export { DEFAULT_REALTIME_ASR_MODEL };
