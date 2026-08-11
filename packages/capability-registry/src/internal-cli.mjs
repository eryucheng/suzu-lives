import { DirectImageVisionError, runDirectImageVision } from "@suzu-lives/media-understanding/direct-image-vision";
import { DirectVideoUnderstandingError, runDirectVideoUnderstanding } from "@suzu-lives/media-understanding/direct-video-understanding";

/**
 * The stable, Agent-host-neutral contract for Suzu-owned capability commands.
 *
 * An Agent adapter only needs to provide its workspace identity, data root,
 * ledger path, and an already-resolved software connection. No Claude-specific
 * project layout, prompts, or host configuration is part of this contract.
 */
export const INTERNAL_CAPABILITY_CLI_SCHEMA_VERSION = 1;

export class InternalCapabilityCliError extends Error {
  constructor(message, { code = "invalid_request", exitCode = 4 } = {}) {
    super(message);
    this.name = "InternalCapabilityCliError";
    this.code = code;
    this.exitCode = exitCode;
  }
}

function clean(value) {
  return String(value ?? "").trim();
}

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function requiredText(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new InternalCapabilityCliError(`${label} 必须是非空字符串。`);
  }
  return value.trim();
}

function optionalText(value, label) {
  if (value === undefined) return "";
  if (typeof value !== "string") throw new InternalCapabilityCliError(`${label} 必须是字符串。`);
  return value.trim();
}

function optionalBoolean(value, label) {
  if (value === undefined) return false;
  if (typeof value !== "boolean") throw new InternalCapabilityCliError(`${label} 必须是布尔值。`);
  return value;
}

function assertKnownKeys(value, allowed, label) {
  if (!plainObject(value)) throw new InternalCapabilityCliError(`${label} 必须是 JSON 对象。`);
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown) throw new InternalCapabilityCliError(`${label} 不支持字段 ${unknown}。`);
  return value;
}

function parseInputJson(value) {
  const source = clean(value);
  if (!source) throw new InternalCapabilityCliError("--input-json 必须提供一个 JSON 对象。");
  try {
    const parsed = JSON.parse(source);
    if (!plainObject(parsed)) throw new Error("顶层不是对象");
    return parsed;
  } catch (error) {
    throw new InternalCapabilityCliError(`--input-json 无效：${error.message}`);
  }
}

function normalizeImageVisionAnalyzeInput(value) {
  const source = assertKnownKeys(value, ["path", "question", "configPath", "noRetry"], "image-vision 输入");
  return Object.freeze({
    path: requiredText(source.path, "input.path"),
    question: optionalText(source.question, "input.question"),
    configPath: optionalText(source.configPath, "input.configPath"),
    noRetry: optionalBoolean(source.noRetry, "input.noRetry"),
  });
}

function normalizeVideoUnderstandingAnalyzeInput(value) {
  const source = assertKnownKeys(value, ["source", "question", "cacheKey", "configPath", "noCache", "keepClip", "dryRun"], "video-understanding 输入");
  return Object.freeze({
    source: requiredText(source.source, "input.source"),
    question: optionalText(source.question, "input.question"),
    cacheKey: optionalText(source.cacheKey, "input.cacheKey"),
    configPath: optionalText(source.configPath, "input.configPath"),
    noCache: optionalBoolean(source.noCache, "input.noCache"),
    keepClip: optionalBoolean(source.keepClip, "input.keepClip"),
    dryRun: optionalBoolean(source.dryRun, "input.dryRun"),
  });
}

const CAPABILITY_ACTIONS = Object.freeze({
  "image-vision": Object.freeze({ analyze: normalizeImageVisionAnalyzeInput }),
  "video-understanding": Object.freeze({ analyze: normalizeVideoUnderstandingAnalyzeInput }),
});

function definitionFor(capabilityId, action) {
  const id = clean(capabilityId).toLowerCase();
  const actions = CAPABILITY_ACTIONS[id];
  if (!actions) {
    throw new InternalCapabilityCliError(`未找到内部能力 ${clean(capabilityId) || "（空）"}。`, { code: "capability_not_found" });
  }
  const normalizedAction = clean(action).toLowerCase();
  const normalizeInput = actions[normalizedAction];
  if (!normalizeInput) {
    throw new InternalCapabilityCliError(`${id} 不支持动作 ${clean(action) || "（空）"}。`, { code: "action_not_supported" });
  }
  return { capabilityId: id, action: normalizedAction, normalizeInput };
}

/** Returns the canonical command shown by any Agent adapter. */
export function internalCapabilityCliUsage({ launcher = "suzu-lives", capabilityId, action = "analyze" } = {}) {
  const definition = definitionFor(capabilityId, action);
  return `${clean(launcher) || "suzu-lives"} capability ${definition.capabilityId} ${definition.action} --input-json '<JSON>'`;
}

/**
 * Parses the shared outer command shape. A host owns shell tokenization and
 * passes its positional/options objects here; a new capability only adds an
 * input normalizer plus its executor below.
 */
export function parseInternalCapabilityRequest({ positional, options } = {}) {
  const positionals = Array.isArray(positional) ? positional : [];
  const parsedOptions = plainObject(options) ? options : {};
  if (positionals.length !== 2) {
    throw new InternalCapabilityCliError("用法：suzu-lives capability <capability-id> <action> --input-json '<JSON>'。");
  }
  const unknownOption = Object.keys(parsedOptions).find((key) => !["input-json", "data-root", "workspace-root"].includes(key));
  if (unknownOption) throw new InternalCapabilityCliError(`capability 不支持选项 --${unknownOption}。`);
  const definition = definitionFor(positionals[0], positionals[1]);
  return Object.freeze({
    capabilityId: definition.capabilityId,
    action: definition.action,
    input: definition.normalizeInput(parseInputJson(parsedOptions["input-json"])),
    dataRoot: optionalText(parsedOptions["data-root"], "--data-root"),
    workspaceRoot: optionalText(parsedOptions["workspace-root"], "--workspace-root"),
  });
}

