import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { WECHAT_DELIVERY_OPTIONS, wechatConnectionSettings } from "../src/features/capabilities/overview.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function source(...parts) {
  return readFile(resolve(ROOT, ...parts), "utf8");
}

test("WeChat approval prompts are a separate delivery setting and default to on", () => {
  const permissions = WECHAT_DELIVERY_OPTIONS.find(([key]) => key === "permissions");
  assert.deepEqual(permissions, ["permissions", "审批提示", "工具需要确认时提醒；可回复“允许”或“拒绝”，默认投递"]);
  const settings = wechatConnectionSettings({ enabled: true, delivery: { tools: false } });
  assert.equal(settings.delivery.permissions, true);
  assert.equal(settings.delivery.tools, false);
});

test("public capability inner pages reuse every existing save and switch boundary", async () => {
  const [app, overview, detail] = await Promise.all([
    source("src", "app.mjs"),
    source("src", "react", "capabilities-page.jsx"),
    source("src", "react", "capability-detail-page.jsx"),
  ]);

  for (const setting of [
    "ImageGenerationSettings",
    "PhoneCameraSettings",
    "ImageVisionSettings",
    "VideoUnderstandingSettings",
    "VoiceMessageSettings",
    "ProactiveContactSettings",
  ]) {
    assert.match(detail, new RegExp(`function ${setting}`, "u"));
  }
  assert.match(detail, /WechatSettings/u);
  assert.match(detail, /ExternalCapabilitiesPage/u);
  assert.match(detail, /CapabilitySettingsForm/u);
  assert.match(detail, /actions\.setContactEnabled/u);
  assert.match(detail, /在哪些联系人中启用/u);
  assert.match(detail, /label="自动维护"/u);
  assert.match(detail, /autoMaintain: enabled/u);
  assert.match(detail, /contact\.name/u);
  assert.doesNotMatch(detail, /session\.title/u);
  assert.match(detail, /actions\.selectApiBinding/u);
  assert.doesNotMatch(overview, /当前联系人|联系人项目/u);
  assert.doesNotMatch(detail, /当前联系人|联系人项目/u);

  assert.match(app, /api\.capabilities\.setActive/u);
  assert.match(app, /contactId, contactEnabled/u);
  assert.match(app, /api\.capabilities\.saveSettings/u);
  assert.match(app, /api\.wechat\.saveSettings/u);
  assert.match(app, /api\.externalCapabilities\.importManifest/u);
  assert.match(app, /api\.externalCapabilities\.setEnabled/u);
  assert.match(app, /api\.externalCapabilities\.remove/u);
  assert.match(app, /api\.connections\.bindNamedApiConnection/u);
});
