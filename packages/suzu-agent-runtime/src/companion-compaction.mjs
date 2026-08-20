import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import {
  CompactionId,
  ManualCompactionError,
  compactCheckpointSource,
  toolPairingBalancedAfter,
  toolPairingBalancedBefore,
} from "@suzu-lives/suzu-agent-runtime/core/compaction";
import { BasicCompactionEngine } from "@suzu-lives/suzu-agent-runtime/core/compaction-basic";
import {
  BlockAssembler,
  LlmError,
  contentHasImage,
  createUserMessage,
} from "@suzu-lives/suzu-agent-runtime/core/llm";

import { DEFAULT_SUZU_COMPACTION_PROMPT } from "./companion-compaction-prompt.mjs";
import {
  conservativeHeaderTokens,
  conservativeMessageTokens,
} from "./context-token-estimate.mjs";
import { createSuzuAgentLifecycleBridgeTransport } from "./lifecycle-bridge.mjs";

export const name = "suzu-companion-compaction";
export const inject = [];
export const Config = BasicCompactionEngine.Config;

const DEFAULT_AUTOMATIC_THRESHOLD_TOKENS = 15_000;
const DEFAULT_RETAIN_TOKENS = 5_000;
// The regular per-contact threshold can be disabled, but this model-aware
// preflight guard cannot.  Leave room for the configured normal-chat output,
// not merely an arbitrary percentage of the context window.
const MINIMUM_CONTEXT_OUTPUT_RESERVE_TOKENS = 8_192;
const CONTEXT_SAFETY_BUFFER_TOKENS = 4_096;
const MAX_MANUAL_COMPACTION_BATCHES = 128;
// Automatic compaction normally needs only a short checkpoint.  Manual
// recovery can start from a legacy conversation hundreds of thousands of
// tokens long, so it may use more output — but never more than the selected
// model's own reserved output capacity.
const MAX_MANUAL_SUMMARY_TOKENS = 32_768;
const MAX_MANUAL_SUMMARY_RECOVERY_ATTEMPTS = 6;
const MIN_MANUAL_SUMMARY_TOKENS = 256;
// The manual-only output discipline instruction is intentionally counted in
// the input budget even though it is short.  This keeps a near-limit batch
// from crossing a provider boundary because of product-added text.
const MANUAL_SUMMARY_INSTRUCTION_TOKEN_BUFFER = 512;
const CHECKPOINT_PREAMBLE = "This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context. Treat the captured context as established background and build on it without restating it. Continue the conversation directly from the messages that follow, without acknowledging this checkpoint.";
const SUMMARY_OPEN_TAG = "<compacted-summary>";
const SUMMARY_CLOSE_TAG = "</compacted-summary>";

class SurfaceChangedError extends Error {}

