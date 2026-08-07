import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  inspectTimeAwarenessHook,
  installProjectHooks,
  installTimeAwarenessHook,
  ProjectHooksError,
  uninstallProjectHooks,
  uninstallTimeAwarenessHook,
} from "../electron/services/project-hooks.mjs";
import { resolveAgentDataRoot, stableAgentId } from "@suzu-lives/agent-registry";
import {
  isCurrentTimeQuery,
  isMemoryRecallEnabled,
  runProjectHook,
  timeAwarenessContext,
  userPromptContext,
} from "../electron/hooks/runtime.mjs";

async function project() { return fs.mkdtemp(path.join(os.tmpdir(), "suzu-project-hooks-")); }
const command = "C:\\Program Files\\Suzu Lives\\Suzu Lives Console.exe";
const dataRoot = "C:\\Users\\Test\\AppData\\Local\\Suzu Lives";

test("project Hook installation preserves user settings and updates only signed Hook commands", async () => {
  const root = await project(); const claude = path.join(root, ".claude"); await fs.mkdir(claude);
  await fs.writeFile(path.join(claude, "settings.json"), JSON.stringify({ permissions: { allow: ["Read"] }, env: { KEEP: "yes" }, hooks: { UserPromptSubmit: [{ matcher: "user", hooks: [{ type: "command", command: "keep", args: ["x"] }] }], Stop: [{ hooks: [{ type: "command", command: "other" }] }], MessageDisplay: [{ hooks: [{ type: "command", command: "user-display", args: ["x"] }] }] } }, null, 2));
  await installProjectHooks({ projectRoot: root, command, dataRoot });
  await installProjectHooks({ projectRoot: root, command, dataRoot });
  const settings = JSON.parse(await fs.readFile(path.join(claude, "settings.json"), "utf8"));
  assert.deepEqual(settings.permissions, { allow: ["Read"] }); assert.deepEqual(settings.env, { KEEP: "yes" }); assert.equal(settings.hooks.Stop.length, 2);
  const promptHooks = settings.hooks.UserPromptSubmit.flatMap((entry) => entry.hooks).filter((hook) => hook.args?.[0] === "--suzu-lives-hook");
  const stopHooks = settings.hooks.Stop.flatMap((entry) => entry.hooks).filter((hook) => hook.args?.[0] === "--suzu-lives-hook");
  assert.equal(promptHooks.length, 1); assert.equal(stopHooks.length, 1); assert.deepEqual(settings.hooks.MessageDisplay, [{ hooks: [{ type: "command", command: "user-display", args: ["x"] }] }]);
  assert.deepEqual(promptHooks[0].args, ["--suzu-lives-hook", "user-prompt", "--project-root", "${CLAUDE_PROJECT_DIR}", "--data-root", dataRoot]);
  assert.equal(stopHooks[0].args[1], "assistant-stop");
});

