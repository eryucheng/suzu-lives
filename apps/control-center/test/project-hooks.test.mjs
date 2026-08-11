import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  createProjectHooksService,
  inspectTimeAwarenessHook,
  installTimeAwarenessHook,
  ProjectHooksError,
  uninstallTimeAwarenessHook,
} from "../electron/services/project-hooks.mjs";
import { stableAgentId } from "@suzu-lives/agent-registry";
import { runProjectHook, timeAwarenessContext } from "../electron/hooks/runtime.mjs";

async function project() { return fs.mkdtemp(path.join(os.tmpdir(), "suzu-project-hooks-")); }
const command = "C:\\Program Files\\Suzu Lives\\Suzu Lives Console.exe";
const dataRoot = "C:\\Users\\Test\\AppData\\Local\\Suzu Lives";

test("time-awareness Hook preserves user settings and removes only its own command", async () => {
  const root = await project(); const claude = path.join(root, ".claude"); await fs.mkdir(claude);
  const settingsPath = path.join(claude, "settings.json");
  await fs.writeFile(settingsPath, JSON.stringify({
    permissions: { allow: ["Read"] },
    env: { KEEP: "yes" },
    hooks: {
      UserPromptSubmit: [
        { hooks: [{ type: "command", command: "node", args: ["C:/user-hook.mjs"] }] },
      ],
      Stop: [{ hooks: [{ type: "command", command: "keep-stop" }] }],
    },
  }, null, 2));

  await installTimeAwarenessHook({ projectRoot: root, command, dataRoot });
  await installTimeAwarenessHook({ projectRoot: root, command, dataRoot });
  const installed = JSON.parse(await fs.readFile(settingsPath, "utf8"));
  const promptHooks = installed.hooks.UserPromptSubmit.flatMap((entry) => entry.hooks);
  const managed = promptHooks.filter((hook) => hook.args?.[0] === "--suzu-lives-hook" && hook.args?.[1] === "time-awareness");
  assert.deepEqual(installed.permissions, { allow: ["Read"] });
  assert.deepEqual(installed.env, { KEEP: "yes" });
  assert.equal(installed.hooks.Stop[0].hooks[0].command, "keep-stop");
  assert.equal(promptHooks.some((hook) => hook.command === "node"), true);
  assert.equal(managed.length, 1);
  assert.deepEqual(managed[0].args, ["--suzu-lives-hook", "time-awareness", "--project-root", "${CLAUDE_PROJECT_DIR}", "--data-root", dataRoot]);
  assert.equal((await inspectTimeAwarenessHook({ projectRoot: root })).installed, true);

  await uninstallTimeAwarenessHook({ projectRoot: root });
  const removed = JSON.parse(await fs.readFile(settingsPath, "utf8"));
  const retained = removed.hooks.UserPromptSubmit.flatMap((entry) => entry.hooks);
  assert.equal(retained.some((hook) => hook.args?.[1] === "time-awareness"), false);
  assert.equal(retained.some((hook) => hook.command === "node"), true);
  assert.equal(removed.hooks.Stop[0].hooks[0].command, "keep-stop");
});

test("time-awareness Hook keeps project files safe", async (t) => {
  const broken = await project(); await fs.mkdir(path.join(broken, ".claude")); await fs.writeFile(path.join(broken, ".claude", "settings.json"), "{");
  await assert.rejects(() => installTimeAwarenessHook({ projectRoot: broken, command, dataRoot }), ProjectHooksError);

  const outside = await project(); const linked = await project(); await fs.mkdir(path.join(linked, ".claude"));
  try { await fs.symlink(path.join(outside, "settings.json"), path.join(linked, ".claude", "settings.json"), "file"); } catch (error) { if (error?.code === "EPERM" || error?.code === "EACCES") { t.skip("当前 Windows 环境不允许创建测试符号链接。"); return; } throw error; }
  await assert.rejects(() => installTimeAwarenessHook({ projectRoot: linked, command, dataRoot }), ProjectHooksError);

  const linkedDirectory = await project(); await fs.symlink(outside, path.join(linkedDirectory, ".claude"), "junction");
  await assert.rejects(() => installTimeAwarenessHook({ projectRoot: linkedDirectory, command, dataRoot }), ProjectHooksError);
});

test("the time-awareness Hook service can target a selected contact project", async () => {
  const activeProject = await project(); const targetProject = await project(); const software = path.join(activeProject, "software"); await fs.mkdir(software);
  const settings = { projectRoot: activeProject };
  const service = createProjectHooksService({
    settingsService: { load: () => settings, response: () => ({ dataRoot: software }) },
    executablePath: process.execPath,
    packaged: true,
  });

  await service.installTimeAwareness({ projectRoot: targetProject });
  assert.equal((await service.inspectTimeAwareness({ projectRoot: targetProject })).installed, true);
  assert.equal(await inspectTimeAwarenessHook({ projectRoot: activeProject }).then((result) => result.installed), false);

  await service.uninstallTimeAwareness({ projectRoot: targetProject });
  assert.equal((await service.inspectTimeAwareness({ projectRoot: targetProject })).installed, false);
});