function clean(value) {
  return String(value ?? "").trim();
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function positiveInteger(value, fallback) {
  const candidate = Number(value);
  return Number.isSafeInteger(candidate) && candidate > 0 ? candidate : fallback;
}

function safeRequestHeader(session) {
  try {
    return typeof session?.requestHeader === "function" ? session.requestHeader() : {};
  } catch {
    return {};
  }
}

/**
 * Returns a CJK-aware, per-surface estimate compatible with
 * selectSuzuCompactionRange().  Keeping the same node shape lets the native
 * transaction retain a balanced raw tail while the product avoids sending a
 * request that a provider will reject.
 */
export function estimateSuzuContextMeasurement(session) {
  const surfaceNodes = Array.from(session?.surface?.nodes || []);
  const events = Array.isArray(session?.events) ? session.events : [];
  const nodes = surfaceNodes.map((seq) => {
    let message = null;
    try {
      message = typeof session?.deriveEventMessage === "function"
        ? session.deriveEventMessage(events[seq])
        : null;
    } catch {
      message = null;
    }
    return {
      seq,
      tokens: conservativeMessageTokens(message),
    };
  });
  return Object.freeze({
    nodes: Object.freeze(nodes),
    totalTokens: conservativeHeaderTokens(safeRequestHeader(session))
      + nodes.reduce((total, node) => total + node.tokens, 0),
  });
}

/**
 * The compatible adapter exposes the selected model's configured output cap
 * as defaultMaxTokens.  A normal chat request must reserve all of it: a
 * 1,048,576-token model with a 256,000-token completion cap only has about
 * 792k safe input tokens, not 90% of its nominal window.
 */
export function suzuContextBudget(modelInfo) {
  const contextWindow = Number(plainObject(modelInfo).context?.contextWindow);
  if (!Number.isSafeInteger(contextWindow) || contextWindow <= 0) return null;
  const defaultMaxTokens = positiveInteger(plainObject(modelInfo).defaultMaxTokens, 0);
  const outputReserve = Math.max(
    MINIMUM_CONTEXT_OUTPUT_RESERVE_TOKENS,
    defaultMaxTokens,
    Math.floor(contextWindow * 0.1),
  );
  const totalReserve = Math.min(
    contextWindow - 1,
    outputReserve + CONTEXT_SAFETY_BUFFER_TOKENS,
  );
  return Object.freeze({
    contextWindow,
    outputReserve,
    inputLimitTokens: Math.max(1, contextWindow - totalReserve),
  });
}

function boundedError(error) {
  const text = clean(error?.message || error) || "compaction failed";
  return text.length > 2_000 ? `${text.slice(0, 2_000)}…` : text;
}

function errorChain(error) {
  const values = [];
  const seen = new Set();
  let current = error;
  while (current && (typeof current === "object" || typeof current === "function") && !seen.has(current)) {
    values.push(current);
    seen.add(current);
    current = current.cause;
  }
  return values;
}

function summaryFailureKind(error) {
  const chain = errorChain(error);
  for (const entry of chain) {
    const code = clean(entry?.code).toUpperCase();
    const message = clean(entry?.message).toLowerCase();
    if (/summarization produced no text summary content|no usable text/u.test(message)) {
      return "no-text";
    }
    if (/summary is not smaller than the shadowed content/u.test(message)) {
      return "not-smaller";
    }
    if (code === "MAX_TOKENS" || /(?:output|summary|completion).{0,48}(?:limit|token)|max(?:imum)? tokens|token cap/u.test(message)) {
      return "output-limit";
    }
    if (code === "CONTEXT_WINDOW_EXCEEDED" || /(?:maximum )?context (?:length|window)|context.{0,48}(?:exceed|limit)|too many tokens/u.test(message)) {
      return "context-limit";
    }
  }
  return "unknown";
}

function manualSummaryFailureMessage(error) {
  switch (summaryFailureKind(error)) {
    case "output-limit":
      return "会话压缩摘要达到输出上限。";
    case "context-limit":
      return "会话压缩摘要的输入仍超过模型上下文上限。";
    case "no-text":
      return "会话压缩摘要没有返回可用正文。";
    case "not-smaller":
      return "会话压缩摘要没有小于被替换的历史。";
    default:
      return "会话压缩摘要未能完成。";
  }
}

function retryableManualSummaryFailure(error) {
  const kind = summaryFailureKind(error);
  return kind === "output-limit" || kind === "context-limit";
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  if (typeof signal.throwIfAborted === "function") signal.throwIfAborted();
  throw signal.reason || new Error("compaction was cancelled");
}

function combinedSignal(left, right) {
  if (typeof AbortSignal?.any === "function") return AbortSignal.any([left, right]);
  return left?.aborted ? left : right;
}

function sessionIdentifier(agent) {
  return clean(agent?.session?.id || agent?.id);
}

function configuredTarget(agent, config) {
  const configuredProvider = clean(config?.summarizationProvider);
  const configuredModel = clean(config?.summarizationModel);
  if (configuredProvider && configuredModel) {
    return { provider: configuredProvider, model: configuredModel };
  }
  const latest = plainObject(agent?.session?.requestHeader?.()).config;
  const latestProvider = clean(latest?.provider);
  const latestModel = clean(latest?.model);
  if (latestProvider && latestModel) return { provider: latestProvider, model: latestModel };
  const provider = clean(agent?.options?.provider);
  const model = clean(agent?.options?.model);
  return provider && model ? { provider, model } : null;
}

function routedTarget(agent) {
  const latest = plainObject(agent?.session?.requestHeader?.()).config;
  const provider = clean(latest?.provider);
  const model = clean(latest?.model);
  return provider && model ? { provider, model } : null;
}

function normalizedSettings(value) {
  const source = plainObject(value);
  const automatic = plainObject(source.automatic);
  const manual = plainObject(source.manual);
  const prompt = clean(source.prompt) || DEFAULT_SUZU_COMPACTION_PROMPT;
  return Object.freeze({
    prompt,
    automatic: Object.freeze({
      enabled: automatic.enabled === true,
      tokenThreshold: positiveInteger(automatic.tokenThreshold, DEFAULT_AUTOMATIC_THRESHOLD_TOKENS),
      retainTokens: positiveInteger(automatic.retainTokens, DEFAULT_RETAIN_TOKENS),
    }),
    manual: Object.freeze({
      retainTokens: positiveInteger(manual.retainTokens, DEFAULT_RETAIN_TOKENS),
    }),
  });
}

function frameSummary(summary) {
  return [
    { type: "text", text: `${CHECKPOINT_PREAMBLE}\n\n${SUMMARY_OPEN_TAG}` },
    ...summary,
    { type: "text", text: SUMMARY_CLOSE_TAG },
  ];
}

function finishError(finish) {
  switch (finish?.kind) {
    case "error":
    case "aborted": {
      const error = new Error(clean(finish.failure?.message) || "summarization failed");
      error.code = clean(finish.failure?.code) || "SUMMARIZATION_FAILED";
      return error;
    }
    case "max-tokens": {
      const error = new Error("summarization truncated at the token cap (incomplete checkpoint)");
      error.code = "MAX_TOKENS";
      return error;
    }
    default:
      return null;
  }
}

function textSummaryBlocks(blocks) {
  if (contentHasImage(blocks)) {
    throw new LlmError("compaction summary cannot contain image output", "UNSUPPORTED_CONTENT");
  }
  const texts = (Array.isArray(blocks) ? blocks : []).filter((block) => plainObject(block).type === "text");
  if (!texts.some((block) => clean(block.text))) {
    throw new Error("summarization produced no text summary content");
  }
  return texts;
}

/**
 * The same head-anchored, token-tail selection used by Agent Core automatic
 * compaction.  It deliberately returns a positional surface range rather than
 * a numeric interval: replacement checkpoints can make event sequence values
 * non-monotonic in surface order.
 */
export function selectSuzuCompactionRange(session, measurement, retainTokens) {
  const pricedNodes = Array.isArray(measurement?.nodes) ? measurement.nodes : [];
  if (!pricedNodes.length) return null;
  const surfaceNodes = Array.from(session?.surface?.nodes || []);
  if (surfaceNodes.length !== pricedNodes.length || surfaceNodes.some((seq, index) => seq !== pricedNodes[index]?.seq)) {
    throw new Error("compaction: token-meter surface does not match the current session surface");
  }
  let accumulated = 0;
  let keepFromIndex = pricedNodes.length;
  for (let index = pricedNodes.length - 1; index >= 0; index -= 1) {
    accumulated += Number(pricedNodes[index]?.tokens) || 0;
    keepFromIndex = index;
    if (accumulated >= retainTokens) break;
  }
  if (keepFromIndex === 0) return null;
  while (keepFromIndex > 0) {
    if (toolPairingBalancedBefore(session, surfaceNodes[keepFromIndex])) break;
    keepFromIndex -= 1;
  }
  if (keepFromIndex === 0) return null;
  return {
    start: surfaceNodes[0],
    end: surfaceNodes[keepFromIndex - 1],
  };
}

/**
 * Select one safe head batch from the normal manual-compaction range.
 *
 * A long pre-0.2 conversation can itself be larger than the selected model's
 * context window.  Sending that whole range to the summarizer would fail
 * before it can create the first checkpoint.  This keeps the same tail and
 * tool-boundary rules as selectSuzuCompactionRange(), but caps the source
 * input so compactNow() can roll an earlier checkpoint forward in batches.
 */
export function selectSuzuCompactionBatchRange(session, measurement, retainTokens, maxInputTokens) {
  const fullRange = selectSuzuCompactionRange(session, measurement, retainTokens);
  if (!fullRange) return null;
  const pricedNodes = Array.isArray(measurement?.nodes) ? measurement.nodes : [];
  const surfaceNodes = Array.from(session?.surface?.nodes || []);
  const startIndex = surfaceNodes.indexOf(fullRange.start);
  const fullEndIndex = surfaceNodes.indexOf(fullRange.end);
  if (startIndex < 0 || fullEndIndex < startIndex) {
    throw new Error("compaction: selected manual range is not on the current session surface");
  }
  const limit = Number(maxInputTokens);
  if (!Number.isFinite(limit)) {
    return { ...fullRange, hasRemainingRange: false };
  }
  const nodeTokens = pricedNodes.reduce((total, node) => total + (Number(node?.tokens) || 0), 0);
  const headerTokens = Math.max(0, (Number(measurement?.totalTokens) || 0) - nodeTokens);
  const availableNodeTokens = Math.floor(limit) - headerTokens;
  if (availableNodeTokens <= 0) {
    throw new ManualCompactionError(
      "summary",
      "manual compaction prompt and session header leave no room for history in the model context window",
    );
  }
  let accumulated = 0;
  let safeEndIndex = -1;
  for (let index = startIndex; index <= fullEndIndex; index += 1) {
    accumulated += Number(pricedNodes[index]?.tokens) || 0;
    if (accumulated > availableNodeTokens) break;
    if (toolPairingBalancedAfter(session, surfaceNodes[index])) safeEndIndex = index;
  }
  if (safeEndIndex < startIndex) {
    throw new ManualCompactionError(
      "summary",
      "the first balanced history segment is larger than the model context window and cannot be compacted safely",
    );
  }
  return {
    start: surfaceNodes[startIndex],
    end: surfaceNodes[safeEndIndex],
    hasRemainingRange: safeEndIndex < fullEndIndex,
  };
}

function validateSurfaceRange(session, start, end) {
  const nodes = Array.from(session?.surface?.nodes || []);
  const startIndex = nodes.indexOf(start);
  const endIndex = nodes.indexOf(end);
  if (startIndex < 0 || endIndex < 0 || startIndex > endIndex) {
    throw new SurfaceChangedError("compaction: selected surface range is no longer available");
  }
  if (!toolPairingBalancedBefore(session, nodes[startIndex]) || !toolPairingBalancedAfter(session, nodes[endIndex])) {
    throw new SurfaceChangedError("compaction: selected range would split a tool call/result pair");
  }
  return {
    start,
    end,
    startIndex,
    endIndex,
    shadowedSeqs: nodes.slice(startIndex, endIndex + 1),
  };
}

function buildSummarizationInput(session, shadowedSeqs) {
  const header = plainObject(session?.requestHeader?.());
  const events = Array.isArray(session?.events) ? session.events : [];
  const messages = shadowedSeqs
    .map((seq) => session?.deriveEventMessage?.(events[seq]))
    .filter(Boolean);
  return {
    ...(header.system === undefined ? {} : { system: header.system }),
    messages,
  };
}

function inspectCompactionEntryState(events) {
  let openTurn = null;
  let turnKnown = false;
  let unmatchedStart;
  let compactionKnown = false;
  let latestEndSeedSeq;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = plainObject(events[index]);
    if (latestEndSeedSeq === undefined && event.type === "session/end-seed") latestEndSeedSeq = Number(event.seq);
    if (!compactionKnown) {
      if (event.type === "compaction/start") {
        unmatchedStart = event;
        compactionKnown = true;
      } else if (event.type === "compaction/end") {
        compactionKnown = true;
      }
    }
    if (!turnKnown) {
      if (event.type === "turn/start") {
        const turn = Number(plainObject(event.data).turn);
        openTurn = Number.isInteger(turn) ? turn : null;
        turnKnown = true;
      } else if (event.type === "turn/end") {
        turnKnown = true;
      }
    }
    if (turnKnown && compactionKnown && latestEndSeedSeq !== undefined) break;
  }
  return { openTurn, unmatchedStart, latestEndSeedSeq };
}

