import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  createProjectHooksService,
  inspectMemoryRecallHook,
  inspectTimeAwarenessHook,
  installMemoryRecallHook,
  installTimeAwarenessHook,
  ProjectHooksError,
  uninstallMemoryRecallHook,
  uninstallTimeAwarenessHook,
} from "../electron/services/project-hooks.mjs";
import { resolveAgentDataRoot, stableAgentId } from "@suzu-lives/agent-registry";
import { runProjectHook, timeAwarenessContext } from "../electron/hooks/runtime.mjs";
import { createContactProjectsService } from "../electron/services/contact-projects.mjs";

async function project() { return fs.mkdtemp(path.join(os.tmpdir(), "suzu-project-hooks-")); }
const command = "C:\\Program Files\\Suzu Lives\\Suzu Lives Console.exe";
const hookRunner = "C:\\Program Files\\Suzu Lives\\resources\\app.asar\\electron\\hooks\\runner.mjs";
const dataRoot = "C:\\Users\\Test\\AppData\\Local\\Suzu Lives";
const require = createRequire(import.meta.url);

function runElectronHook({ hook, projectRoot, input = "{}", timeoutMs = 10_000 }) {
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  environment.CLAUDE_PROJECT_DIR = projectRoot;
  return new Promise((resolve, reject) => {
    const child = spawn(hook.command, hook.args, {
      cwd: projectRoot,
      env: environment,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("Electron Hook 在限定时间内没有退出。"));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stderr, stdout });
    });
    child.stdin.end(input);
  });
}

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

  await installTimeAwarenessHook({ projectRoot: root, command, hookRunner, dataRoot });
  await installTimeAwarenessHook({ projectRoot: root, command, hookRunner, dataRoot });
  const installed = JSON.parse(await fs.readFile(settingsPath, "utf8"));
  const promptHooks = installed.hooks.UserPromptSubmit.flatMap((entry) => entry.hooks);
  const managed = promptHooks.filter((hook) => hook.command === "powershell.exe" && hook.args?.includes("-Command") && hook.args?.at(-1)?.includes("suzu-lives:project-hook:time-awareness"));
  assert.deepEqual(installed.permissions, { allow: ["Read"] });
  assert.deepEqual(installed.env, { KEEP: "yes" });
  assert.equal(installed.hooks.Stop[0].hooks[0].command, "keep-stop");
  assert.equal(promptHooks.some((hook) => hook.command === "node"), true);
  assert.equal(managed.length, 1);
  assert.deepEqual(managed[0].args.slice(0, 3), ["-NoProfile", "-NonInteractive", "-Command"]);
  assert.match(managed[0].args[3], /ELECTRON_RUN_AS_NODE/u);
  assert.match(managed[0].args[3], /runner\.mjs/u);
  assert.match(managed[0].args[3], /\$env:CLAUDE_PROJECT_DIR/u);
  assert.equal((await inspectTimeAwarenessHook({ projectRoot: root })).installed, true);

  await uninstallTimeAwarenessHook({ projectRoot: root });
  const removed = JSON.parse(await fs.readFile(settingsPath, "utf8"));
  const retained = removed.hooks.UserPromptSubmit.flatMap((entry) => entry.hooks);
  assert.equal(retained.some((hook) => hook.command === "powershell.exe" && hook.args?.at(-1)?.includes("suzu-lives:project-hook:time-awareness")), false);
  assert.equal(retained.some((hook) => hook.command === "node"), true);
  assert.equal(removed.hooks.Stop[0].hooks[0].command, "keep-stop");
});