test("project Hook runtime serves time-awareness only", async () => {
  const root = await project(); const software = path.join(root, "software"); await fs.mkdir(software);
  const now = new Date(2026, 9, 1, 9, 20);
  const agentId = stableAgentId(root);
  const managedCalendar = path.join(software, "calendar", "calendar.local.json");
  await fs.mkdir(path.dirname(managedCalendar), { recursive: true });
  await fs.writeFile(managedCalendar, JSON.stringify({ events: [
    { contactId: "contact-suzu", agentId, date: "10-01", name: "软件纪念日" },
    { contactId: "contact-work", agentId: "agent-work", date: "10-01", name: "工作交付日" },
  ] }));

  const time = timeAwarenessContext({ now, calendarPath: managedCalendar, agentId });
  assert.match(time, /10月1日/u);
  assert.match(time, /国庆节，也是软件纪念日/u);
  assert.doesNotMatch(time, /工作交付日/u);
  const result = await runProjectHook({ args: ["time-awareness", "--project-root", root, "--data-root", software], input: "{}", now });
  assert.match(result.hookSpecificOutput.additionalContext, /软件纪念日/u);
  assert.deepEqual(
    await runProjectHook({ args: ["user-prompt", "--project-root", root, "--data-root", software], input: JSON.stringify({ prompt: "记得上次的事吗？" }), now }),
    {},
  );
  assert.deepEqual(
    await runProjectHook({ args: ["assistant-stop", "--project-root", root, "--data-root", software], input: JSON.stringify({ last_assistant_message: "收到。" }), now }),
    {},
  );
});

test("time-awareness injects at most once per Claude session within ten minutes", async () => {
  const root = await project(); const software = path.join(root, "software"); await fs.mkdir(software);
  const args = ["time-awareness", "--project-root", root, "--data-root", software];
  const input = JSON.stringify({ session_id: "conversation-1" });
  const first = new Date(2026, 9, 1, 9, 20);

  assert.ok((await runProjectHook({ args, input, now: first })).hookSpecificOutput?.additionalContext);
  assert.deepEqual(await runProjectHook({ args, input, now: new Date(first.getTime() + (10 * 60 * 1_000)) }), {});
  assert.ok((await runProjectHook({ args, input, now: new Date(first.getTime() + (10 * 60 * 1_000) + 1) })).hookSpecificOutput?.additionalContext);
  assert.ok((await runProjectHook({
    args,
    input: JSON.stringify({ session_id: "conversation-2" }),
    now: new Date(first.getTime() + (10 * 60 * 1_000) + 1),
  })).hookSpecificOutput?.additionalContext);
});

test("time-awareness uses the interval saved in Suzu settings", async () => {
  const root = await project(); const software = path.join(root, "software"); await fs.mkdir(path.join(software, "capabilities", "time-awareness"), { recursive: true });
  await fs.writeFile(path.join(software, "capabilities", "time-awareness", "config.json"), JSON.stringify({ intervalMinutes: 3 }));
  const args = ["time-awareness", "--project-root", root, "--data-root", software];
  const input = JSON.stringify({ session_id: "conversation-configured" });
  const first = new Date(2026, 9, 1, 9, 20);

  assert.ok((await runProjectHook({ args, input, now: first })).hookSpecificOutput?.additionalContext);
  assert.deepEqual(await runProjectHook({ args, input, now: new Date(first.getTime() + (3 * 60 * 1_000)) }), {});
  assert.ok((await runProjectHook({ args, input, now: new Date(first.getTime() + (3 * 60 * 1_000) + 1) })).hookSpecificOutput?.additionalContext);
});

test("packaging keeps the stable CLI entry and Hook runtime has no old memory service", async () => {
  const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const manifest = JSON.parse(await fs.readFile(path.join(appRoot, "package.json"), "utf8"));
  assert.equal(manifest.build.asar, true);
  assert.ok(manifest.build.asarUnpack.includes("node_modules/@suzu-lives/browser-automation/src/web-browser/**"));
  const [main, hookRuntime] = await Promise.all([
    fs.readFile(path.join(appRoot, "electron", "main.mjs"), "utf8"),
    fs.readFile(path.join(appRoot, "electron", "hooks", "runtime.mjs"), "utf8"),
  ]);
  assert.match(main, /--suzu-lives-cli/u);
  assert.match(main, /runSuzuLivesCli/u);
  assert.doesNotMatch(main, /wechatScriptPath|ownedWechatSplitterPath/u);
  assert.doesNotMatch(hookRuntime, /memory-service|memoryRecallEnabled|SUZU_LIVES_EMBEDDED_MEMORY/u);
});