function assertManualCompactionAvailable(session) {
  const state = inspectCompactionEntryState(Array.isArray(session?.events) ? session.events : []);
  if (state.unmatchedStart && !(state.latestEndSeedSeq > Number(state.unmatchedStart.seq))) {
    throw new ManualCompactionError("busy", "manual compaction: another compaction is already active");
  }
  if (state.openTurn !== null) {
    throw new ManualCompactionError("busy", "manual compaction requires an idle agent");
  }
}

function prepareRange(meter, session, selection) {
  const measurement = meter.measure(session);
  const selectedNodes = measurement.nodes.slice(selection.startIndex, selection.endIndex + 1);
  if (selectedNodes.length !== selection.shadowedSeqs.length
    || selectedNodes.some((node, index) => node?.seq !== selection.shadowedSeqs[index])) {
    throw new SurfaceChangedError("compaction: selected surface changed before summarization began");
  }
  return {
    ...selection,
    measurement,
    selectedNodes,
    shadowedTokenCount: selectedNodes.reduce((total, node) => total + (Number(node?.tokens) || 0), 0),
    input: buildSummarizationInput(session, selection.shadowedSeqs),
  };
}

function assertSelectedRangeUnchanged(meter, session, prepared) {
  const current = validateSurfaceRange(session, prepared.start, prepared.end);
  if (!isDeepStrictEqual(current.shadowedSeqs, prepared.shadowedSeqs)) {
    throw new SurfaceChangedError("compaction: selected range changed during summarization");
  }
  const currentNodes = meter.measure(session).nodes.slice(current.startIndex, current.endIndex + 1);
  if (!isDeepStrictEqual(currentNodes, prepared.selectedNodes)) {
    throw new SurfaceChangedError("compaction: selected range was rewritten during summarization");
  }
}

