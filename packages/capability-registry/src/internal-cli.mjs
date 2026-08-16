import { resolveAgentDataRoot } from "@suzu-lives/agent-registry";
import { AgentImageGenerationError, listComfyWorkflows, runAgentImageGeneration, validateComfyWorkflows } from "@suzu-lives/agent-image-generation";
import { ImageWorkbenchError } from "@suzu-lives/image-workbench";
import { DirectImageVisionError, runDirectImageVision } from "@suzu-lives/media-understanding/direct-image-vision";
import { DirectVideoUnderstandingError, runDirectVideoUnderstanding } from "@suzu-lives/media-understanding/direct-video-understanding";
import { loadPhoneCameraComfyConnection, loadPhoneConfig, PhoneCameraError, takePhonePhoto } from "@suzu-lives/phone-camera";
import { DirectVoiceMessageError, runDirectVoiceMessage } from "@suzu-lives/voice-message/direct-voice-message";

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

function optionalBoundedText(value, label, maximum) {
  const text = optionalText(value, label);
  if ([...text].length > maximum) {
    throw new InternalCapabilityCliError(`${label} 不能超过 ${maximum} 个字符。`);
  }
  return text.replace(/\s+/gu, " ");
}

function optionalBoolean(value, label) {
  if (value === undefined) return false;
  if (typeof value !== "boolean") throw new InternalCapabilityCliError(`${label} 必须是布尔值。`);
  return value;
}

function optionalSafeInteger(value, label, { minimum = 0, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  if (value === undefined) return null;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new InternalCapabilityCliError(label + " 必须是 " + minimum + " 到 " + maximum + " 之间的整数。");
  }
  return value;
}

function optionalChoice(value, label, choices) {
  const selected = optionalText(value, label);
  if (selected && !choices.includes(selected)) {
    throw new InternalCapabilityCliError(label + " 必须是 " + choices.join("、") + " 之一。");
  }
  return selected;
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

function normalizeImageGenerationReferences(value) {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value) || value.length > 16) {
    throw new InternalCapabilityCliError("input.references 必须是至多 16 项的数组。");
  }
  return Object.freeze(value.map((entry, index) => {
    const label = "input.references[" + index + "]";
    const source = assertKnownKeys(entry, ["path", "role"], label);
    const role = optionalChoice(source.role, label + ".role", ["identity", "location", "object", "style"]) || "object";
    return Object.freeze({
      path: requiredText(source.path, label + ".path"),
      role,
    });
  }));
}

function normalizeImageGenerationGenerateInput(value) {
  const source = assertKnownKeys(value, ["prompt", "backend", "workflow", "size", "seed", "references", "outputDirectory", "configPath"], "image-generation 输入");
  return Object.freeze({
    prompt: requiredText(source.prompt, "input.prompt"),
    backend: optionalChoice(source.backend, "input.backend", ["api", "comfyui"]),
    workflow: optionalText(source.workflow, "input.workflow"),
    size: optionalText(source.size, "input.size"),
    seed: optionalSafeInteger(source.seed, "input.seed"),
    references: normalizeImageGenerationReferences(source.references),
    outputDirectory: optionalText(source.outputDirectory, "input.outputDirectory"),
    configPath: optionalText(source.configPath, "input.configPath"),
  });
}

function normalizeImageGenerationWorkflowInput(value) {
  const source = assertKnownKeys(value, ["configPath"], "image-generation 输入");
  return Object.freeze({ configPath: optionalText(source.configPath, "input.configPath") });
}

function normalizeReferenceIds(value) {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value) || value.length > 16) {
    throw new InternalCapabilityCliError("input.referenceIds 必须是至多 16 项的数组。");
  }
  return Object.freeze(value.map((item, index) => {
    const label = "input.referenceIds[" + index + "]";
    const source = assertKnownKeys(item, ["scope", "id"], label);
    return Object.freeze({
      scope: optionalChoice(requiredText(source.scope, label + ".scope"), label + ".scope", ["shared", "contact"]),
      id: requiredText(source.id, label + ".id"),
    });
  }));
}

