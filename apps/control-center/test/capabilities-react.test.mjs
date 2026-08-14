import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function source(...parts) {
  return readFile(resolve(ROOT, ...parts), "utf8");
}

test("capability inner pages reuse every existing save and switch boundary", async () => {
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
