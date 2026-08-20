import path from "node:path";

import { resolveAgentDataRoot } from "@suzu-lives/agent-registry";
import { runAgentImageGeneration } from "@suzu-lives/agent-image-generation";
import { appendUsageEvent } from "@suzu-lives/cost-ledger";
import { sendMailBridge } from "@suzu-lives/mail-bridge";
import { executeWebBrowserAction } from "@suzu-lives/web-browser";
import { runDirectImageVision } from "@suzu-lives/media-understanding/direct-image-vision";
import { runDirectVideoUnderstanding } from "@suzu-lives/media-understanding/direct-video-understanding";
import {
  loadPhoneCameraComfyConnection,
  loadPhoneConfig,
  takePhonePhoto,
} from "@suzu-lives/phone-camera";
import { runDirectVoiceMessage } from "@suzu-lives/voice-message/direct-voice-message";

const CONTACT_ID = /^contact-[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

function clean(value) {
  return String(value ?? "").trim();
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
    ? value
    : {};
}

function list(value) {
  return Array.isArray(value) ? value : [];
}

function samePath(left, right) {
  const first = clean(left);
  const second = clean(right);
  if (!first || !second || !path.isAbsolute(first) || !path.isAbsolute(second)) return false;
  const normalizedLeft = path.resolve(first);
  const normalizedRight = path.resolve(second);
  return process.platform === "win32"
    ? normalizedLeft.toLocaleLowerCase("en-US") === normalizedRight.toLocaleLowerCase("en-US")
    : normalizedLeft === normalizedRight;
}

function productDataRoot(settingsService) {
  const settings = settingsService?.load?.() || {};
  const response = typeof settingsService?.response === "function"
    ? settingsService.response(settings)
    : settings;
  const dataRoot = clean(response?.dataRoot);
  if (!dataRoot || !path.isAbsolute(dataRoot)) {
    throw new Error("无法定位 Suzu Lives 软件数据目录。 ");
  }
  return path.resolve(dataRoot);
}

function inputFor(context) {
  return plainObject(plainObject(context).input);
}

function inputText(value, label, { required = false, maximum = 20_000 } = {}) {
  const text = clean(value);
  if (text.length > maximum) throw new Error(`${label}不能超过 ${maximum} 个字符。`);
  if (required && !text) throw new Error(`${label}不能为空。`);
  return text;
}

function optionalInteger(value, label) {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) throw new Error(`${label}必须是整数。`);
  return parsed;
}

function agentImageReferences(input) {
  const references = list(input.references).length ? list(input.references) : list(input.refs);
  if (references.length > 16) throw new Error("一次最多使用 16 张图片参考。 ");
  return references.map((entry, index) => {
    if (typeof entry === "string") return inputText(entry, `第 ${index + 1} 个图片参考`, { required: true, maximum: 4_000 });
    const source = plainObject(entry);
    const role = inputText(source.role, `第 ${index + 1} 个图片参考的角色`, { required: true, maximum: 40 });
    const filePath = inputText(source.path, `第 ${index + 1} 个图片参考路径`, { required: true, maximum: 4_000 });
    return `${role}=${filePath}`;
  });
}

function phoneReferences(input) {
  const selected = list(input.references).length
    ? list(input.references)
    : list(input.referenceIds).length
      ? list(input.referenceIds)
      : list(input.refs);
  if (selected.length > 16) throw new Error("一次最多使用 16 张视觉参考。 ");
  return selected.map((entry, index) => {
    if (typeof entry === "string") return inputText(entry, `第 ${index + 1} 个视觉参考`, { required: true, maximum: 300 });
    const source = plainObject(entry);
    return {
      scope: inputText(source.scope, `第 ${index + 1} 个视觉参考范围`, { required: true, maximum: 20 }),
      id: inputText(source.id, `第 ${index + 1} 个视觉参考 ID`, { required: true, maximum: 200 }),
    };
  });
}

function connectionValue(connection, name) {
  return clean(connection?.[name]);
}

function openAiCompatibleBaseUrl(connection) {
  const configured = connectionValue(connection, "baseUrl");
  if (!configured || clean(connection?.type) !== "dashscope") return configured;
  try {
    const parsed = new URL(configured);
    if (parsed.hostname.toLocaleLowerCase("en-US") !== "dashscope.aliyuncs.com") return configured;
    const pathname = parsed.pathname.replace(/\/+$/u, "");
    if (pathname !== "/api/v1") return configured;
    return `${parsed.origin}/compatible-mode/v1`;
  } catch {
    return configured;
  }
}