export function internalCapabilitySuccess({ capabilityId, action, result } = {}) {
  const definition = definitionFor(capabilityId, action);
  return {
    schemaVersion: INTERNAL_CAPABILITY_CLI_SCHEMA_VERSION,
    status: "ok",
    capabilityId: definition.capabilityId,
    action: definition.action,
    result,
  };
}

export function internalCapabilityFailure({ capabilityId = "", action = "", code = "internal_error", message = "内部能力执行失败。" } = {}) {
  return {
    schemaVersion: INTERNAL_CAPABILITY_CLI_SCHEMA_VERSION,
    status: "error",
    ...(clean(capabilityId) ? { capabilityId: clean(capabilityId).toLowerCase() } : {}),
    ...(clean(action) ? { action: clean(action).toLowerCase() } : {}),
    error: {
      code: clean(code) || "internal_error",
      message: clean(message) || "内部能力执行失败。",
    },
  };
}

function requiredRuntimeText(value, label) {
  const text = clean(value);
  if (!text) throw new InternalCapabilityCliError(`内部运行上下文缺少 ${label}。`, { code: "runtime_context_missing", exitCode: 10 });
  return text;
}

function normalizedConnection(value) {
  if (!plainObject(value)) return {};
  return {
    key: optionalText(value.key, "connection.key"),
    baseUrl: optionalText(value.baseUrl, "connection.baseUrl"),
    model: optionalText(value.model, "connection.model"),
  };
}

/**
 * Executes a normalized request with a host-supplied runtime context. This is
 * the reusable seam for future Claude, Hermes, or other Agent adapters.
 */
export async function executeInternalCapability({ request, runtime } = {}) {
  if (!request || typeof request !== "object") {
    throw new InternalCapabilityCliError("内部能力请求无效。", { code: "invalid_request" });
  }
  const dataRoot = requiredRuntimeText(runtime?.dataRoot, "dataRoot");
  const agentId = requiredRuntimeText(runtime?.agentId, "agentId");
  const ledgerPath = requiredRuntimeText(runtime?.ledgerPath, "ledgerPath");
  const connection = normalizedConnection(runtime?.connection);
  const environment = plainObject(runtime?.environment) ? runtime.environment : process.env;

  if (request.capabilityId === "image-vision" && request.action === "analyze") {
    const response = await runDirectImageVision({
      dataRoot,
      ledgerPath,
      agentId,
      imagePath: request.input.path,
      question: request.input.question,
      configPath: request.input.configPath,
      noRetry: request.input.noRetry,
      environment: {
        ...environment,
        ...(connection.key ? { VISION_API_KEY: connection.key } : {}),
        ...(connection.baseUrl ? { VISION_BASE_URL: connection.baseUrl } : {}),
        ...(connection.model ? { VISION_MODEL: connection.model } : {}),
      },
    });
    return { answer: response.answer };
  }

  if (request.capabilityId === "video-understanding" && request.action === "analyze") {
    return runDirectVideoUnderstanding({
      dataRoot,
      ledgerPath,
      agentId,
      videoPath: request.input.source,
      question: request.input.question,
      cacheKey: request.input.cacheKey,
      configPath: request.input.configPath,
      noCache: request.input.noCache,
      keepClip: request.input.keepClip,
      dryRun: request.input.dryRun,
      environment: {
        ...environment,
        ...(connection.key ? { VIDEO_UNDERSTANDING_API_KEY: connection.key } : {}),
        ...(connection.baseUrl ? { VIDEO_UNDERSTANDING_BASE_URL: connection.baseUrl } : {}),
        ...(connection.model ? { VIDEO_UNDERSTANDING_MODEL: connection.model } : {}),
      },
    });
  }

  throw new InternalCapabilityCliError(`未找到内部能力 ${request.capabilityId}。`, { code: "capability_not_found" });
}

function cleanCapabilityErrorMessage(value) {
  return String(value || "")
    .trim()
    .replace(/^VISION_ERROR[：:]\s*/u, "")
    || "内部能力执行失败。";
}

/** Converts executor errors into the stable public JSON error vocabulary. */
export function internalCapabilityErrorDetails(error) {
  if (error instanceof InternalCapabilityCliError) {
    return { code: error.code, message: error.message, exitCode: error.exitCode };
  }
  if (error instanceof DirectVideoUnderstandingError) {
    const stderr = String(error.stderr || "").trim();
    try {
      const parsed = JSON.parse(stderr);
      if (parsed && typeof parsed === "object") {
        return {
          code: String(parsed.code || "video_understanding_error"),
          message: String(parsed.message || error.message || "视频理解执行失败。"),
          exitCode: error.exitCode || 4,
        };
      }
    } catch { /* Some runtime failures have plain-text diagnostics. */ }
    return {
      code: error.exitCode === 4 ? "invalid_request" : "video_understanding_error",
      message: cleanCapabilityErrorMessage(error.message || stderr),
      exitCode: error.exitCode || 4,
    };
  }
  if (error instanceof DirectImageVisionError) {
    const message = cleanCapabilityErrorMessage(error.message || error.stderr);
    return {
      code: /VISION_REFUSED/iu.test(message)
        ? "vision_refused"
        : error.exitCode === 5
          ? "upstream_error"
          : error.exitCode === 4
            ? "invalid_request"
            : "image_vision_error",
      message,
      exitCode: error.exitCode || 4,
    };
  }
  return {
    code: "internal_error",
    message: cleanCapabilityErrorMessage(error?.message || error),
    exitCode: 10,
  };
}