function manualFailure(error, stage) {
  if (error instanceof ManualCompactionError) return error;
  if (stage === "commit") {
    return new ManualCompactionError("commit", "manual compaction did not finish cleanly", { cause: error });
  }
  if (error instanceof SurfaceChangedError) {
    return new ManualCompactionError("changed", "the compacted history changed during manual compaction", { cause: error });
  }
  return new ManualCompactionError("summary", manualSummaryFailureMessage(error), { cause: error });
}

async function compactManualRange({
  agent,
  engine,
  range,
  signal,
  sourceCommandId,
  summaryMaxTokens,
}) {
  const session = agent.session;
  const meter = engine.ctx.tokenMeter;
  throwIfAborted(signal);
  const selection = validateSurfaceRange(session, range.start, range.end);
  assertManualCompactionAvailable(session);
  const compactionId = CompactionId(randomUUID());
  const lifecycle = {
    compactionId,
    ...(sourceCommandId === undefined ? {} : { sourceCommandId }),
    turn: null,
  };
  const startEvent = session.append("compaction/start", lifecycle);
  let failure = null;
  let result = null;
  let closed = false;
  let closing = false;
  let stage = "summary";
  try {
    const prepared = prepareRange(meter, session, selection);
    // A stopped model response must still leave enough room for the framed
    // checkpoint itself.  Bound the manual output to a fraction of the range
    // it replaces, so a small eligible prefix cannot become larger merely
    // because the model was more verbose than the source.
    const sourceRelativeSummaryLimit = Math.max(
      MIN_MANUAL_SUMMARY_TOKENS,
      Math.floor(prepared.shadowedTokenCount * 0.4),
    );
    const effectiveSummaryMaxTokens = Number.isSafeInteger(summaryMaxTokens) && summaryMaxTokens > 0
      ? Math.min(summaryMaxTokens, sourceRelativeSummaryLimit)
      : undefined;
    const summaryResult = await engine.summarize(prepared.input, agent, signal, {
      manual: true,
      ...(effectiveSummaryMaxTokens === undefined
        ? {}
        : { maxTokens: effectiveSummaryMaxTokens }),
    });
    throwIfAborted(signal);
    const checkpointMessage = createUserMessage({
      content: frameSummary(summaryResult.summary),
      source: compactCheckpointSource(compactionId, sourceCommandId),
    });
    const summaryTokens = meter.estimateMessage(checkpointMessage);
    if (summaryTokens >= prepared.shadowedTokenCount) {
      throw new Error(`summary is not smaller than the shadowed content (${summaryTokens} estimated framed tokens >= ${prepared.shadowedTokenCount})`);
    }
    assertSelectedRangeUnchanged(meter, session, prepared);
    stage = "commit";
    const provenance = summaryResult.llmStreamCall === true
      ? { rawOutput: summaryResult.rawOutput, llmStreamCall: true }
      : summaryResult.rawOutput === undefined ? {} : { rawOutput: summaryResult.rawOutput };
    const summaryEvent = session.append("compaction/summary", {
      compactionId,
      ...(sourceCommandId === undefined ? {} : { sourceCommandId }),
      summary: summaryResult.summary,
      ...provenance,
      shadowedRange: { start: prepared.start, end: prepared.end },
      shadowedSeqs: [...prepared.shadowedSeqs],
      shadowedTokenCount: prepared.shadowedTokenCount,
      provider: summaryResult.provider,
      model: summaryResult.model,
      ...(summaryResult.maxTokens === undefined ? {} : { maxTokens: summaryResult.maxTokens }),
      ...(summaryResult.usage === undefined ? {} : { usage: summaryResult.usage }),
    });
    session.append("user/message", checkpointMessage, {
      surfaceOp: { op: "replace", start: prepared.start, end: prepared.end },
      sourceEventSeqs: [startEvent.seq, summaryEvent.seq, ...prepared.shadowedSeqs],
    });
    closing = true;
    const endEvent = session.append("compaction/end", lifecycle);
    closed = true;
    result = {
      compactionId,
      ...(sourceCommandId === undefined ? {} : { sourceCommandId }),
      startSeq: startEvent.seq,
      summarySeq: summaryEvent.seq,
      endSeq: endEvent.seq,
      summary: summaryResult.summary,
      shadowedRange: { start: prepared.start, end: prepared.end },
      shadowedSeqs: [...prepared.shadowedSeqs],
      shadowedTokenCount: prepared.shadowedTokenCount,
    };
  } catch (error) {
    failure = { error, stage: closing ? "commit" : stage };
    if (!closing) {
      closing = true;
      try {
        session.append("compaction/end", { ...lifecycle, error: boundedError(error) });
        closed = true;
      } catch (closeError) {
        failure = { error: closeError, stage: "commit" };
      }
    }
  }
  if (closed) {
    try {
      await engine.ctx.sessions.flush(session);
    } catch (error) {
      if (!failure) failure = { error, stage: "persistence" };
    }
  }
  throwIfAborted(signal);
  if (failure) {
    if (failure.stage === "persistence") {
      throw new ManualCompactionError("persistence", "manual compaction finished but could not be saved", { cause: failure.error });
    }
    throw manualFailure(failure.error, failure.stage);
  }
  if (!result) throw new ManualCompactionError("commit", "manual compaction committed without a result");
  return result;
}

