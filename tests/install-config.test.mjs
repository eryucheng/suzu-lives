import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(repositoryRoot, relativePath), "utf8"));
}

function commandPaths(entries = []) {
  return entries.flatMap((entry) => entry.hooks ?? []).map((hook) => hook.args?.[0]);
}

test("整套 Claude Code 配置包含三个模块且使用可移植路径", () => {
  const settings = readJson("integrations/claude-code/settings.example.json");
  const userPromptPaths = commandPaths(settings.hooks?.UserPromptSubmit);
  const displayPaths = commandPaths(settings.hooks?.MessageDisplay);

  assert.deepEqual(userPromptPaths, [
    "${CLAUDE_PROJECT_DIR}/scripts/hooks/time-awareness/timehook.mjs",
    "${CLAUDE_PROJECT_DIR}/memory/rag/hook.mjs",
  ]);
  assert.deepEqual(displayPaths, [
    "${CLAUDE_PROJECT_DIR}/scripts/hooks/wechat-splitter/md_send.py",
  ]);

  for (const scriptPath of [...userPromptPaths, ...displayPaths]) {
    assert.ok(scriptPath.startsWith("${CLAUDE_PROJECT_DIR}/"));
    const relativePath = scriptPath.slice("${CLAUDE_PROJECT_DIR}/".length);
    assert.ok(fs.existsSync(path.join(repositoryRoot, relativePath)), `${relativePath} 不存在`);
  }
});

test("单模块 Hook 示例与整套配置保持一致", () => {
  const combined = readJson("integrations/claude-code/settings.example.json");
  const timeOnly = readJson("scripts/hooks/time-awareness/settings.example.json");
  const splitterOnly = readJson("scripts/hooks/wechat-splitter/settings.example.json");

  assert.deepEqual(
    combined.hooks.UserPromptSubmit[0],
    timeOnly.hooks.UserPromptSubmit[0],
  );
  assert.deepEqual(
    combined.hooks.MessageDisplay[0],
    splitterOnly.hooks.MessageDisplay[0],
  );
});

test("cc-connect 示例保持同步执行并且不写死本机路径", () => {
  const source = fs.readFileSync(
    path.join(repositoryRoot, "scripts/hooks/wechat-splitter/cc-connect-hook.example.toml"),
    "utf8",
  );

  assert.match(source, /event\s*=\s*"message\.received"/u);
  assert.match(source, /--inbound/u);
  assert.match(source, /async\s*=\s*false/u);
  assert.match(source, /<PROJECT_DIR>/u);
  assert.doesNotMatch(source, /C:\\Users\\|C:\/Users\//u);
});
