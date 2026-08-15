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
  assert.match(page, /actions\.checkForUpdate/u);
  assert.match(page, /actions\.downloadUpdate/u);
  assert.match(page, /actions\.installUpdate/u);
  assert.match(app, /api\.settings\?\.\[method\]/u);
  assert.match(app, /runAppUpdateAction\("checkForUpdate"/u);
  assert.match(app, /runAppUpdateAction\("downloadUpdate"/u);
  assert.match(app, /runAppUpdateAction\("installUpdate"/u);
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

test("system status results can be collapsed without shrinking the settings tabs", () => {
  const page = readFileSync(resolve(ROOT, "src", "react", "settings-page.jsx"), "utf8");
  const styles = readFileSync(resolve(ROOT, "src", "react", "settings-page.css"), "utf8");

  assert.match(page, /const \[resultsOpen, setResultsOpen\] = useState\(true\)/u);
  assert.match(page, /收起检查结果/u);
  assert.match(page, /查看检查结果/u);
  assert.match(page, /hidden=\{!resultsOpen\}/u);
  assert.match(styles, /#content\.content--settings > #settingsReactRoot\s*\{[\s\S]*?display:block;[\s\S]*?flex:0 0 auto;/u);
});