/**
 * Product-owned Agent Core compaction backend.
 *
 * The selected basic engine already provides the correct automatic transaction and
 * token accounting.  Suzu supplies per-contact settings at runtime and
 * overrides only its manual selection policy: the upstream `/compact` command
 * otherwise compacts all possible old context, whereas Suzu deliberately
 * keeps the configured recent raw tail (the original rewind behavior).
 */
export class SuzuCompanionCompactionEngine extends BasicCompactionEngine {
  static inject = BasicCompactionEngine.inject;

  static Config = BasicCompactionEngine.Config;

  constructor(ctx, config = {}) {
    super(ctx, config);
    this.baseConfig = this.config;
    this.settingsContext = new AsyncLocalStorage();
    this.transport = createSuzuAgentLifecycleBridgeTransport();
    Object.defineProperty(this, "config", {
      configurable: true,
      enumerable: true,
      get: () => this.settingsContext.getStore()?.config || this.baseConfig,
    });
  }

  async settingsFor(agent, mode, signal) {
    throwIfAborted(signal);
    const sessionId = sessionIdentifier(agent);
    if (!sessionId) return null;
    const reply = await this.transport.request("CompactionSettings", { sessionId, mode });
    throwIfAborted(signal);
    const result = plainObject(reply?.result);
    if (reply?.available !== true || result.available !== true) return null;
    return normalizedSettings(result);
  }

