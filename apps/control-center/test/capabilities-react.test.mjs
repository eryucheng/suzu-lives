import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  capabilityOverview,
  createQQConnectionCapability,
  createWechatConnectionCapability,
  QQ_DELIVERY_OPTIONS,
  QQ_TEXT_SEGMENTATION_OPTIONS,
  qqConnectionSettings,
  WECHAT_DELIVERY_OPTIONS,
  WECHAT_TEXT_SEGMENTATION_OPTIONS,
  wechatConnectionSettings,
} from "../src/features/capabilities/overview.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function source(...parts) {
  return readFile(resolve(ROOT, ...parts), "utf8");
}

test("WeChat delivery keeps approval prompts enabled by default", () => {
  const permissions = WECHAT_DELIVERY_OPTIONS.find(([key]) => key === "permissions");
  const proactive = WECHAT_DELIVERY_OPTIONS.find(([key]) => key === "proactive");
  assert.deepEqual(permissions, ["permissions", "审批请求", "工具需要确认时的提醒，可回复“允许”或“拒绝”，默认投递"]);
  assert.deepEqual(proactive, ["proactive", "主动关心", "Suzu 主动发起的联系，默认投递"]);
  const settings = wechatConnectionSettings({ delivery: { tools: false } });
  assert.equal(settings.delivery.permissions, true);
  assert.equal(settings.delivery.proactive, true);
  assert.equal(settings.delivery.tools, false);
  assert.deepEqual(WECHAT_TEXT_SEGMENTATION_OPTIONS, [["paragraph", "空行分段"], ["sentence", "句子分段"]]);
  assert.equal(settings.textSegmentation, "paragraph");
});

test("QQ delivery keeps approval prompts enabled by default", () => {
  const permissions = QQ_DELIVERY_OPTIONS.find(([key]) => key === "permissions");
  const proactive = QQ_DELIVERY_OPTIONS.find(([key]) => key === "proactive");
  assert.deepEqual(permissions, ["permissions", "审批请求", "工具需要确认时的提醒，可回复“允许”或“拒绝”，默认投递"]);
  assert.deepEqual(proactive, ["proactive", "主动关心", "Suzu 主动发起的联系，默认投递"]);
  const settings = qqConnectionSettings({ delivery: { tools: false } });
  assert.equal(settings.delivery.permissions, true);
  assert.equal(settings.delivery.proactive, true);
  assert.equal(settings.delivery.tools, false);
  assert.deepEqual(QQ_TEXT_SEGMENTATION_OPTIONS, [["paragraph", "空行分段"], ["sentence", "句子分段"]]);
  assert.equal(settings.textSegmentation, "paragraph");
});

test("WeChat capability configures delivery and reply segmentation", async () => {
  const detail = await source("src", "react", "capability-detail-page.jsx");
  const start = detail.indexOf("function WechatSettings");
  const end = detail.indexOf("function GenericCapabilitySettings");
  const wechat = detail.slice(start, end);

  assert.match(wechat, /title="投送到微信的内容"/u);
  assert.match(wechat, /WECHAT_DELIVERY_OPTIONS/u);
  assert.match(wechat, /title="回复分段方式"/u);
  assert.match(wechat, /WECHAT_TEXT_SEGMENTATION_OPTIONS/u);
  assert.match(wechat, /textSegmentation/u);
  assert.doesNotMatch(wechat, /微信连接已开启|微信连接已关闭|按联系人绑定|settings\.enabled|settings\.linkedContacts/u);
});

test("QQ capability keeps bot setup separate from contact binding", async () => {
  const detail = await source("src", "react", "capability-detail-page.jsx");
  const start = detail.indexOf("function QQSettings");
  const end = detail.indexOf("function GenericCapabilitySettings");
  const qq = detail.slice(start, end);

  assert.match(qq, /title="QQ 机器人"/u);
  assert.match(qq, /name?=/u);
  assert.match(qq, /actions\.configureQqBot/u);
  assert.match(qq, /打开想连接的联系人设置/u);
  assert.match(qq, /用 QQ 将绑定码发送给机器人/u);
  assert.doesNotMatch(qq, /entryUrl|setEntryUrl/u);
  assert.match(qq, /title="投送到 QQ 的内容"/u);
  assert.match(qq, /QQ_DELIVERY_OPTIONS/u);
  assert.match(qq, /QQ_TEXT_SEGMENTATION_OPTIONS/u);
  assert.match(qq, /回复只会回到 QQ/u);
  assert.doesNotMatch(qq, /当前联系人|联系人项目/u);
});

