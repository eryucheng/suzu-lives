import {
  createMemoryRecallContextHook,
  MEMORY_RECALL_HOOK_MOUNT,
} from "./memory-recall-hook.mjs";
import {
  createConversationAttachmentDeliveryHook,
  ATTACHMENT_DELIVERY_HOOK_MOUNT,
} from "./conversation-attachment-delivery-hook.mjs";
import {
  createTimeAwarenessContextHook,
  TIME_AWARENESS_HOOK_MOUNT,
} from "./time-awareness-hook.mjs";

/**
 * A capability describes a product feature; resources describe the concrete
 * things that make it work.  The registry deliberately does not choose an
 * Agent host.  Agent Core, a future Skill, a CLI, or an MCP server are all adapters
 * attached to the same resource declaration.
 */
export const CAPABILITY_RESOURCE_KINDS = Object.freeze([
  "agent-extension",
  "agent-turn",
  "cli",
  "hook",
  "mcp",
  "runtime",
  "skill",
  "storage",
  "task",
  "usage",
]);

export const CAPABILITY_RESOURCE_LIFECYCLES = Object.freeze([
  "install",
  "invoke",
  "mount",
  "remove-contact",
  "sync",
  "uninstall",
]);

const CAPABILITY_ID = /^[a-z][a-z0-9-]{0,127}$/u;
const RESOURCE_ID = /^[a-z][a-z0-9-]{0,127}$/u;
const AGENT_ACTION_ID = /^[a-z][a-z0-9-]{0,127}$/u;
const RESOURCE_KIND_SET = new Set(CAPABILITY_RESOURCE_KINDS);
const RESOURCE_LIFECYCLE_SET = new Set(CAPABILITY_RESOURCE_LIFECYCLES);