test("memory recall Hook uses UserPromptSubmit and migrates only legacy Suzu memory Hooks", async () => {
  const root = await project();
  const claude = path.join(root, ".claude");
  await fs.mkdir(claude);
  const settingsPath = path.join(claude, "settings.json");
  await fs.writeFile(settingsPath, JSON.stringify({
    hooks: {
      UserPromptSubmit: [{
        hooks: [
          { type: "command", command: command, args: ["--suzu-lives-hook", "user-prompt", "--project-root", "${CLAUDE_PROJECT_DIR}", "--data-root", dataRoot] },
          { type: "command", command: "node", args: ["C:/user-hook.mjs"] },
        ],
      }],
      Stop: [{
        hooks: [
          { type: "command", command: command, args: ["--suzu-lives-hook", "assistant-stop", "--project-root", "${CLAUDE_PROJECT_DIR}", "--data-root", dataRoot] },
          { type: "command", command: "keep-stop" },
        ],
      }],
    },
  }, null, 2));

  await installTimeAwarenessHook({ projectRoot: root, command, hookRunner, dataRoot });
  await installMemoryRecallHook({ projectRoot: root, command, hookRunner, dataRoot });
  await installMemoryRecallHook({ projectRoot: root, command, hookRunner, dataRoot });
  const installed = JSON.parse(await fs.readFile(settingsPath, "utf8"));
  const promptHooks = installed.hooks.UserPromptSubmit.flatMap((entry) => entry.hooks);
  const memoryHooks = promptHooks.filter((hook) => hook.command === "powershell.exe" && hook.args?.at(-1)?.includes("suzu-lives:project-hook:memory-recall"));
  assert.equal(memoryHooks.length, 1);
  assert.equal(memoryHooks[0].timeout, 15);
  assert.equal(promptHooks.some((hook) => hook.args?.[1] === "user-prompt"), false);
  assert.equal(promptHooks.some((hook) => hook.command === "node"), true);
  assert.equal(installed.hooks.Stop[0].hooks.some((hook) => hook.args?.[1] === "assistant-stop"), false);
  assert.equal(installed.hooks.Stop[0].hooks.some((hook) => hook.command === "keep-stop"), true);
  assert.equal((await inspectMemoryRecallHook({ projectRoot: root })).installed, true);

  await uninstallMemoryRecallHook({ projectRoot: root });
  const removed = JSON.parse(await fs.readFile(settingsPath, "utf8"));
  const retained = removed.hooks.UserPromptSubmit.flatMap((entry) => entry.hooks);
  assert.equal(retained.some((hook) => hook.command === "powershell.exe" && hook.args?.at(-1)?.includes("suzu-lives:project-hook:memory-recall")), false);
  assert.equal(retained.some((hook) => hook.command === "powershell.exe" && hook.args?.at(-1)?.includes("suzu-lives:project-hook:time-awareness")), true);
  assert.equal(removed.hooks.Stop[0].hooks.some((hook) => hook.command === "keep-stop"), true);
});

test("time-awareness Hook keeps project files safe", async (t) => {
  const broken = await project(); await fs.mkdir(path.join(broken, ".claude")); await fs.writeFile(path.join(broken, ".claude", "settings.json"), "{");
  await assert.rejects(() => installTimeAwarenessHook({ projectRoot: broken, command, hookRunner, dataRoot }), ProjectHooksError);

  const outside = await project(); const linked = await project(); await fs.mkdir(path.join(linked, ".claude"));
  try { await fs.symlink(path.join(outside, "settings.json"), path.join(linked, ".claude", "settings.json"), "file"); } catch (error) { if (error?.code === "EPERM" || error?.code === "EACCES") { t.skip("当前 Windows 环境不允许创建测试符号链接。"); return; } throw error; }
  await assert.rejects(() => installTimeAwarenessHook({ projectRoot: linked, command, hookRunner, dataRoot }), ProjectHooksError);

  const linkedDirectory = await project(); await fs.symlink(outside, path.join(linkedDirectory, ".claude"), "junction");
  await assert.rejects(() => installTimeAwarenessHook({ projectRoot: linkedDirectory, command, hookRunner, dataRoot }), ProjectHooksError);
});