function processEnvironment(connection, {
  key = "",
  baseUrl = "",
  model = "",
} = {}) {
  const environment = { ...process.env };
  const apiKey = connectionValue(connection, "apiKey") || connectionValue(connection, "key");
  if (apiKey && key) environment[key] = apiKey;
  if (connectionValue(connection, "baseUrl") && baseUrl) environment[baseUrl] = connectionValue(connection, "baseUrl");
  if (connectionValue(connection, "model") && model) environment[model] = connectionValue(connection, "model");
  return environment;
}

function directRuntimeState({ capability, lifecycle }) {
  return {
    status: "ready",
    capabilityId: clean(capability?.id),
    lifecycle: clean(lifecycle),
    runtime: "agent-capability-bridge",
  };
}

/**
 * Connects one declared Agent capability action to its product-owned executor.
 * The generic bridge keeps model calls, output files, reference libraries,
 * configuration and ledger writes in their respective product modules rather
 * than duplicating them inside the Agent Core child process.
 */
export function createAgentCapabilityAdapters({
  connectionsService,
  contactProjectsService,
  recordCapabilityUsage = null,
  runners = {},
  settingsService,
} = {}) {
  if (!connectionsService || typeof connectionsService.resolveNamedApiConnection !== "function") {
    throw new Error("Agent 能力适配器需要 API 连接服务。 ");
  }
  if (!contactProjectsService || typeof contactProjectsService.snapshot !== "function") {
    throw new Error("Agent 能力适配器需要联系人项目服务。 ");
  }
  if (!settingsService || typeof settingsService.load !== "function") {
    throw new Error("Agent 能力适配器需要软件设置服务。 ");
  }

  const executor = {
    loadPhoneCameraComfyConnection,
    loadPhoneConfig,
    runAgentImageGeneration,
    runDirectImageVision,
    runDirectVideoUnderstanding,
    runDirectVoiceMessage,
    sendMailBridge,
    takePhonePhoto,
    executeWebBrowserAction,
    ...plainObject(runners),
  };

  const requiredApiConnection = async (bindingId, label) => {
    const connection = await connectionsService.resolveNamedApiConnection(bindingId);
    if (connection?.key) return connection;
    if (["unreadable", "invalid", "encryption-unavailable"].includes(clean(connection?.credentialStatus))) {
      throw new Error(`${label}已绑定 API，但保存的 Key 无法读取；请前往 设置 → API 重新填写并保存。`);
    }
    throw new Error(`请先在 设置 → API 中为“${label}”选择并配置 API。`);
  };

  const resolveScope = async (context = {}) => {
    const request = plainObject(context);
    const contactId = clean(request.contactId);
    if (!CONTACT_ID.test(contactId)) {
      throw new Error("当前会话没有可用联系人，不能调用联系人能力。 ");
    }
    const snapshot = await contactProjectsService.snapshot();
    const contact = list(snapshot?.contacts).find((entry) => clean(entry?.id) === contactId);
    const projectRoot = clean(contact?.projectRoot);
    const agentId = clean(contact?.agentId);
    if (!contact || !projectRoot || !path.isAbsolute(projectRoot) || !agentId) {
      throw new Error("当前联系人工作区不可用，不能调用这项能力。 ");
    }
    if (clean(request.projectRoot) && !samePath(request.projectRoot, projectRoot)) {
      throw new Error("当前会话与联系人工作区不匹配，已取消能力调用。 ");
    }
    const dataRoot = productDataRoot(settingsService);
    const agentRoot = resolveAgentDataRoot({ dataRoot, agentId });
    return Object.freeze({
      agentId,
      agentRoot,
      contactId,
      dataRoot,
      ledgerPath: path.join(agentRoot, "cost-ledger", "events.jsonl"),
      projectRoot: path.resolve(projectRoot),
    });
  };

  const imageVision = async ({ capability, context, lifecycle } = {}) => {
    if (clean(lifecycle) !== "invoke") return directRuntimeState({ capability, lifecycle });
    const scope = await resolveScope(context);
    const input = inputFor(context);
    const imagePath = inputText(input.path || input.imagePath, "图片路径", { required: true, maximum: 4_000 });
    const connection = await requiredApiConnection("image-vision", "理解图像");
    return executor.runDirectImageVision({
      dataRoot: scope.dataRoot,
      ledgerPath: scope.ledgerPath,
      agentId: scope.agentId,
      imagePath,
      question: inputText(input.question, "图片问题", { maximum: 8_000 }),
      configPath: inputText(input.configPath, "配置路径", { maximum: 600 }),
      noRetry: input.noRetry === true,
      environment: processEnvironment({ ...plainObject(connection), baseUrl: openAiCompatibleBaseUrl(connection) }, {
        key: "VISION_API_KEY",
        baseUrl: "VISION_BASE_URL",
        model: "VISION_MODEL",
      }),
    });
  };

  const videoUnderstanding = async ({ capability, context, lifecycle } = {}) => {
    if (clean(lifecycle) !== "invoke") return directRuntimeState({ capability, lifecycle });
    const scope = await resolveScope(context);
    const input = inputFor(context);
    const videoPath = inputText(input.source || input.videoPath, "视频路径或 URL", { required: true, maximum: 4_000 });
    const connection = await requiredApiConnection("video-understanding", "理解视频");
    return executor.runDirectVideoUnderstanding({
      dataRoot: scope.dataRoot,
      ledgerPath: scope.ledgerPath,
      agentId: scope.agentId,
      videoPath,
      question: inputText(input.question, "视频问题", { maximum: 8_000 }),
      cacheKey: inputText(input.cacheKey, "视频缓存标识", { maximum: 300 }),
      configPath: inputText(input.configPath, "配置路径", { maximum: 600 }),
      noCache: input.noCache === true,
      keepClip: input.keepClip === true,
      dryRun: input.dryRun === true,
      environment: processEnvironment({ ...plainObject(connection), baseUrl: openAiCompatibleBaseUrl(connection) }, {
        key: "VIDEO_UNDERSTANDING_API_KEY",
        baseUrl: "VIDEO_UNDERSTANDING_BASE_URL",
        model: "VIDEO_UNDERSTANDING_MODEL",
      }),
    });
  };

  const voiceMessage = async ({ capability, context, lifecycle } = {}) => {
    if (clean(lifecycle) !== "invoke") return directRuntimeState({ capability, lifecycle });
    const scope = await resolveScope(context);
    const input = inputFor(context);
    const text = inputText(input.text, "语音文字", { maximum: 2_000 });
    const audioFile = inputText(input.audioPath || input.audioFile, "音频路径", { maximum: 4_000 });
    if (Boolean(text) === Boolean(audioFile)) {
      throw new Error("语音消息必须且只能提供 text 或 audioPath 其中之一。 ");
    }
    const connection = await requiredApiConnection("voice-message", "语音消息");
    return executor.runDirectVoiceMessage({
      dataRoot: scope.dataRoot,
      ledgerPath: scope.ledgerPath,
      agentId: scope.agentId,
      text,
      audioFile,
      timeoutMs: optionalInteger(input.timeoutMs, "语音等待时间"),
      apiKeyOverride: connectionValue(connection, "apiKey") || connectionValue(connection, "key"),
      baseUrlOverride: connectionValue(connection, "baseUrl"),
      modelOverride: connectionValue(connection, "model"),
      connectionName: connectionValue(connection, "name") || connectionValue(connection, "provider"),
      connectionType: connectionValue(connection, "type"),
    });
  };

  const imageGeneration = async ({ capability, context, lifecycle } = {}) => {
    if (clean(lifecycle) !== "invoke") return directRuntimeState({ capability, lifecycle });
    const scope = await resolveScope(context);
    const input = inputFor(context);
    const options = {
      prompt: inputText(input.prompt, "图片提示词", { required: true, maximum: 4_000 }),
      backend: inputText(input.backend, "图片生成后端", { maximum: 30 }),
      workflow: inputText(input.workflow, "ComfyUI 工作流", { maximum: 300 }),
      size: inputText(input.size, "图片尺寸", { maximum: 80 }),
      out: inputText(input.outputDirectory || input.out, "输出目录", { maximum: 600 }),
      config: inputText(input.configPath || input.config, "配置路径", { maximum: 600 }),
      refs: agentImageReferences(input),
    };
    const seed = optionalInteger(input.seed, "随机种子");
    if (seed !== undefined) options.seed = seed;
    return executor.runAgentImageGeneration({
      agentRoot: scope.agentRoot,
      agentId: scope.agentId,
      dataRoot: scope.dataRoot,
      options,
      connectionResolver: async () => requiredApiConnection("image-workbench", "生图"),
      appendLedger: async (ledgerPath, event) => {
        if (typeof recordCapabilityUsage === "function") {
          return recordCapabilityUsage({ capabilityId: "image-generation", ledgerPath, event });
        }
        return appendUsageEvent(ledgerPath, {
          ...event,
          metadata: { ...plainObject(event.metadata), capabilityId: "image-generation" },
        });
      },
    });
  };

  const phoneCamera = async ({ capability, context, lifecycle } = {}) => {
    if (clean(lifecycle) !== "invoke") return directRuntimeState({ capability, lifecycle });
    const scope = await resolveScope(context);
    const input = inputFor(context);
    const config = inputText(input.configPath || input.config, "配置路径", { maximum: 600 });
    const phoneConfig = await executor.loadPhoneConfig({ dataRoot: scope.dataRoot, configPath: config });
    const backend = inputText(input.backend, "图片生成后端", { maximum: 30 }) || phoneConfig.config.defaultBackend;
    const comfyui = backend === "comfyui"
      ? await executor.loadPhoneCameraComfyConnection(scope.dataRoot)
      : { registry: { version: 1, workflows: {} } };
    const imageConnection = backend === "comfyui"
      ? comfyui
      : await requiredApiConnection("image-workbench", "生图");
    const options = {
      shot: inputText(input.shot, "拍照方式", { required: true, maximum: 30 }),
      scene: inputText(input.scene, "拍照场景", { required: true, maximum: 5_000 }),
      refs: phoneReferences(input),
      backend,
      workflow: inputText(input.workflow, "ComfyUI 工作流", { maximum: 300 }),
      size: inputText(input.size, "图片尺寸", { maximum: 80 }),
      out: inputText(input.outputDirectory || input.out, "输出目录", { maximum: 600 }),
      config,
      dryRun: input.dryRun === true,
    };
    const seed = optionalInteger(input.seed, "随机种子");
    if (seed !== undefined) options.seed = seed;
    const result = await executor.takePhonePhoto({
      agentRoot: scope.agentRoot,
      dataRoot: scope.dataRoot,
      connection: imageConnection,
      registry: comfyui.registry,
      options,
    });
    if (result?.status === "ok") {
      const event = {
        agentId: scope.agentId,
        provider: backend === "comfyui" ? "本地 ComfyUI" : clean(imageConnection?.provider) || "OpenAI Compatible",
        model: clean(result.model),
        source: "手机拍照式图像",
        feature: backend === "comfyui" ? "phone-camera-workflow" : "phone-camera-image",
        requestId: clean(result.requestId),
        usage: {},
        units: { imageRequests: 1, generatedImages: 1 },
        metadata: {
          costSource: backend === "comfyui" ? "local-unpriced" : "provider-reported",
          backend,
          referenceCount: list(result.references).length,
          shot: clean(result.shot),
          workflow: clean(result.workflow),
        },
      };
      if (typeof recordCapabilityUsage === "function") {
        await recordCapabilityUsage({ capabilityId: "phone-camera", ledgerPath: scope.ledgerPath, event });
      } else {
        await appendUsageEvent(scope.ledgerPath, {
          ...event,
          metadata: { ...event.metadata, capabilityId: "phone-camera" },
        });
      }
    }
    return result;
  };

  const mailBridge = async ({ capability, context, lifecycle } = {}) => {
    if (clean(lifecycle) !== "invoke") return directRuntimeState({ capability, lifecycle });
    const scope = await resolveScope(context);
    const input = inputFor(context);
    return executor.sendMailBridge({
      content: inputText(input.content, "邮件内容", { required: true, maximum: 20_000 }),
      dataRoot: scope.dataRoot,
      projectRoot: scope.projectRoot,
      subject: inputText(input.subject, "邮件主题", { required: true, maximum: 320 }),
    });
  };

  const webBrowser = async ({ capability, context, lifecycle, action } = {}) => {
    if (clean(lifecycle) !== "invoke") return directRuntimeState({ capability, lifecycle });
    const scope = await resolveScope(context);
    return executor.executeWebBrowserAction({
      action: inputText(action?.action, "网页自动化动作", { required: true, maximum: 80 }),
      dataRoot: scope.dataRoot,
      input: inputFor(context),
      outputRoot: path.join(scope.agentRoot, "web-browser"),
    });
  };

  return Object.freeze({
    "image-generation": imageGeneration,
    "image-vision": imageVision,
    "mail-bridge": mailBridge,
    "phone-camera": phoneCamera,
    "video-understanding": videoUnderstanding,
    "voice-message": voiceMessage,
    "web-browser": webBrowser,
  });
}