function normalizePhoneCameraGenerateInput(value) {
  const source = assertKnownKeys(value, ["shot", "scene", "referenceIds", "backend", "workflow", "size", "seed", "outputDirectory", "configPath", "dryRun"], "phone-camera 输入");
  return Object.freeze({
    shot: optionalChoice(requiredText(source.shot, "input.shot"), "input.shot", ["rear", "selfie", "mirror"]),
    scene: requiredText(source.scene, "input.scene"),
    referenceIds: normalizeReferenceIds(source.referenceIds),
    backend: optionalChoice(source.backend, "input.backend", ["api", "comfyui"]),
    workflow: optionalText(source.workflow, "input.workflow"),
    size: optionalText(source.size, "input.size"),
    seed: optionalSafeInteger(source.seed, "input.seed"),
    outputDirectory: optionalText(source.outputDirectory, "input.outputDirectory"),
    configPath: optionalText(source.configPath, "input.configPath"),
    dryRun: optionalBoolean(source.dryRun, "input.dryRun"),
  });
}

function normalizeVoiceMessageInput(value, { inspect = false } = {}) {
  const source = assertKnownKeys(value, inspect ? ["configPath", "timeoutMs"] : ["text", "audioPath", "configPath", "timeoutMs"], "voice-message 输入");
  const text = inspect ? "" : optionalText(source.text, "input.text");
  const audioPath = inspect ? "" : optionalText(source.audioPath, "input.audioPath");
  if (!inspect && (Boolean(text) === Boolean(audioPath))) {
    throw new InternalCapabilityCliError("input.text 与 input.audioPath 必须且只能提供一个。");
  }
  return Object.freeze({
    text,
    audioPath,
    configPath: optionalText(source.configPath, "input.configPath"),
    timeoutMs: optionalSafeInteger(source.timeoutMs, "input.timeoutMs", { minimum: 1, maximum: 600000 }),
  });
}

function normalizeVoiceCallRequestInput(value) {
  const source = assertKnownKeys(value, ["reason"], "voice-call 输入");
  return Object.freeze({
    reason: optionalBoundedText(source.reason, "input.reason", 240),
  });
}

