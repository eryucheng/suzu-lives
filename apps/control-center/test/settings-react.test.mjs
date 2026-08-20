import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");

test("React settings keeps software updates in the existing settings action chain", () => {
  const page = readFileSync(resolve(ROOT, "src", "react", "settings-page.jsx"), "utf8");
  const app = readFileSync(resolve(ROOT, "src", "app.mjs"), "utf8");

  assert.match(page, /function SoftwareUpdate/u);
  assert.match(page, /软件更新/u);
  assert.match(page, /检查更新/u);
  assert.match(page, /下载更新/u);
  assert.match(page, /重启并安装/u);
  assert.match(page, /development: \{ action: null, button: "开发版不检查"/u);
  assert.match(page, /disabled=\{Boolean\(pending\) \|\| !presentation\.action\}/u);
  assert.match(page, /actions\.checkForUpdate/u);
  assert.match(page, /actions\.downloadUpdate/u);
  assert.match(page, /actions\.installUpdate/u);
  assert.match(app, /api\.settings\?\.\[method\]/u);
  assert.match(app, /runAppUpdateAction\("checkForUpdate"/u);
  assert.match(app, /runAppUpdateAction\("downloadUpdate"/u);
  assert.match(app, /runAppUpdateAction\("installUpdate"/u);
});

test("React settings exposes one current release announcement, not a changelog list", () => {
  const page = readFileSync(resolve(ROOT, "src", "react", "settings-page.jsx"), "utf8");
  const shell = readFileSync(resolve(ROOT, "src", "react", "app-shell.jsx"), "utf8");
  const app = readFileSync(resolve(ROOT, "src", "app.mjs"), "utf8");

  assert.match(page, /查看本次公告/u);
  assert.match(page, /onOpenReleaseAnnouncement/u);
  assert.match(shell, /function ReleaseAnnouncementDialog/u);
  assert.match(shell, /surface="glass"/u);
  assert.match(shell, /知道了/u);
  assert.match(app, /api\.settings\?\.releaseAnnouncementStatus/u);
  assert.match(app, /acknowledgeReleaseAnnouncement/u);
});

test("React settings keeps an always-available entry back to the first-run guide", () => {
  const page = readFileSync(resolve(ROOT, "src", "react", "settings-page.jsx"), "utf8");
  const app = readFileSync(resolve(ROOT, "src", "app.mjs"), "utf8");

  assert.match(page, /GETTING STARTED/u);
  assert.match(page, /首次引导/u);
  assert.match(page, /打开首次引导/u);
  assert.match(page, /onOpenOnboarding=\{actions\.openOnboarding\}/u);
  assert.match(app, /openOnboarding,\s*\n\s*openReleaseAnnouncement,/u);
  assert.match(app, /allowCompleted: true/u);
});

test("React data settings exposes the read-only system status check", () => {
  const page = readFileSync(resolve(ROOT, "src", "react", "settings-page.jsx"), "utf8");
  const app = readFileSync(resolve(ROOT, "src", "app.mjs"), "utf8");

  assert.match(page, /系统状态检查/u);
  assert.match(page, /检查系统状态/u);
  assert.match(page, /外部\/自定义/u);
  assert.match(page, /onCheckSystemStatus/u);
  assert.match(page, /sortSystemStatusSections\(snapshot\?\.sections\)/u);
  assert.match(app, /api\.settings\?\.systemStatus/u);
  assert.match(app, /checkSystemStatus/u);
});

test("settings owns the reusable API connection library without a global capability binding list", () => {
  const page = readFileSync(resolve(ROOT, "src", "react", "settings-page.jsx"), "utf8");
  const apiConnections = readFileSync(resolve(ROOT, "src", "react", "api-connections-ui.jsx"), "utf8");
  const capabilityDetail = readFileSync(resolve(ROOT, "src", "react", "capability-detail-page.jsx"), "utf8");
  const admin = readFileSync(resolve(ROOT, "src", "react", "admin-page.jsx"), "utf8");
  const app = readFileSync(resolve(ROOT, "src", "app.mjs"), "utf8");

  assert.match(page, /\{ label: "主模型", value: "main-model" \}/u);
  assert.match(page, /\{ label: "API", value: "api" \}/u);
  assert.match(page, /ApiConnectionsSettings/u);
  assert.match(apiConnections, /备注名称/u);
  assert.match(apiConnections, /不能和已有 API 重名/u);
  assert.match(apiConnections, /<Drawer/u);
  assert.match(apiConnections, /connection\.name/u);
  assert.match(capabilityDetail, /<ApiConnectionPicker/u);
  assert.doesNotMatch(admin, /function ApiBindings/u);
  assert.match(app, /\["general", "main-model", "api", "data", "privacy"\]/u);
  assert.match(app, /state\.settingsTab === "main-model"\) void loadAgentRuntimeConfig\(context\)/u);
  assert.match(app, /state\.settingsTab === "api"\) void loadApiServices\(context\)/u);
});

test("system status results can be collapsed without shrinking the settings tabs", () => {
  const page = readFileSync(resolve(ROOT, "src", "react", "settings-page.jsx"), "utf8");
  const styles = readFileSync(resolve(ROOT, "src", "react", "settings-page.css"), "utf8");

  assert.match(page, /const \[resultsOpen, setResultsOpen\] = useState\(true\)/u);
  assert.match(page, /收起检查结果/u);
  assert.match(page, /查看检查结果/u);
  assert.match(page, /hidden=\{!resultsOpen\}/u);
  assert.match(styles, /\.settings-system-status-results\[hidden\]\s*\{\s*display:none;/u);
  assert.match(styles, /#content\.content--settings > #settingsReactRoot\s*\{[\s\S]*?display:block;[\s\S]*?flex:0 0 auto;/u);
});