  async automaticConfig(agent, settings, signal) {
    const budget = await this.contextBudgetFor(agent, signal);
    if (!budget) return this.baseConfig;
    const { contextWindow, inputLimitTokens } = budget;
    const thresholdTokens = Math.min(
      settings.automatic.tokenThreshold,
      inputLimitTokens,
    );
    const retainTokens = settings.automatic.retainTokens;
    if (retainTokens >= thresholdTokens) {
      throw new Error(`Suzu compaction cannot retain ${retainTokens} tokens with a ${thresholdTokens}-token threshold`);
    }
    const { retainRatio: _retainRatio, ...base } = this.baseConfig;
    return Object.freeze({
      ...base,
      thresholdRatio: thresholdTokens / contextWindow,
      retainTokens,
      modelPolicies: [],
      auto: true,
    });
  }

  async safetyConfig(agent, settings, signal) {
    const budget = await this.contextBudgetFor(agent, signal);
    if (!budget) return this.baseConfig;
    const { contextWindow, inputLimitTokens: thresholdTokens } = budget;
    // A contact may have saved a recent-tail size that makes sense for its
    // regular threshold but not for a small model.  The safety path must still
    // be able to compact, so cap the tail just below its own threshold.
    const retainTokens = Math.min(
      settings.automatic.retainTokens,
      Math.max(0, thresholdTokens - 1),
    );
    const { retainRatio: _retainRatio, ...base } = this.baseConfig;
    return Object.freeze({
      ...base,
      thresholdRatio: thresholdTokens / contextWindow,
      retainTokens,
      modelPolicies: [],
      auto: true,
    });
  }

  async contextBudgetFor(agent, signal) {
    const target = routedTarget(agent);
    if (!target) return null;
    const info = await this.ctx.llm.resolveModelInfo(target.provider, target.model, signal);
    return suzuContextBudget(info);
  }

