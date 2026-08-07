import assert from "node:assert/strict";
import test from "node:test";

import { renderAdmin } from "../src/features/agent/index.mjs";
import { renderSettings } from "../src/features/settings/index.mjs";

test("management keeps API records out of the main view and centers the five user-facing functions", () => {
  const view = renderAdmin({ state: { adminTab: "api-services", apiServices: { connections: [{ id: "dash", name: "阿里百炼", type: "dashscope", service: "DashScope", baseUrl: "https://example.test/api/v1", configured: true }], bindings: { "voice-design": "dash", "voice-message": "dash" }, comfy: { baseUrl: "http://127.0.0.1:8188", workflows: [] } } } });
  assert.match(view, /data-open-api-manager/);
  assert.match(view, /生图/);
  assert.match(view, /理解图像/);
  assert.match(view, /声音/);
  assert.match(view, /理解视频/);
  assert.match(view, /记忆向量/);
  assert.match(view, /为功能选择 API/);
  assert.match(view, /data-api-binding="sound"/);
  assert.match(view, /data-api-binding="memory-embedding"/);
  assert.match(view, /api-binding-picker__trigger/);
  assert.doesNotMatch(view, /<select class="api-binding-card__select"/);
  assert.doesNotMatch(view, /api-connection-card/);
  assert.doesNotMatch(view, /已保存：/);
  assert.doesNotMatch(view, /服务地址/);
  assert.doesNotMatch(view, /还没填密钥/);
  assert.doesNotMatch(view, /发送语音/);
  assert.doesNotMatch(view, /fixture-secret/u);
});

test("API page keeps management and editor out of the main function view until opened", () => {
  const view = renderAdmin({ state: { adminTab: "api-services", apiServices: { connections: [], bindings: {}, comfy: { workflows: [] } } } });
  assert.match(view, /data-open-api-manager/);
  assert.match(view, /为功能选择 API/);
  assert.doesNotMatch(view, /apiConnectionManagerTitle/);
  assert.doesNotMatch(view, /id="namedApiConnectionForm"/);
  assert.doesNotMatch(view, /生成附加参数 JSON/);
});

test("API bindings use the in-app picker rather than a native select menu", () => {
  const view = renderAdmin({ state: { adminTab: "api-services", apiBindingPickerOpen: "image-vision", apiServices: { connections: [{ id: "vision", name: "视觉", type: "openai-compatible", configured: true }], bindings: {}, comfy: { workflows: [] } } } });
  assert.match(view, /data-open-api-binding="image-vision"/);
  assert.match(view, /aria-expanded="true"/);
  assert.match(view, /data-select-api-binding="image-vision"/);
  assert.doesNotMatch(view, /<select class="api-binding-card__select"/);
});

test("API manager shows saved APIs as compact rows only after it is opened", () => {
  const view = renderAdmin({ state: { adminTab: "api-services", apiConnectionManagerOpen: true, apiServices: { connections: [{ id: "dash", name: "阿里百炼", type: "dashscope", configured: true }], bindings: { "voice-design": "dash" }, comfy: { workflows: [] } } } });
  assert.match(view, /id="apiConnectionManagerTitle"/);
  assert.match(view, /阿里百炼/);
  assert.match(view, /用于 声音/);
  assert.match(view, /data-edit-api-connection="dash"/);
  assert.doesNotMatch(view, /服务地址/);
  assert.doesNotMatch(view, /还没填密钥/);
  assert.doesNotMatch(view, /api-connection-card/);
});

test("a configured API offers a way to continue the unfinished first setup", () => {
  const view = renderAdmin({ state: { adminTab: "api-services", settings: { onboardingCompleted: false, contactsRoot: "", projectRoot: "" }, apiServices: { connections: [{ id: "dash", name: "阿里百炼", type: "dashscope", configured: true }], bindings: {}, comfy: { workflows: [] } } } });
  assert.match(view, /data-continue-onboarding/);
  assert.match(view, /继续首次设置/u);
});

test("new API editor defaults to 阿里百炼 and hides its built-in address", () => {
  const view = renderAdmin({ state: { adminTab: "api-services", apiConnectionEditorOpen: true, apiServices: { connections: [], bindings: {}, comfy: { workflows: [] } } } });
  assert.match(view, /name="name" value="阿里百炼"/);
  assert.match(view, /data-api-name-field hidden/);
  assert.match(view, /data-api-type-field/);
  assert.match(view, /<option value="dashscope" selected>阿里百炼<\/option>/);
  assert.match(view, /data-api-key-field/);
  assert.match(view, /data-api-base-url hidden/);
  assert.match(view, /name="baseUrl" value="" maxlength="500" disabled/);
  assert.doesNotMatch(view, /API 格式/);
});

test("generic image API connection editor preserves separate generation and edit extension fields", () => {
  const view = renderAdmin({ state: { adminTab: "api-services", apiConnectionEditingId: "image", apiServices: { connections: [{ id: "image", name: "图像服务", type: "openai-compatible", service: "OpenAI Compatible", baseUrl: "https://images.example.test/v1", model: "fixture", configured: true, extraBody: { response_format: "b64_json" }, editExtraBody: { mask_mode: "alpha" } }], bindings: {}, comfy: { baseUrl: "http://127.0.0.1:8188", workflows: [] } } } });
  assert.match(view, /生成附加参数 JSON/);
  assert.match(view, /编辑附加参数 JSON/);
  assert.match(view, /name="extraBody"/);
  assert.match(view, /name="editExtraBody"/);
  assert.match(view, /response_format/);
});

test("software settings no longer exposes a services tab", () => {
  const view = renderSettings({ state: { settingsTab: "services", settings: {} } });
  assert.doesNotMatch(view, /data-settings-tab="services"/);
  assert.doesNotMatch(view, /云 API 连接/);
});