test("capability inner pages reuse every existing save and switch boundary", async () => {
  const [app, overview, detail] = await Promise.all([
    source("src", "app.mjs"),
    source("src", "react", "capabilities-page.jsx"),
    source("src", "react", "capability-detail-page.jsx"),
  ]);

  for (const setting of [
    "ImageGenerationSettings",
    "ImageVisionSettings",
    "VideoUnderstandingSettings",
    "VoiceMessageSettings",
    "WebBrowserSettings",
    "AgentJournalSettings",
    "ProactiveContactSettings",
  ]) {
    assert.match(detail, new RegExp(`function ${setting}`, "u"));
  }
  assert.match(detail, /WechatSettings/u);
  assert.match(detail, /QQSettings/u);
  assert.match(detail, /capabilityVisibleInCatalog/u);
  assert.match(detail, /ExternalCapabilitiesPage/u);
  assert.match(detail, /CapabilitySettingsForm/u);
  assert.match(detail, /actions\.setContactEnabled/u);
  assert.match(detail, /在哪些联系人中启用/u);
  assert.match(detail, /label="自动安排联系检查"/u);
  assert.match(detail, /每天写日记/u);
  assert.match(detail, /agent-journal/u);
  assert.match(detail, /autoMaintain: enabled/u);
  assert.match(detail, /contact\.name/u);
  assert.doesNotMatch(detail, /session\.title/u);
  assert.match(detail, /网页自动化/u);
  assert.match(detail, /执行页面脚本/u);
  assert.doesNotMatch(detail, /setSiteAction/u);
  assert.doesNotMatch(detail, /TravelingMerchantSettings/u);
  assert.match(detail, /actions\.selectApiBinding/u);
  assert.doesNotMatch(overview, /当前联系人|联系人项目/u);
  assert.doesNotMatch(overview, /当前已启用/u);
  assert.doesNotMatch(detail, /当前联系人|联系人项目/u);

  assert.match(app, /api\.capabilities\.setActive/u);
  assert.match(app, /contactId, contactEnabled/u);
  assert.match(app, /api\.capabilities\.saveSettings/u);
  assert.match(app, /api\.wechat\.saveSettings/u);
  assert.match(app, /api\.qq\.saveSettings/u);
  assert.match(app, /api\.qq\.configure/u);
  assert.match(app, /api\.externalCapabilities\.importManifest/u);
  assert.match(app, /api\.externalCapabilities\.setEnabled/u);
  assert.match(app, /api\.externalCapabilities\.remove/u);
  assert.match(app, /api\.connections\.bindNamedApiConnection/u);
  assert.doesNotMatch(app, /api\.capabilities\.openTravelingMerchantPage/u);
});

test("image vision keeps processing policy inside the capability", async () => {
  const detail = await source("src", "react", "capability-detail-page.jsx");
  const start = detail.indexOf("function ImageVisionSettings");
  const end = detail.indexOf("function VideoUnderstandingSettings");
  const imageVision = detail.slice(start, end);

  assert.match(imageVision, /title="请求方式"/u);
  assert.match(imageVision, /bindingId="image-vision"/u);
  assert.match(imageVision, /ContactDeliverySettings/u);
  assert.match(imageVision, /CapabilitySettingsForm abilityId="image-vision"/u);
  assert.match(imageVision, /VISION_ADAPTER_OPTIONS/u);
  assert.match(imageVision, /新增自定义协议/u);
  assert.match(imageVision, /IMAGE_VISION_CUSTOM_PROTOCOL_PREFIX/u);
  assert.match(imageVision, /name="adapter"/u);
  assert.match(imageVision, /name="customAdapterId"/u);
  assert.match(imageVision, /CustomVisionAdapterDialog/u);
  assert.doesNotMatch(imageVision, /title="自定义协议"/u);
  assert.doesNotMatch(imageVision, /图片读取精度|等待时间|最长回复|最大图片大小|最长边|压缩质量|遇到拒答/u);
});

test("image generation keeps phone-camera presentation rules out of user settings", async () => {
  const detail = await source("src", "react", "capability-detail-page.jsx");
  const imageGenerationStart = detail.indexOf("function ImageGenerationSettings");
  const imageGenerationEnd = detail.indexOf("const CUSTOM_TTS_RESPONSE_OPTIONS");
  const imageGeneration = detail.slice(imageGenerationStart, imageGenerationEnd);

  assert.match(imageGeneration, /IMAGE_GENERATION_ADAPTER_OPTIONS/u);
  assert.match(imageGeneration, /IMAGE_GENERATION_CUSTOM_PROTOCOL_PREFIX/u);
  assert.match(imageGeneration, /请求协议/u);
  assert.match(imageGeneration, /新增自定义协议/u);
  assert.match(imageGeneration, /bindingId="image-generation"/u);
  assert.match(imageGeneration, /name="adapter"/u);
  assert.match(imageGeneration, /name="customAdapterId"/u);
  assert.match(imageGeneration, /CustomImageGenerationAdapterDialog/u);
  assert.doesNotMatch(imageGeneration, /手机拍照式图片|画面预设|rearSize|selfieSize|mirrorSize|maxImages|promptPrefix|promptSuffix/u);
  assert.doesNotMatch(detail, /function PhoneCameraSettings/u);
});