  async conservativePressureRange(agent, config, signal) {
    const budget = await this.contextBudgetFor(agent, signal);
    if (!budget) return null;
    const configuredThreshold = Math.max(
      1,
      Math.floor(budget.contextWindow * Number(config?.thresholdRatio || 0)),
    );
    const thresholdTokens = Math.min(configuredThreshold, budget.inputLimitTokens);
    const conservative = estimateSuzuContextMeasurement(agent.session);
    const nativeTokens = Number(this.ctx.tokenMeter.measure(agent.session).totalTokens) || 0;
    if (Math.max(conservative.totalTokens, nativeTokens) < thresholdTokens) return null;
    return selectSuzuCompactionRange(
      agent.session,
      conservative,
      positiveInteger(config?.retainTokens, DEFAULT_RETAIN_TOKENS),
    );
  }

  async configForAutomaticTrigger(agent, trigger, settings, signal) {
    // Provider-confirmed overflow is the final recovery path. The basic engine
    // engine deliberately ignores its normal threshold and retained tail here.
    if (trigger === "context-overflow") return this.baseConfig;
    // The user switch disables only the early, fixed-token policy.  A
    // model-relative guard remains active so the next request is compacted
    // before reaching the provider's context-window error.
    if (!settings.automatic.enabled) return this.safetyConfig(agent, settings, signal);
    return this.automaticConfig(agent, settings, signal);
  }

  async compactIfNeeded(agent, trigger, signal) {
    const settings = await this.settingsFor(agent, "automatic", signal);
    if (!settings) return null;
    const config = await this.configForAutomaticTrigger(agent, trigger, settings, signal);
    return this.settingsContext.run({ settings, config }, async () => {
      // Run before the upstream pressure test.  Its generic characters/4
      // meter can be dramatically lower than provider token counts for CJK
      // conversations, in which case waiting for the upstream threshold lets
      // the next normal chat request overflow first.
      if (trigger === "pressure") {
        const range = await this.conservativePressureRange(agent, config, signal);
        if (range) return super.compactRegion(range.start, range.end, agent, signal);
      }
      return super.compactIfNeeded(agent, trigger, signal);
    });
  }

  async summarize(input, agent, signal, summaryOptions = {}) {
    const scoped = this.settingsContext.getStore();
    const config = scoped?.config || this.baseConfig;
    const prompt = clean(scoped?.settings?.prompt) || DEFAULT_SUZU_COMPACTION_PROMPT;
    const target = configuredTarget(agent, config);
    if (!target) {
      throw new Error("no provider/model available for companion compaction");
    }
    const maxTokens = positiveInteger(summaryOptions?.maxTokens, config.maxTokens);
    const outputDiscipline = summaryOptions?.manual === true
      ? `这是一段分批压缩。只保留继续理解关系所必需的信息，合并重复内容，绝不能逐轮复述。请将正文控制在约 ${Math.max(128, Math.floor(maxTokens * 0.6))} 个中文字符（或等量的简短英文）以内。`
      : "";
    const assembler = new BlockAssembler();
    const messages = [
      ...(Array.isArray(input?.messages) ? input.messages : []),
      createUserMessage({
        content: [{ type: "text", text: [prompt, outputDiscipline].filter(Boolean).join("\n\n") }],
        source: { kind: "plugin", plugin: name, form: "compaction-prompt" },
      }),
    ];
    const requestOptions = {
      provider: target.provider,
      model: target.model,
      messages,
      ...(input?.system === undefined ? {} : { system: input.system }),
      // A checkpoint is text-only maintenance. Passing the contact's normal
      // tool catalogue gives a long-context model an unnecessary tool-call
      // path and can leave the summarizer with no usable text at all.
      tools: [],
      temperature: 0,
      maxTokens,
      sessionId: sessionIdentifier(agent),
      purpose: "compaction",
      ...(signal === undefined ? {} : { signal }),
    };
    for await (const chunk of this.ctx.llm.stream(requestOptions)) assembler.push(chunk);
    const error = finishError(assembler.finish);
    if (error) throw error;
    const rawOutput = assembler.blocks();
    const summary = textSummaryBlocks(rawOutput);
    return {
      summary,
      rawOutput,
      llmStreamCall: true,
      provider: target.provider,
      model: target.model,
      maxTokens,
      ...(assembler.usage === undefined ? {} : { usage: assembler.usage }),
    };
  }

  async manualInputLimit(agent, settings, signal) {
    const budget = await this.contextBudgetFor(agent, signal);
    const promptTokens = conservativeMessageTokens({
      content: [{ type: "text", text: clean(settings?.prompt) || DEFAULT_SUZU_COMPACTION_PROMPT }],
    });
    // `inputLimitTokens` already reserves the normal-chat completion and a
    // provider buffer.  Reserving the compaction prompt inside that budget
    // means a batch is safe even when the normal model output cap is much
    // larger than the manual summary's model-aware output cap.
    return budget
      ? Math.max(1, budget.inputLimitTokens - promptTokens - MANUAL_SUMMARY_INSTRUCTION_TOKEN_BUFFER)
      : Number.POSITIVE_INFINITY;
  }