test("time-awareness adds its managed Hook and leaves unrelated Hooks intact", async () => {
  const root = await project(); const claude = path.join(root, ".claude"); await fs.mkdir(claude);
  const settingsPath = path.join(claude, "settings.json");
  await fs.writeFile(settingsPath, JSON.stringify({
    hooks: {
      UserPromptSubmit: [
        { hooks: [{ type: "command", command: "node", args: ["C:/legacy/memory/rag/hook.mjs"] }] },
        { hooks: [{ type: "command", command: "user-hook", args: ["keep"] }] },
      ],
    },
  }, null, 2));

  await installTimeAwarenessHook({ projectRoot: root, command, dataRoot });
  const installed = JSON.parse(await fs.readFile(settingsPath, "utf8"));
  const promptHooks = installed.hooks.UserPromptSubmit.flatMap((entry) => entry.hooks);
  assert.equal(promptHooks.some((hook) => (Array.isArray(hook.args) ? hook.args.join(" ") : "").includes("memory/rag/hook.mjs")), true);
  assert.equal(promptHooks.some((hook) => hook.command === "user-hook"), true);
  const managed = promptHooks.filter((hook) => hook.args?.[0] === "--suzu-lives-hook" && hook.args?.[1] === "time-awareness");
  assert.equal(managed.length, 1);
  assert.deepEqual(managed[0].args, ["--suzu-lives-hook", "time-awareness", "--project-root", "${CLAUDE_PROJECT_DIR}", "--data-root", dataRoot]);
  assert.equal((await inspectTimeAwarenessHook({ projectRoot: root })).installed, true);

  await uninstallTimeAwarenessHook({ projectRoot: root });
  const removed = JSON.parse(await fs.readFile(settingsPath, "utf8"));
  const retained = removed.hooks.UserPromptSubmit.flatMap((entry) => entry.hooks);
  assert.equal(retained.some((hook) => hook.args?.[1] === "time-awareness"), false);
  assert.equal(retained.some((hook) => (Array.isArray(hook.args) ? hook.args.join(" ") : "").includes("memory/rag/hook.mjs")), true);
  assert.equal(retained.some((hook) => hook.command === "user-hook"), true);
});

test("uninstall removes only signed Hook commands and project settings rejects symlink or invalid JSON", async (t) => {
  const root = await project(); await installProjectHooks({ projectRoot: root, command, dataRoot });
  const settingsPath = path.join(root, ".claude", "settings.json"); const before = JSON.parse(await fs.readFile(settingsPath, "utf8")); before.hooks.UserPromptSubmit[0].hooks.push({ type: "command", command: "user-hook" }); await fs.writeFile(settingsPath, JSON.stringify(before));
  await uninstallProjectHooks({ projectRoot: root }); const after = JSON.parse(await fs.readFile(settingsPath, "utf8")); assert.equal(after.hooks.UserPromptSubmit[0].hooks[0].command, "user-hook"); assert.equal(after.hooks.MessageDisplay, undefined);
  const broken = await project(); await fs.mkdir(path.join(broken, ".claude")); await fs.writeFile(path.join(broken, ".claude", "settings.json"), "{"); await assert.rejects(() => installProjectHooks({ projectRoot: broken, command, dataRoot }), ProjectHooksError);
  const outside = await project(); const linked = await project(); await fs.mkdir(path.join(linked, ".claude")); try { await fs.symlink(path.join(outside, "settings.json"), path.join(linked, ".claude", "settings.json"), "file"); } catch (error) { if (error?.code === "EPERM" || error?.code === "EACCES") { t.skip("当前 Windows 环境不允许创建测试符号链接。"); return; } throw error; }
  await assert.rejects(() => installProjectHooks({ projectRoot: linked, command, dataRoot }), ProjectHooksError);
  const linkedDirectory = await project(); await fs.symlink(outside, path.join(linkedDirectory, ".claude"), "junction"); await assert.rejects(() => installProjectHooks({ projectRoot: linkedDirectory, command, dataRoot }), ProjectHooksError);
});