const CAPABILITY_ACTIONS = Object.freeze({
  "image-vision": Object.freeze({ analyze: normalizeImageVisionAnalyzeInput }),
  "video-understanding": Object.freeze({ analyze: normalizeVideoUnderstandingAnalyzeInput }),
  "image-generation": Object.freeze({
    generate: normalizeImageGenerationGenerateInput,
    "list-workflows": normalizeImageGenerationWorkflowInput,
    "validate-workflows": normalizeImageGenerationWorkflowInput,
  }),
  "phone-camera": Object.freeze({ generate: normalizePhoneCameraGenerateInput }),
  "voice-message": Object.freeze({
    generate: (value) => normalizeVoiceMessageInput(value),
    inspect: (value) => normalizeVoiceMessageInput(value, { inspect: true }),
  }),
  "voice-call": Object.freeze({ request: normalizeVoiceCallRequestInput }),
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
  const apiKey = optionalText(value.apiKey ?? value.key, "connection.apiKey");
  // Named DashScope connections intentionally store 0 when they do not own a
  // request-timeout setting.  Runtime connections are optional, so translate
  // that storage sentinel back to an omitted value before validating it.
  const timeoutMs = value.timeoutMs === 0
    ? null
    : optionalSafeInteger(value.timeoutMs, "connection.timeoutMs", { minimum: 1, maximum: 600000 });
  return {
    apiKey,
    key: apiKey,
    baseUrl: optionalText(value.baseUrl, "connection.baseUrl"),
    model: optionalText(value.model, "connection.model"),
    type: optionalText(value.type, "connection.type"),
    provider: optionalText(value.provider, "connection.provider"),
    timeoutMs,
  };
}

function imageConnection(connection) {
  return {
    apiKey: connection.apiKey || connection.key,
    key: connection.apiKey || connection.key,
    baseUrl: connection.baseUrl,
    model: connection.model,
    type: connection.type,
    provider: connection.provider,
    ...(connection.timeoutMs ? { timeoutMs: connection.timeoutMs } : {}),
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

  if (request.capabilityId === "voice-call" && request.action === "request") {
    return {
      type: "suzu-voice-call-request",
      reason: request.input.reason,
    };
  }

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

  if (request.capabilityId === "image-generation") {
    const agentRoot = resolveAgentDataRoot({ dataRoot, agentId });
    if (request.action === "list-workflows") {
      return listComfyWorkflows({ dataRoot, configPath: request.input.configPath });
    }
    if (request.action === "validate-workflows") {
      return validateComfyWorkflows({ dataRoot, configPath: request.input.configPath });
    }
    if (request.action === "generate") {
      return runAgentImageGeneration({
        agentRoot,
        agentId,
        dataRoot,
        environment,
        connectionResolver: async () => imageConnection(connection),
        options: {
          prompt: request.input.prompt,
          backend: request.input.backend,
          workflow: request.input.workflow,
          size: request.input.size,
          seed: request.input.seed,
          refs: request.input.references.map((reference) => reference.role + "=" + reference.path),
          out: request.input.outputDirectory,
          config: request.input.configPath,
        },
      });
    }
  }

  if (request.capabilityId === "phone-camera" && request.action === "generate") {
    const agentRoot = resolveAgentDataRoot({ dataRoot, agentId });
    const phone = await loadPhoneConfig({ dataRoot, configPath: request.input.configPath });
    const backend = request.input.backend || phone.config.defaultBackend;
    const comfyui = backend === "comfyui"
      ? await loadPhoneCameraComfyConnection(dataRoot)
      : { registry: { version: 1, workflows: {} } };
    return takePhonePhoto({
      agentRoot,
      dataRoot,
      connection: backend === "comfyui" ? comfyui : imageConnection(connection),
      registry: comfyui.registry,
      options: {
        shot: request.input.shot,
        scene: request.input.scene,
        refs: request.input.referenceIds,
        backend: request.input.backend,
        workflow: request.input.workflow,
        size: request.input.size,
        seed: request.input.seed,
        out: request.input.outputDirectory,
        config: request.input.configPath,
        dryRun: request.input.dryRun,
      },
    });
  }

  if (request.capabilityId === "voice-message") {
    return runDirectVoiceMessage({
      dataRoot,
      ledgerPath,
      agentId,
      text: request.input.text,
      audioFile: request.input.audioPath,
      configPath: request.input.configPath,
      timeoutMs: request.input.timeoutMs ?? undefined,
      inspect: request.action === "inspect",
      apiKeyOverride: connection.apiKey || connection.key,
      baseUrlOverride: connection.baseUrl,
      modelOverride: connection.model,
      environment,
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
  if (error instanceof DirectVoiceMessageError) {
    return {
      code: clean(error.code) || "voice_message_error",
      message: cleanCapabilityErrorMessage(error.message),
      exitCode: error.exitCode || 4,
    };
  }
  if (error instanceof AgentImageGenerationError || error instanceof ImageWorkbenchError) {
    return {
      code: "image_generation_error",
      message: cleanCapabilityErrorMessage(error.message),
      exitCode: 4,
    };
  }
  if (error instanceof PhoneCameraError) {
    return {
      code: "phone_camera_error",
      message: cleanCapabilityErrorMessage(error.message),
      exitCode: 4,
    };
  }
  return {
    code: "internal_error",
    message: cleanCapabilityErrorMessage(error?.message || error),
    exitCode: 10,
  };
}