  async manualSummaryTokenLimit(agent, signal) {
    const budget = await this.contextBudgetFor(agent, signal);
    if (!budget) return positiveInteger(this.baseConfig?.maxTokens, 8_192);
    return Math.max(1, Math.min(MAX_MANUAL_SUMMARY_TOKENS, Math.floor(budget.outputReserve)));
  }

  async manualBatchRange(agent, settings, signal, inputLimitOverride = Number.POSITIVE_INFINITY) {
    const availableInputTokens = await this.manualInputLimit(agent, settings, signal);
    const requested = Number(inputLimitOverride);
    const maxInputTokens = Number.isFinite(requested)
      ? Math.min(availableInputTokens, Math.max(1, Math.floor(requested)))
      : availableInputTokens;
    return selectSuzuCompactionBatchRange(
      agent.session,
      estimateSuzuContextMeasurement(agent.session),
      settings.manual.retainTokens,
      maxInputTokens,
    );
  }

  compactNow(agent, signal, sourceCommandId) {
    throwIfAborted(signal);
    try {
      return agent.runMaintenance(async (agentSignal) => {
        const operationSignal = combinedSignal(agentSignal, signal);
        try {
          throwIfAborted(operationSignal);
          const settings = await this.settingsFor(agent, "manual", operationSignal);
          if (!settings) {
            throw new ManualCompactionError("summary", "Suzu compaction settings are unavailable for this session");
          }
          return await this.settingsContext.run({ settings, config: this.baseConfig }, async () => {
            let lastResult = null;
            let batchCount = 0;
            let inputLimit = await this.manualInputLimit(agent, settings, operationSignal);
            const summaryMaxTokens = await this.manualSummaryTokenLimit(agent, operationSignal);
            let recoveryAttempts = 0;
            let failedRangeKey = "";
            while (batchCount < MAX_MANUAL_COMPACTION_BATCHES) {
              throwIfAborted(operationSignal);
              const range = await this.manualBatchRange(agent, settings, operationSignal, inputLimit);
              if (!range) return lastResult;
              const rangeKey = `${range.start}:${range.end}`;
              if (failedRangeKey && failedRangeKey === rangeKey) {
                throw new ManualCompactionError(
                  "summary",
                  "会话压缩无法将第一个可替换片段缩小到模型可处理的范围。",
                );
              }
              try {
                lastResult = await compactManualRange({
                  agent,
                  engine: this,
                  range,
                  signal: operationSignal,
                  sourceCommandId,
                  summaryMaxTokens,
                });
                failedRangeKey = "";
              } catch (error) {
                const canReduceBatch = retryableManualSummaryFailure(error)
                  && recoveryAttempts < MAX_MANUAL_SUMMARY_RECOVERY_ATTEMPTS
                  && Number.isFinite(inputLimit)
                  && inputLimit > 1;
                if (!canReduceBatch) throw error;
                const nextInputLimit = Math.max(1, Math.floor(inputLimit / 2));
                if (nextInputLimit >= inputLimit) throw error;
                inputLimit = nextInputLimit;
                recoveryAttempts += 1;
                failedRangeKey = rangeKey;
                continue;
              }
              batchCount += 1;
              // When this batch reached the usual retained tail, it has the
              // same result as the original one-shot manual compaction.  A
              // second pass would only re-summarize the newly made checkpoint.
              if (!range.hasRemainingRange) {
                return { ...lastResult, batchCount };
              }
            }
            throw new ManualCompactionError(
              "summary",
              `manual compaction stopped after ${MAX_MANUAL_COMPACTION_BATCHES} safe batches; retry to continue`,
            );
          });
        } catch (error) {
          if (agentSignal?.aborted && operationSignal?.reason === agentSignal.reason) {
            throw new ManualCompactionError("cancelled", "manual compaction was cancelled", { cause: error });
          }
          throwIfAborted(operationSignal);
          throw error;
        }
      });
    } catch (error) {
      throw new ManualCompactionError("busy", "manual compaction requires an idle agent with no waking queued work", { cause: error });
    }
  }
}

export function apply(ctx, config = {}) {
  ctx.plugin(SuzuCompanionCompactionEngine, config);
}