test("time and memory Hook keeps local calendar semantics, skips current-time retrieval, and follows Hook JSON", async () => {
  const root = await project(); const software = path.join(root, "software"); await fs.mkdir(software); const calendar = path.join(software, "calendar.local.json"); await fs.writeFile(calendar, JSON.stringify({ events: [{ date: "10-01", name: "纪念日" }, { date: "10-01", name: "国庆节" }, { date: "10-01", name: "停用", enabled: false }] }));
  const now = new Date(2026, 9, 1, 9, 20); const time = timeAwarenessContext({ now, calendarPath: calendar }); assert.match(time, /10月1日/u); assert.match(time, /国庆节，也是纪念日/u); assert.equal(isCurrentTimeQuery("现在几点了"), true);
  const managedCalendar = path.join(resolveAgentDataRoot({ dataRoot: software, agentId: stableAgentId(root) }), "time-awareness", "calendar.local.json"); await fs.mkdir(path.dirname(managedCalendar), { recursive: true }); await fs.writeFile(managedCalendar, JSON.stringify({ events: [{ date: "10-01", name: "软件纪念日" }] }));
  const timeOnly = await runProjectHook({ args: ["time-awareness", "--project-root", root, "--data-root", software], input: "{}", now }); assert.match(timeOnly.hookSpecificOutput.additionalContext, /软件纪念日/u);
  let calls = 0; const context = await userPromptContext({ projectRoot: root, dataRoot: software, prompt: "现在几点了", now, search: async () => { calls += 1; return { context: "不该出现" }; } }); assert.equal(calls, 0); assert.doesNotMatch(context, /不该出现/u);
  let receivedSearchOptions = null; const result = await runProjectHook({ args: ["user-prompt", "--project-root", root, "--data-root", software], input: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "session-test", prompt: "记得我去科技馆吗" }), now, search: async (_query, options) => { receivedSearchOptions = options; return { context: "你想起了之前的片段：科技馆。" }; } }); assert.equal(result.hookSpecificOutput.hookEventName, "UserPromptSubmit"); assert.match(result.hookSpecificOutput.additionalContext, /科技馆/u); assert.equal(receivedSearchOptions.runtimeSessionId, "session-test"); assert.equal(receivedSearchOptions.persistTrace, true);
  let usageBinding = null; const stop = await runProjectHook({ args: ["assistant-stop", "--project-root", root, "--data-root", software], input: JSON.stringify({ hook_event_name: "Stop", session_id: "session-test", last_assistant_message: "记得，你去过科技馆。" }), bindRetrievalUsage: async (value) => { usageBinding = value; return { id: "usage-request" }; } }); assert.deepEqual(stop, {}); assert.deepEqual(usageBinding, { runtimeSessionId: "session-test", responseText: "记得，你去过科技馆。" });
});

test("memory recall setting prevents the UserPromptSubmit Hook from searching", async () => {
  const root = await project();
  const software = path.join(root, "software");
  await fs.mkdir(software);
  await fs.writeFile(path.join(software, "settings.json"), JSON.stringify({ memoryRecallEnabled: false }));
  assert.equal(isMemoryRecallEnabled({ dataRoot: software }), false);

  let calls = 0;
  const disabled = await userPromptContext({
    projectRoot: root,
    dataRoot: software,
    prompt: "记得我去科技馆吗",
    now: new Date(2026, 9, 1, 9, 20),
    search: async () => { calls += 1; return { context: "不该出现" }; },
  });
  assert.equal(calls, 0);
  assert.match(disabled, /你知道现在是10月1日/u);
  assert.doesNotMatch(disabled, /不该出现/u);

  await fs.writeFile(path.join(software, "settings.json"), JSON.stringify({ memoryRecallEnabled: true }));
  const enabled = await userPromptContext({
    projectRoot: root,
    dataRoot: software,
    prompt: "记得我去科技馆吗",
    now: new Date(2026, 9, 1, 9, 20),
    search: async () => { calls += 1; return { context: "科技馆记忆" }; },
  });
  assert.equal(calls, 1);
  assert.match(enabled, /科技馆记忆/u);
});

test("packaging keeps the stable CLI entry and browser runtime", async () => {
  const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const manifest = JSON.parse(await fs.readFile(path.join(appRoot, "package.json"), "utf8"));
  assert.equal(manifest.build.asar, true);
  assert.ok(manifest.build.asarUnpack.includes("node_modules/@suzu-lives/browser-automation/src/web-browser/**"));
  const main = await fs.readFile(path.join(appRoot, "electron", "main.mjs"), "utf8");
  assert.match(main, /--suzu-lives-cli/u);
  assert.match(main, /runSuzuLivesCli/u);
  assert.doesNotMatch(main, /wechatScriptPath|ownedWechatSplitterPath/u);
});
