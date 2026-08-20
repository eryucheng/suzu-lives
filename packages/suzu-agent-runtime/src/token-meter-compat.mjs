import { TokenMeter as UpstreamTokenMeter } from "../vendor/core/modules/token-meter.mjs";

import {
  conservativeHeaderTokens,
  conservativeMessageTokens,
} from "./context-token-estimate.mjs";

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function restoredHistoricalAssistantMessages(session) {
  const events = Array.isArray(session?.events) ? session.events : [];
  return events.some((event) => {
    if (event?.type !== "assistant/message") return false;
    const data = plainObject(event.data);
    // Native replies always carry the turn and step that produced them. The
    // one-time Claude importer intentionally has neither, because those old
    // records never had a DSH execution lifecycle to preserve.
    return data.turn === undefined && data.step === undefined;
  });
}

function sessionHeader(session) {
  try {
    return typeof session?.requestHeader === "function" ? session.requestHeader() : {};
  } catch {
    return {};
  }
}

function eventMessage(session, event) {
  try {
    if (typeof session?.deriveEventMessage === "function") {
      return session.deriveEventMessage(event);
    }
  } catch {
    // A malformed historical event is still priced conservatively below.
  }
  return plainObject(event?.data).message || plainObject(event?.data);
}

function restoredHistoryMeasurement(session, header) {
  const events = Array.isArray(session?.events) ? session.events : [];
  const surfaceNodes = Array.from(session?.surface?.nodes || []);
  const nodes = surfaceNodes.map((seq) => Object.freeze({
    seq,
    tokens: conservativeMessageTokens(eventMessage(session, events[seq])),
  }));
  const surfaceTokens = nodes.reduce((total, node) => total + node.tokens, 0);
  const totalTokens = conservativeHeaderTokens(header === undefined ? sessionHeader(session) : header) + surfaceTokens;
  return Object.freeze({
    // Keep the native measurement contract so Core compaction can use this
    // result without knowing that the session predates DSH lifecycle events.
    logRevision: events.length,
    baseline: Object.freeze({ kind: "estimated", tokens: totalTokens }),
    surfaceDeltaTokens: 0,
    totalTokens,
    surfaceTokens,
    nodes: Object.freeze(nodes),
  });
}

/**
 * Compatibility adapter for sessions imported from the old Claude JSONL
 * format.  They are valid conversational history, but have no synthetic DSH
 * `step/start` / `step/end` records around their assistant messages.  Do not
 * feed those sessions to the upstream replay meter: it correctly validates
 * native lifecycle records, but cannot reconstruct a lifecycle that never
 * existed.  All native sessions keep the upstream implementation unchanged.
 */
export class TokenMeter extends UpstreamTokenMeter {
  measure(session, header) {
    if (restoredHistoricalAssistantMessages(session)) {
      return restoredHistoryMeasurement(session, header);
    }
    return super.measure(session, header);
  }
}

export {
  restoredHistoricalAssistantMessages,
  restoredHistoryMeasurement,
};

export default TokenMeter;