test("the time-awareness Hook service can target a selected contact project", async () => {
  const activeProject = await project(); const targetProject = await project(); const software = path.join(activeProject, "software"); await fs.mkdir(software);
  const settings = { projectRoot: activeProject };
  const service = createProjectHooksService({
    settingsService: { load: () => settings, response: () => ({ dataRoot: software }) },
    executablePath: process.execPath,
    hookRunnerPath: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "electron", "hooks", "runner.mjs"),
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
  assert.match(time, /国庆节/u);
  assert.match(time, /国庆节假期/u);
  assert.match(time, /软件纪念日/u);
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

test("time-awareness reuses every public event from the calendar", () => {
  const midAutumn = timeAwarenessContext({ now: new Date(2026, 8, 25, 9, 20) });
  assert.match(midAutumn, /中秋节假期/u);
  assert.match(midAutumn, /中秋节/u);

  const makeupWorkday = timeAwarenessContext({ now: new Date(2026, 8, 20, 9, 20) });
  assert.match(makeupWorkday, /国庆节调休上班/u);
});

test("packaged-style Electron time Hook reads the Claude pipe through its Node runner", { skip: process.platform !== "win32" }, async (t) => {
  const root = await project();
  const software = path.join(root, "software");
  await fs.mkdir(software);
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const settingsPath = path.join(root, ".claude", "settings.json");
  await installTimeAwarenessHook({
    projectRoot: root,
    command: require("electron"),
    hookRunner: path.join(appRoot, "electron", "hooks", "runner.mjs"),
    dataRoot: software,
  });
  const settings = JSON.parse(await fs.readFile(settingsPath, "utf8"));
  const hook = settings.hooks.UserPromptSubmit.flatMap((entry) => entry.hooks).find((entry) => entry.command === "powershell.exe");
  assert.ok(hook);
  const result = await runElectronHook({ hook, projectRoot: root });
  assert.equal(result.code, 0, result.stderr || "Electron Hook 未正常退出。");
  assert.equal(result.signal, null);
  const output = JSON.parse(result.stdout.trim());
  assert.equal(output.hookSpecificOutput?.hookEventName, "UserPromptSubmit");
  assert.match(output.hookSpecificOutput?.additionalContext || "", /你知道现在是/u);
});

test("packaged-style Electron memory Hook hands Claude input to a normal Electron worker", { skip: process.platform !== "win32" }, async (t) => {
  const root = await project();
  const software = path.join(root, "software");
  const contactsRoot = path.join(root, "contacts");
  await fs.mkdir(software);
  await fs.mkdir(contactsRoot);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let settings = { contactsRoot, projectRoot: "", preferredContactId: "" };
  const contacts = createContactProjectsService({
    settingsService: {
      load: () => settings,
      save: (next) => { settings = next; return settings; },
    },
  });
  const created = await contacts.create({ name: "Suzu" });
  const contact = created.activeContact;
  await fs.writeFile(path.join(software, "settings.json"), JSON.stringify({
    contactsRoot,
    identity: { owner: { displayName: "我" } },
    memoryRecallEnabled: true,
    preferredContactId: contact.id,
    projectRoot: contact.projectRoot,
  }));
  await installMemoryRecallHook({
    projectRoot: contact.projectRoot,
    command: require("electron"),
    hookRunner: path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."), "electron", "hooks", "runner.mjs"),
    dataRoot: software,
  });
  const installed = JSON.parse(await fs.readFile(path.join(contact.projectRoot, ".claude", "settings.json"), "utf8"));
  const hook = installed.hooks.UserPromptSubmit.flatMap((entry) => entry.hooks)
    .find((entry) => entry.command === "powershell.exe" && entry.args?.at(-1)?.includes("suzu-lives:project-hook:memory-recall"));
  assert.ok(hook);
  const result = await runElectronHook({
    hook,
    projectRoot: contact.projectRoot,
    input: JSON.stringify({ prompt: "还记得我们上次聊什么吗？", session_id: contact.sessionId }),
    timeoutMs: 16_000,
  });
  assert.equal(result.code, 0, result.stderr || "Electron 记忆 Hook 未正常退出。");
  assert.equal(result.signal, null);
  assert.equal(result.stdout, "");
  assert.equal(await fs.stat(path.join(
    resolveAgentDataRoot({ dataRoot: software, agentId: contact.agentId }),
    "memory",
    "sessions",
    contact.sessionId,
    "suzu-memory.db",
  )).then(() => true, () => false), true);
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

test("packaging keeps the stable CLI entry and uses a dedicated memory UserPrompt worker", async () => {
  const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const manifest = JSON.parse(await fs.readFile(path.join(appRoot, "package.json"), "utf8"));
  assert.equal(manifest.build.asar, true);
  assert.ok(manifest.build.asarUnpack.includes("node_modules/@suzu-lives/browser-automation/src/web-browser/**"));
  const [main, hookRuntime, hookRunner, memoryRecall] = await Promise.all([
    fs.readFile(path.join(appRoot, "electron", "main.mjs"), "utf8"),
    fs.readFile(path.join(appRoot, "electron", "hooks", "runtime.mjs"), "utf8"),
    fs.readFile(path.join(appRoot, "electron", "hooks", "runner.mjs"), "utf8"),
    fs.readFile(path.join(appRoot, "electron", "hooks", "memory-recall.mjs"), "utf8"),
  ]);
  assert.match(main, /--suzu-lives-cli/u);
  assert.match(main, /runSuzuLivesCli/u);
  assert.doesNotMatch(main, /wechatScriptPath|ownedWechatSplitterPath/u);
  assert.doesNotMatch(hookRuntime, /memory-service|memoryRecallEnabled|SUZU_LIVES_EMBEDDED_MEMORY/u);
  assert.match(hookRunner, /runProjectHookCli/u);
  assert.match(hookRunner, /runMemoryRecallHookCli/u);
  assert.match(main, /--suzu-lives-memory-hook-worker/u);
  assert.match(memoryRecall, /UserPromptSubmit/u);
});