export class CapabilityRegistryError extends Error {
  constructor(message, { code = "CAPABILITY_REGISTRY_ERROR", cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "CapabilityRegistryError";
    this.code = code;
  }
}

function clean(value) {
  return String(value ?? "").trim();
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function freezeArray(value) {
  return Object.freeze([...value]);
}

function stablePath(value, label) {
  if (!Array.isArray(value) || !value.length) {
    throw new CapabilityRegistryError(`${label}必须是非空路径数组。`, { code: "CONFIG_PATH_REQUIRED" });
  }
  const segments = value.map((entry) => clean(entry));
  if (segments.some((entry) => !entry || entry === "." || entry === ".." || /[\\/]/u.test(entry))) {
    throw new CapabilityRegistryError(`${label}包含无效路径段。`, { code: "CONFIG_PATH_INVALID" });
  }
  return freezeArray(segments);
}

function mountDefinition(value, capabilityId, resourceId) {
  const source = plainObject(value);
  const id = clean(source.id);
  const lifecycleEvent = clean(source.lifecycleEvent);
  if (!id || !lifecycleEvent) {
    throw new CapabilityRegistryError(`能力 ${capabilityId} 的 Hook 资源 ${resourceId} 缺少挂载信息。`, {
      code: "HOOK_MOUNT_REQUIRED",
    });
  }
  return Object.freeze({
    id,
    lifecycleEvent,
    order: Number.isFinite(Number(source.order)) ? Number(source.order) : 0,
    policy: clean(source.policy) || "observe",
    ...(Number.isFinite(Number(source.timeoutMs)) ? { timeoutMs: Number(source.timeoutMs) } : {}),
  });
}

/**
 * A product action is deliberately declared on the concrete resource that
 * performs it.  The generic Agent Core bridge can therefore route the same action
 * through a CLI, Skill, MCP server, or a product runtime without owning a
 * second list of model-facing capabilities.
 */
function agentActionDefinition(value, capabilityId, resourceId) {
  const source = plainObject(value);
  const id = clean(source.id);
  const description = clean(source.description);
  if (!AGENT_ACTION_ID.test(id) || !description) {
    throw new CapabilityRegistryError(`能力 ${capabilityId} 的资源 ${resourceId} 缺少有效 Agent 动作声明。`, {
      code: "AGENT_ACTION_INVALID",
    });
  }
  return Object.freeze({
    id,
    description,
    ...(clean(source.name) ? { name: clean(source.name) } : {}),
  });
}

function resourceDefinition(value, capabilityId) {
  const source = plainObject(value);
  const id = clean(source.id);
  const kind = clean(source.kind);
  if (!RESOURCE_ID.test(id)) {
    throw new CapabilityRegistryError(`能力 ${capabilityId} 有无效资源 ID：${id || "（空）"}。`, {
      code: "RESOURCE_ID_INVALID",
    });
  }
  if (!RESOURCE_KIND_SET.has(kind)) {
    throw new CapabilityRegistryError(`能力 ${capabilityId} 的资源 ${id} 使用了未知类型：${kind || "（空）"}。`, {
      code: "RESOURCE_KIND_UNKNOWN",
    });
  }
  const lifecycle = Array.isArray(source.lifecycle)
    ? [...new Set(source.lifecycle.map(clean).filter(Boolean))]
    : [];
  if (lifecycle.some((event) => !RESOURCE_LIFECYCLE_SET.has(event))) {
    throw new CapabilityRegistryError(`能力 ${capabilityId} 的资源 ${id} 包含未知生命周期。`, {
      code: "RESOURCE_LIFECYCLE_UNKNOWN",
    });
  }
  const implementation = clean(source.implementation);
  if (kind === "hook" && !implementation) {
    throw new CapabilityRegistryError(`能力 ${capabilityId} 的 Hook 资源 ${id} 缺少 implementation。`, {
      code: "HOOK_IMPLEMENTATION_REQUIRED",
    });
  }
  const agentAction = source.agentAction === undefined
    ? null
    : agentActionDefinition(source.agentAction, capabilityId, id);
  if (agentAction && !lifecycle.includes("invoke")) {
    throw new CapabilityRegistryError(`能力 ${capabilityId} 的资源 ${id} 声明了 Agent 动作，但没有 invoke 生命周期。`, {
      code: "AGENT_ACTION_INVOKE_REQUIRED",
    });
  }
  return Object.freeze({
    id,
    kind,
    ...(clean(source.driver) ? { driver: clean(source.driver) } : {}),
    ...(implementation ? { implementation } : {}),
    ...(source.mount ? { mount: mountDefinition(source.mount, capabilityId, id) } : {}),
    ...(agentAction ? { agentAction } : {}),
    lifecycle: freezeArray(lifecycle),
  });
}

function configDefinition(value, capabilityId) {
  if (value === undefined || value === null) return null;
  const source = plainObject(value);
  const path = stablePath(source.path, `能力 ${capabilityId} 的配置路径`);
  const contactFields = Array.isArray(source.contactFields)
    ? [...new Set(source.contactFields.map(clean).filter(Boolean))]
    : [];
  if (source.contactScoped === true && !contactFields.length) {
    throw new CapabilityRegistryError(`能力 ${capabilityId} 标记为联系人范围，但没有 contactFields。`, {
      code: "CONTACT_SCOPE_FIELDS_REQUIRED",
    });
  }
  return Object.freeze({
    path,
    contactScoped: source.contactScoped === true,
    contactFields: freezeArray(contactFields),
  });
}

/**
 * Validate and freeze one capability manifest.  Keeping this public makes a
 * new feature fail at startup/test time instead of silently adding an
 * untracked config file or timer.
 */
export function defineCapability(value) {
  const source = plainObject(value);
  const id = clean(source.id);
  if (!CAPABILITY_ID.test(id)) {
    throw new CapabilityRegistryError(`能力 ID 无效：${id || "（空）"}。`, { code: "CAPABILITY_ID_INVALID" });
  }
  const resources = (Array.isArray(source.resources) ? source.resources : []).map((resource) => resourceDefinition(resource, id));
  const resourceIds = new Set();
  for (const resource of resources) {
    if (resourceIds.has(resource.id)) {
      throw new CapabilityRegistryError(`能力 ${id} 的资源 ID 重复：${resource.id}。`, {
        code: "DUPLICATE_RESOURCE_ID",
      });
    }
    resourceIds.add(resource.id);
  }
  const setting = plainObject(source.setting);
  return Object.freeze({
    id,
    name: clean(source.name),
    description: clean(source.description),
    category: clean(source.category),
    internal: source.internal === true,
    runtimeStatus: clean(source.runtimeStatus) || "product-automation",
    ...(Object.keys(setting).length ? { setting: Object.freeze({ ...setting }) } : {}),
    config: configDefinition(source.config, id),
    resources: freezeArray(resources),
  });
}

const CONTACT_SCOPE_FIELDS = Object.freeze(["enabledContactIds", "knownContactIds"]);

/**
 * This is the one product-owned list of capabilities.  It is intentionally
 * richer than the renderer catalog: the nearby resource declarations are the
 * source of truth for config cleanup, Hook mounting, timers, storage and
 * future Skill/CLI/MCP adapters.
 */
export const CAPABILITY_DEFINITIONS = freezeArray([
  defineCapability({
    id: "image-generation",
    name: "图像生成",
    description: "生成、编辑图片，并可结合视觉参考。",
    category: "create",
    setting: { route: "api", label: "设置图片" },
    runtimeStatus: "agent-capability-bridge",
    config: { path: ["capabilities", "image-generation", "config.json"], contactScoped: true, contactFields: CONTACT_SCOPE_FIELDS },
    resources: [
      {
        id: "agent-action",
        kind: "runtime",
        driver: "image-generation",
        lifecycle: ["install", "sync", "uninstall", "invoke"],
        agentAction: {
          id: "generate",
          name: "生成图片",
          description: "生成或编辑一张图片。input 必须包含 { prompt: " + '"图片提示词"' + " }；可选 backend: \"api\" | \"comfyui\"、workflow、size、seed、outputDirectory，以及最多 16 个 references: [{ role: \"identity\" | \"location\" | \"object\" | \"style\", path: \"本机绝对图片路径\" }]。成功后会返回本机图片路径；如要发给用户，再调用 conversation-attachment.deliver。",
        },
      },
      { id: "usage-ledger", kind: "usage", driver: "cost-ledger" },
    ],
  }),
  defineCapability({
    id: "phone-camera",
    name: "手机拍照式图像",
    description: "生成具有手机拍摄感的图片。",
    category: "create",
    setting: { route: "api", label: "设置图片" },
    runtimeStatus: "agent-capability-bridge",
    config: { path: ["capabilities", "phone-camera", "config.json"], contactScoped: true, contactFields: CONTACT_SCOPE_FIELDS },
    resources: [
      {
        id: "agent-action",
        kind: "runtime",
        driver: "phone-camera",
        lifecycle: ["install", "sync", "uninstall", "invoke"],
        agentAction: {
          id: "generate",
          name: "生成手机拍照式图片",
          description: "按手机后置、自拍或镜前拍照的既有构图规则生成一张图片。input 必须包含 { shot: \"rear\" | \"selfie\" | \"mirror\", scene: \"画面中可见的场景\" }；可选 backend、workflow、size、seed、outputDirectory，以及 references: [{ scope: \"contact\" | \"shared\", id: \"视觉资料或资料组 ID\" }]。成功后会返回本机图片路径；如要发给用户，再调用 conversation-attachment.deliver。",
        },
      },
      { id: "usage-ledger", kind: "usage", driver: "cost-ledger" },
    ],
  }),
  defineCapability({
    id: "time-awareness",
    name: "时间感知",
    description: "按会话以设定的间隔感知本机日期、星期与当前时间。",
    category: "perceive",
    runtimeStatus: "agent-core-context-hook",
    config: { path: ["capabilities", "time-awareness", "config.json"], contactScoped: true, contactFields: CONTACT_SCOPE_FIELDS },
    resources: [
      {
        id: "dynamic-context",
        kind: "hook",
        implementation: "time-awareness",
        mount: TIME_AWARENESS_HOOK_MOUNT,
        lifecycle: ["mount"],
      },
    ],
  }),
  defineCapability({
    id: "image-vision",
    name: "图像理解",
    description: "理解一张明确提供的本地图片。",
    category: "perceive",
    setting: { route: "api", label: "设置图像理解" },
    runtimeStatus: "agent-capability-bridge",
    config: { path: ["capabilities", "image-vision", "config.json"], contactScoped: true, contactFields: CONTACT_SCOPE_FIELDS },
    resources: [
      {
        id: "agent-action",
        kind: "runtime",
        driver: "image-vision",
        lifecycle: ["install", "sync", "uninstall", "invoke"],
        agentAction: {
          id: "analyze",
          name: "理解图片",
          description: "读取当前用户明确提供的一张本机图片。input 必须包含 { path: \"本机绝对图片路径\" }，可选 question。不要猜测图片路径；用户刚发送的附件路径会出现在当前消息的附件清单中。",
        },
      },
      { id: "usage-ledger", kind: "usage", driver: "cost-ledger" },
    ],
  }),
  defineCapability({
    id: "video-understanding",
    name: "视频理解",
    description: "理解一段明确提供的视频。",
    category: "perceive",
    setting: { route: "api", label: "设置视频理解" },
    runtimeStatus: "agent-capability-bridge",
    config: { path: ["capabilities", "video-understanding", "config.json"], contactScoped: true, contactFields: CONTACT_SCOPE_FIELDS },
    resources: [
      {
        id: "agent-action",
        kind: "runtime",
        driver: "video-understanding",
        lifecycle: ["install", "sync", "uninstall", "invoke"],
        agentAction: {
          id: "analyze",
          name: "理解视频",
          description: "把一段明确提供的本机视频或 http(s) 视频 URL 作为完整视频输入交给已配置的视频理解模型，不把本地抽帧当作理解路径。input 必须包含 { source: \"本机绝对视频路径或 https URL\" }，可选 question、noCache、keepClip。",
        },
      },
      { id: "usage-ledger", kind: "usage", driver: "cost-ledger" },
    ],
  }),
  defineCapability({
    id: "voice-message",
    name: "语音消息",
    description: "将文字或已有音频通过既有通道发送。",
    category: "create",
    runtimeStatus: "agent-capability-bridge",
    config: { path: ["capabilities", "voice-message", "config.json"], contactScoped: true, contactFields: CONTACT_SCOPE_FIELDS },
    resources: [
      {
        id: "agent-action",
        kind: "runtime",
        driver: "voice-message",
        lifecycle: ["install", "sync", "uninstall", "invoke"],
        agentAction: {
          id: "generate",
          name: "生成语音消息",
          description: "按当前联系人的已选音色生成一个本机 MP3。input 必须且只能提供 { text: \"要说的话\" } 或 { audioPath: \"已有本机音频绝对路径\" } 其中之一。成功后会返回 savedPath；如要发给用户，再调用 conversation-attachment.deliver，kind 使用 audio。",
        },
      },
      { id: "usage-ledger", kind: "usage", driver: "cost-ledger" },
    ],
  }),
  defineCapability({
    id: "web-browser",
    name: "网页自动化",
    description: "使用 Suzu 的专用浏览器访问、阅读和操作已登录网页。",
    category: "act",
    runtimeStatus: "agent-capability-bridge",
    config: { path: ["capabilities", "web-browser", "config.json"], contactScoped: true, contactFields: CONTACT_SCOPE_FIELDS },
    resources: [
      {
        id: "browser-start",
        kind: "runtime",
        driver: "web-browser",
        lifecycle: ["invoke"],
        agentAction: { id: "start", name: "启动浏览器", description: "启动 Suzu 专用浏览器并返回连接状态。登录网页时先调用这个动作；登录态保留在软件数据目录。" },
      },
      {
        id: "browser-status",
        kind: "runtime",
        driver: "web-browser",
        lifecycle: ["invoke"],
        agentAction: { id: "status", name: "查看浏览器状态", description: "返回专用浏览器是否运行、CDP 地址和登录 profile 位置。" },
      },
      {
        id: "browser-tabs",
        kind: "runtime",
        driver: "web-browser",
        lifecycle: ["invoke"],
        agentAction: { id: "tabs", name: "查看标签页", description: "列出专用浏览器现有标签页及其 tabId、标题和网址。" },
      },
      {
        id: "browser-open",
        kind: "runtime",
        driver: "web-browser",
        lifecycle: ["invoke"],
        agentAction: { id: "open", name: "打开网页", description: "打开 input.url 指定的任意 http(s) 网页；可选 tabId 和 newTab: true。" },
      },
      {
        id: "browser-snapshot",
        kind: "runtime",
        driver: "web-browser",
        lifecycle: ["invoke"],
        agentAction: { id: "snapshot", name: "读取网页", description: "读取当前网页或 input.tabId 的文字和可交互元素；可选 selector、maxChars、includeInteractables。" },
      },
      {
        id: "browser-screenshot",
        kind: "runtime",
        driver: "web-browser",
        lifecycle: ["invoke"],
        agentAction: { id: "screenshot", name: "网页截图", description: "截图当前网页，返回 savedPath；可选 tabId、fullPage、outputPath。需要把截图发到聊天时，再调用 conversation-attachment.deliver。" },
      },
      {
        id: "browser-click",
        kind: "runtime",
        driver: "web-browser",
        lifecycle: ["invoke"],
        agentAction: { id: "click", name: "点击网页元素", description: "点击网页元素。input 用 selector，或 role/name，或 text 定位；可选 tabId 和 timeoutMs。" },
      },
      {
        id: "browser-fill",
        kind: "runtime",
        driver: "web-browser",
        lifecycle: ["invoke"],
        agentAction: { id: "fill", name: "填写网页输入框", description: "向网页元素填写 input.value 或 content；定位方式与 click 相同。" },
      },
      {
        id: "browser-press",
        kind: "runtime",
        driver: "web-browser",
        lifecycle: ["invoke"],
        agentAction: { id: "press", name: "发送网页按键", description: "发送 input.key，例如 Enter、Control+A；可选用 selector 或 role/name/text 把按键发给特定元素。" },
      },
      {
        id: "browser-scroll",
        kind: "runtime",
        driver: "web-browser",
        lifecycle: ["invoke"],
        agentAction: { id: "scroll", name: "滚动网页", description: "滚动当前网页；可选 deltaY、deltaX 和 tabId。" },
      },
      {
        id: "browser-wait",
        kind: "runtime",
        driver: "web-browser",
        lifecycle: ["invoke"],
        agentAction: { id: "wait", name: "等待网页状态", description: "等待元素出现/隐藏，或等待 input.milliseconds。元素定位方式与 click 相同，可选 state。" },
      },
      {
        id: "browser-upload",
        kind: "runtime",
        driver: "web-browser",
        lifecycle: ["invoke"],
        agentAction: { id: "upload", name: "上传网页文件", description: "向文件输入元素上传 input.file 或 files（本机绝对路径）；定位方式与 click 相同。" },
      },
      {
        id: "browser-download",
        kind: "runtime",
        driver: "web-browser",
        lifecycle: ["invoke"],
        agentAction: { id: "download", name: "下载网页文件", description: "点击下载元素并等待文件保存，返回 savedPath；可选 outputPath。" },
      },
      {
        id: "browser-evaluate",
        kind: "runtime",
        driver: "web-browser",
        lifecycle: ["invoke"],
        agentAction: { id: "evaluate", name: "执行页面脚本", description: "在当前网页执行 input.script，并可传 input.argument；用于普通点击/填写无法完成的页面操作。" },
      },
      {
        id: "browser-close-tab",
        kind: "runtime",
        driver: "web-browser",
        lifecycle: ["invoke"],
        agentAction: { id: "close-tab", name: "关闭标签页", description: "关闭 input.tabId 指定的标签页；不填时关闭当前标签页。" },
      },
      {
        id: "browser-stop",
        kind: "runtime",
        driver: "web-browser",
        lifecycle: ["invoke"],
        agentAction: { id: "stop", name: "停止浏览器", description: "停止 Suzu 启动的专用浏览器。" },
      },
    ],
  }),
  defineCapability({
    id: "mail-bridge",
    name: "邮箱通道",
    description: "通过已配置的 SMTP/IMAP 邮箱发送请求，并接收按主题路由的回信。",
    category: "act",
    runtimeStatus: "agent-capability-bridge",
    config: { path: ["automation", "mail-bridge", "config.json"], contactScoped: true, contactFields: CONTACT_SCOPE_FIELDS },
    resources: [
      {
        id: "agent-action",
        kind: "runtime",
        driver: "mail-bridge",
        lifecycle: ["install", "sync", "uninstall", "invoke"],
        agentAction: {
          id: "send",
          name: "发送邮件",
          description: "通过已配置的默认 SMTP 收件邮箱发送一封邮件。input 必须包含 { subject: \"邮件主题\", content: \"邮件正文\" }。收件地址由软件配置决定，不能由模型传入；发送成功仅表示邮件已提交给 SMTP 服务器。",
        },
      },
      { id: "feedback-link", kind: "runtime", driver: "mail-feedback-link", lifecycle: ["sync"] },
    ],
  }),
  defineCapability({
    id: "agent-journal",
    name: "写日记",
    description: "在每天设定的时间，让 Agent 回顾并写下当天值得记录的事。",
    category: "act",
    config: { path: ["automation", "agent-journal", "config.json"], contactScoped: true, contactFields: CONTACT_SCOPE_FIELDS },
    resources: [
      { id: "daily-task", kind: "task", driver: "agent-journal-schedule", lifecycle: ["sync"] },
      { id: "scheduled-turn", kind: "agent-turn", driver: "agent-journal-turn" },
      { id: "entries", kind: "storage", driver: "agent-journal-storage", lifecycle: ["remove-contact"] },
      { id: "usage-ledger", kind: "usage", driver: "cost-ledger" },
    ],
  }),
  defineCapability({
    id: "proactive-contact",
    name: "主动关心",
    description: "在 Suzu 运行期间用自动任务安排主动联系。",
    category: "companion",
    config: { path: ["automation", "proactive-contact", "config.json"], contactScoped: true, contactFields: CONTACT_SCOPE_FIELDS },
    resources: [
      { id: "maintenance", kind: "task", driver: "proactive-contact-maintenance", lifecycle: ["sync"] },
      { id: "scheduled-turn", kind: "agent-turn", driver: "proactive-contact-turn" },
    ],
  }),
  // Internal components are deliberately in the same registry, but are not
  // renderer capabilities. This avoids a second hidden list for lifecycle
  // resources that still need orderly mount/removal behavior.
  defineCapability({
    id: "memory-recall",
    name: "记忆召回",
    description: "按当前轮次召回相关长期记忆。",
    category: "system",
    internal: true,
    runtimeStatus: "agent-core-context-hook",
    resources: [
      {
        id: "dynamic-context",
        kind: "hook",
        implementation: "memory-recall",
        mount: MEMORY_RECALL_HOOK_MOUNT,
        lifecycle: ["mount"],
      },
    ],
  }),
  defineCapability({
    id: "conversation-attachment",
    name: "聊天附件交付",
    description: "将 Agent 已生成的本地图片、音频或文件作为聊天附件交付给用户。",
    category: "system",
    internal: true,
    runtimeStatus: "agent-core-native",
    resources: [
      {
        id: "delivery-instruction",
        kind: "hook",
        implementation: "conversation-attachment-delivery",
        mount: ATTACHMENT_DELIVERY_HOOK_MOUNT,
        lifecycle: ["mount"],
      },
      {
        id: "agent-delivery",
        kind: "runtime",
        driver: "conversation-attachment",
        lifecycle: ["invoke"],
        agentAction: {
          id: "deliver",
          name: "发送聊天附件",
          description: "将已生成或已确认的本机绝对路径交付到当前聊天。input 必须是 { items: [{ path: \"绝对路径\", kind: \"image\" | \"audio\" | \"file\" }] }；图片支持 AVIF/BMP/GIF/HEIC/ICO/JPG/PNG/SVG/TIFF/WebP，音频仅支持 MP3。",
        },
      },
    ],
  }),
  defineCapability({
    id: "conversation-model",
    name: "对话模型调用",
    description: "记录 Agent Core 主对话与原生压缩产生的模型用量。",
    category: "system",
    internal: true,
    runtimeStatus: "agent-core-native",
    resources: [
      { id: "usage-ledger", kind: "usage", driver: "cost-ledger" },
    ],
  }),
  defineCapability({
    id: "contact-scheduled-tasks",
    name: "联系人计划清理",
    description: "删除联系人时清理所有属于该联系人的软件计划。",
    category: "system",
    internal: true,
    resources: [
      { id: "contact-cleanup", kind: "task", driver: "contact-scheduled-task-cleanup", lifecycle: ["remove-contact"] },
    ],
  }),
]);

function catalogEntry(definition) {
  return Object.freeze({
    id: definition.id,
    name: definition.name,
    description: definition.description,
    category: definition.category,
    ...(definition.setting ? { setting: Object.freeze({ ...definition.setting }) } : {}),
  });
}

function defaultHookFactories() {
  return {
    "conversation-attachment-delivery": createConversationAttachmentDeliveryHook,
    "time-awareness": createTimeAwarenessContextHook,
    "memory-recall": createMemoryRecallContextHook,
  };
}

function hookModule({ capability, resource, dataRoot, memoryRuntime, hookFactories }) {
  const implementation = resource.implementation;
  const factory = hookFactories[implementation];
  if (typeof factory !== "function") {
    throw new CapabilityRegistryError(`能力 ${capability.id} 的 Hook 实现 ${implementation} 不可用。`, {
      code: "HOOK_FACTORY_UNAVAILABLE",
    });
  }
  if (implementation === "memory-recall" && typeof memoryRuntime?.recallForTurn !== "function") return null;
  const instance = implementation === "memory-recall"
    ? factory({ memoryRuntime })
    : factory({ dataRoot });
  if (typeof instance?.collect !== "function") {
    throw new CapabilityRegistryError(`能力 ${capability.id} 的 Hook 实现 ${implementation} 缺少 collect()。`, {
      code: "HOOK_COLLECT_REQUIRED",
    });
  }
  return Object.freeze({
    ...resource.mount,
    handler: (payload) => instance.collect(payload),
  });
}

function selectedCapabilities(definitions, capabilityId = "") {
  const id = clean(capabilityId);
  if (!id) return definitions;
  const found = definitions.find((definition) => definition.id === id);
  if (!found) {
    throw new CapabilityRegistryError(`未找到能力：${id}。`, { code: "CAPABILITY_NOT_FOUND" });
  }
  return [found];
}

/**
 * Registry lookup APIs intentionally return copies/frozen records: callers
 * can read capability data but cannot mutate the product definition at
 * runtime and leave the other lifecycle paths out of sync.
 */
export function createCapabilityRegistry({ definitions = CAPABILITY_DEFINITIONS, hookFactories = {} } = {}) {
  if (!Array.isArray(definitions)) {
    throw new CapabilityRegistryError("能力定义必须是数组。", { code: "CAPABILITY_DEFINITIONS_INVALID" });
  }
  const entries = definitions.map((definition) => defineCapability(definition));
  const byId = new Map();
  const configPaths = new Set();
  const hookMountIds = new Set();
  for (const definition of entries) {
    if (byId.has(definition.id)) {
      throw new CapabilityRegistryError(`能力 ID 重复：${definition.id}。`, { code: "DUPLICATE_CAPABILITY_ID" });
    }
    byId.set(definition.id, definition);
    if (definition.config?.path) {
      const configPath = definition.config.path.join("/");
      if (configPaths.has(configPath)) {
        throw new CapabilityRegistryError(`能力配置路径重复：${configPath}。`, { code: "DUPLICATE_CONFIG_PATH" });
      }
      configPaths.add(configPath);
    }
    for (const resource of definition.resources) {
      if (resource.kind !== "hook" || !resource.mount) continue;
      if (hookMountIds.has(resource.mount.id)) {
        throw new CapabilityRegistryError(`Hook 挂载 ID 重复：${resource.mount.id}。`, { code: "DUPLICATE_HOOK_MOUNT_ID" });
      }
      hookMountIds.add(resource.mount.id);
    }
  }
  const factories = { ...defaultHookFactories(), ...plainObject(hookFactories) };
  const contactConfigs = [];
  for (const definition of entries) {
    if (!definition.config?.contactScoped) continue;
    contactConfigs.push(Object.freeze({
      capabilityId: definition.id,
      path: definition.config.path,
      contactFields: definition.config.contactFields,
    }));
  }
  const registry = {
    definitions: () => freezeArray(entries),
    get: (id) => byId.get(clean(id)) || null,
    catalog: () => freezeArray(entries.filter((definition) => !definition.internal).map(catalogEntry)),
    isContactScoped: (id) => byId.get(clean(id))?.config?.contactScoped === true,
    configPath: (id) => byId.get(clean(id))?.config?.path || null,
    contactConfigEntries: () => freezeArray(contactConfigs),
    runtimeStatus: (id) => byId.get(clean(id))?.runtimeStatus || "",
    resources: (id) => freezeArray((byId.get(clean(id))?.resources || [])),
    agentActions: ({ capabilityId = "" } = {}) => {
      const actions = [];
      for (const capability of selectedCapabilities(entries, capabilityId)) {
        for (const resource of capability.resources) {
          if (!resource.agentAction) continue;
          actions.push(Object.freeze({
            capabilityId: capability.id,
            capabilityName: capability.name,
            capabilityDescription: capability.description,
            resourceId: resource.id,
            resourceKind: resource.kind,
            ...(resource.driver ? { driver: resource.driver } : {}),
            action: resource.agentAction.id,
            actionDescription: resource.agentAction.description,
            ...(resource.agentAction.name ? { actionName: resource.agentAction.name } : {}),
          }));
        }
      }
      return freezeArray(actions);
    },
    createHookModules: ({ dataRoot, memoryRuntime = null } = {}) => {
      const modules = [];
      for (const capability of entries) {
        for (const resource of capability.resources) {
          if (resource.kind !== "hook" || !resource.lifecycle.includes("mount")) continue;
          const module = hookModule({ capability, resource, dataRoot, memoryRuntime, hookFactories: factories });
          if (module) modules.push(module);
        }
      }
      return freezeArray(modules);
    },
  };
  return Object.freeze(registry);
}

/**
 * Attach concrete host/product work to declarative resources.  A missing
 * adapter is reported, never guessed: adding an MCP/Skill/CLI declaration
 * alone cannot accidentally activate an undeclared integration.
 */
export function createCapabilityRuntime({ registry = createCapabilityRegistry(), adapters = {}, canInvoke = null } = {}) {
  if (!registry || typeof registry.definitions !== "function") {
    throw new CapabilityRegistryError("能力运行时需要能力注册表。", { code: "REGISTRY_REQUIRED" });
  }
  if (canInvoke !== null && typeof canInvoke !== "function") {
    throw new CapabilityRegistryError("能力运行时的动作访问策略必须是函数。", { code: "ACTION_ACCESS_POLICY_INVALID" });
  }
  const byDriver = plainObject(adapters);
  const actionAllowed = (action, context = {}) => {
    if (typeof canInvoke !== "function") return true;
    const capability = registry.get?.(clean(action?.capabilityId)) || null;
    if (!capability) return false;
    try {
      return canInvoke(Object.freeze({
        capability,
        action,
        context: Object.freeze({ ...plainObject(context) }),
      })) !== false;
    } catch {
      // A missing or unreadable product configuration must never expose an
      // optional action merely because its adapter is installed.
      return false;
    }
  };
  const dispatch = async ({ lifecycle, capabilityId = "", context = {} } = {}) => {
    const event = clean(lifecycle);
    if (!RESOURCE_LIFECYCLE_SET.has(event)) {
      throw new CapabilityRegistryError(`未知能力生命周期：${event || "（空）"}。`, { code: "RESOURCE_LIFECYCLE_UNKNOWN" });
    }
    const results = [];
    for (const capability of selectedCapabilities(registry.definitions(), capabilityId)) {
      for (const resource of capability.resources) {
        if (!resource.lifecycle.includes(event)) continue;
        const adapter = byDriver[resource.driver] || byDriver[resource.kind];
        if (typeof adapter !== "function") {
          results.push(Object.freeze({
            capabilityId: capability.id,
            resourceId: resource.id,
            kind: resource.kind,
            status: "adapter-not-connected",
          }));
          continue;
        }
        const value = await adapter(Object.freeze({
          capability,
          resource,
          lifecycle: event,
          context: Object.freeze({ ...plainObject(context) }),
        }));
        results.push(Object.freeze({
          capabilityId: capability.id,
          resourceId: resource.id,
          kind: resource.kind,
          status: "completed",
          ...(value === undefined ? {} : { value }),
        }));
      }
    }
    return freezeArray(results);
  };
  const recordUsage = async ({ capabilityId, ...context } = {}) => {
    const results = [];
    for (const capability of selectedCapabilities(registry.definitions(), capabilityId)) {
      for (const resource of capability.resources) {
        if (resource.kind !== "usage") continue;
        const adapter = byDriver[resource.driver] || byDriver[resource.kind];
        if (typeof adapter !== "function") {
          results.push(Object.freeze({
            capabilityId: capability.id,
            resourceId: resource.id,
            kind: resource.kind,
            status: "adapter-not-connected",
          }));
          continue;
        }
        const value = await adapter(Object.freeze({
          capability,
          resource,
          lifecycle: "usage",
          context: Object.freeze({ ...plainObject(context) }),
        }));
        results.push(Object.freeze({
          capabilityId: capability.id,
          resourceId: resource.id,
          kind: resource.kind,
          status: "completed",
          ...(value === undefined ? {} : { value }),
        }));
      }
    }
    return freezeArray(results);
  };
  const availableActions = ({ capabilityId = "", ...context } = {}) => {
    if (typeof registry.agentActions !== "function") {
      throw new CapabilityRegistryError("能力注册表不支持 Agent 动作目录。", { code: "AGENT_ACTION_CATALOG_UNAVAILABLE" });
    }
    return freezeArray(registry.agentActions({ capabilityId }).flatMap((action) => {
      if (!actionAllowed(action, context)) return [];
      const adapter = byDriver[action.driver] || byDriver[action.resourceKind];
      if (typeof adapter !== "function") return [];
      return [Object.freeze({ ...action })];
    }));
  };
  const invoke = async ({ capabilityId, action, ...context } = {}) => {
    const targetCapabilityId = clean(capabilityId);
    const targetAction = clean(action);
    const capability = registry.get?.(targetCapabilityId) || null;
    if (!capability) {
      return Object.freeze({
        capabilityId: targetCapabilityId,
        action: targetAction,
        status: "capability-not-found",
      });
    }
    const declared = typeof registry.agentActions === "function"
      ? registry.agentActions({ capabilityId: targetCapabilityId })
      : [];
    const selected = declared.find((entry) => entry.action === targetAction) || null;
    if (!selected) {
      return Object.freeze({
        capabilityId: targetCapabilityId,
        action: targetAction,
        status: "action-not-found",
      });
    }
    if (!actionAllowed(selected, context)) {
      return Object.freeze({
        capabilityId: targetCapabilityId,
        action: targetAction,
        resourceId: selected.resourceId,
        kind: selected.resourceKind,
        status: "capability-not-enabled",
        error: Object.freeze({
          code: "CAPABILITY_NOT_ENABLED",
          message: "这项能力尚未为当前联系人启用。",
        }),
      });
    }
    const resource = capability.resources.find((entry) => entry.id === selected.resourceId) || null;
    const adapter = byDriver[selected.driver] || byDriver[selected.resourceKind];
    if (!resource || typeof adapter !== "function") {
      return Object.freeze({
        capabilityId: targetCapabilityId,
        action: targetAction,
        resourceId: selected.resourceId,
        kind: selected.resourceKind,
        status: "adapter-not-connected",
      });
    }
    try {
      const value = await adapter(Object.freeze({
        capability,
        resource,
        lifecycle: "invoke",
        action: selected,
        context: Object.freeze({ ...plainObject(context) }),
      }));
      return Object.freeze({
        capabilityId: targetCapabilityId,
        action: targetAction,
        resourceId: selected.resourceId,
        kind: selected.resourceKind,
        status: "completed",
        ...(value === undefined ? {} : { value }),
      });
    } catch (error) {
      return Object.freeze({
        capabilityId: targetCapabilityId,
        action: targetAction,
        resourceId: selected.resourceId,
        kind: selected.resourceKind,
        status: "failed",
        error: Object.freeze({
          code: clean(error?.code) || "CAPABILITY_ACTION_FAILED",
          message: clean(error?.message) || "能力动作执行失败。",
        }),
      });
    }
  };
  return Object.freeze({
    dispatch,
    sync: ({ capabilityId, ...context } = {}) => dispatch({ lifecycle: "sync", capabilityId, context }),
    removeContact: ({ capabilityId = "", ...context } = {}) => dispatch({ lifecycle: "remove-contact", capabilityId, context }),
    install: ({ capabilityId, ...context } = {}) => dispatch({ lifecycle: "install", capabilityId, context }),
    uninstall: ({ capabilityId, ...context } = {}) => dispatch({ lifecycle: "uninstall", capabilityId, context }),
    availableActions,
    invoke,
    recordUsage,
  });
}