test("mail bridge presents business mail Skills separately from mailbox connection details", async () => {
  const detail = await source("src", "react", "capability-detail-page.jsx");
  const start = detail.indexOf("function MailAgentSkillDialog");
  const end = detail.indexOf("function WechatSettings");
  const mailBridge = detail.slice(start, end);

  assert.match(mailBridge, /title="邮件业务 Skill"/u);
  assert.match(mailBridge, /name="mailSkillName"/u);
  assert.match(mailBridge, /name="mailSkillDescription"/u);
  assert.match(mailBridge, /name="mailSkillSubject"/u);
  assert.match(mailBridge, /新增邮件 Skill/u);
  assert.match(mailBridge, /mail-agent-skill-list/u);
  assert.match(mailBridge, /配置邮箱连接/u);
  assert.match(mailBridge, /接收回信的主题/u);
  assert.match(mailBridge, /高级服务器设置/u);
  assert.match(mailBridge, /name="feedbackSubject"/u);
  assert.doesNotMatch(mailBridge, /deliverySubject|deliveryDescription|邮件主题路由|交给 Agent 的邮件提示词|routePrompt|routeSubject/u);
});

test("video understanding keeps request protocol selection beside its API binding", async () => {
  const detail = await source("src", "react", "capability-detail-page.jsx");
  const start = detail.indexOf("function VideoUnderstandingSettings");
  const end = detail.indexOf("function WebBrowserSettings");
  const videoUnderstanding = detail.slice(start, end);

  assert.match(videoUnderstanding, /title="请求方式"/u);
  assert.match(videoUnderstanding, /bindingId="video-understanding"/u);
  assert.match(videoUnderstanding, /VIDEO_ADAPTER_OPTIONS/u);
  assert.match(videoUnderstanding, /新增自定义协议/u);
  assert.match(videoUnderstanding, /VIDEO_UNDERSTANDING_CUSTOM_PROTOCOL_PREFIX/u);
  assert.match(videoUnderstanding, /name="adapter"/u);
  assert.match(videoUnderstanding, /name="customAdapterId"/u);
  assert.match(videoUnderstanding, /CustomVideoAdapterDialog/u);
  assert.doesNotMatch(videoUnderstanding, /title="自定义协议"/u);
  assert.doesNotMatch(videoUnderstanding, /模型读取密度|保留本地缓存|title="处理细节"|等待时间|最长回复|最大处理大小|FFmpeg|FFprobe/u);
});

test("voice message uses adapters and keeps custom adapters in the request-protocol selector", async () => {
  const detail = await source("src", "react", "capability-detail-page.jsx");
  const start = detail.indexOf("function VoiceServiceDialog");
  const end = detail.indexOf("function VoiceProfileDialog");
  const voiceService = detail.slice(start, end);
  const voiceMessageStart = detail.indexOf("function VoiceMessageSettings");
  const voiceMessageEnd = detail.indexOf("const IMAGE_VISION_CUSTOM_PROTOCOL_PREFIX");
  const voiceMessage = detail.slice(voiceMessageStart, voiceMessageEnd);

  assert.match(voiceService, /VOICE_SERVICE_CUSTOM_PROTOCOL_PREFIX/u);
  assert.match(voiceService, /VOICE_SERVICE_PROTOCOL_OPTIONS/u);
  assert.match(voiceService, /请求协议/u);
  assert.match(voiceService, /新增自定义协议/u);
  assert.match(voiceService, /语音适配器/u);
  assert.match(voiceService, /onOpenCustomProtocol/u);
  assert.doesNotMatch(voiceService, /服务类型<Select/u);
  assert.doesNotMatch(voiceService, /<label>自定义协议<Select/u);
  assert.match(voiceMessage, /onOpenCustomProtocol=\{\(\) => setCustomProtocolOpen\(true\)\}/u);
  assert.match(voiceMessage, /eyebrow="VOICE ADAPTERS"/u);
  assert.doesNotMatch(voiceMessage, /eyebrow="CUSTOM ADAPTERS"/u);
  assert.doesNotMatch(voiceMessage, /deleteCustomTtsAdapter/u);
  assert.doesNotMatch(voiceMessage, /eyebrow="VOICE SERVICES"/u);
});

test("companion catalog keeps external chat connectors and mail while moving proactive contact into contact settings", () => {
  const overview = capabilityOverview({
    capabilitySnapshot: {
      capabilities: [
        { category: "companion", id: "mail-bridge", name: "邮箱通道" },
        { category: "companion", id: "proactive-contact", name: "主动关心" },
        { category: "act", id: "agent-journal", name: "日记" },
      ],
    },
    wechatSnapshot: { enabled: true },
    qqSnapshot: { bot: { configured: true } },
  });

  assert.equal(createWechatConnectionCapability({}).category, "companion");
  assert.equal(createQQConnectionCapability({}).category, "companion");
  assert.deepEqual(
    overview.capabilities.filter((capability) => capability.category === "companion").map((capability) => capability.id),
    ["mail-bridge", "wechat-connection", "qq-connection"],
  );
  assert.equal(overview.capabilities.some((capability) => capability.id === "proactive-contact"), false);
});
