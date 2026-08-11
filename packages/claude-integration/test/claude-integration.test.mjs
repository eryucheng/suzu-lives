import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import { configureCapability, setCapabilityEnabled } from "@suzu-lives/capability-registry";
import {
  claudeAgentAbilityCatalog,
  ClaudeIntegrationError,
  ensureSuzuClaudeProjectSettings,
  renderCapabilitySkill,
  writeClaudeRegistration,
} from "../src/index.mjs";

const execFileAsync = promisify(execFile);
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function temporaryDirectory(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

const launcher = { command: "suzu-lives", available: true };

test("explicit registration preserves user files and writes the Suzu project defaults", async () => {
  const project = await temporaryDirectory("suzu-claude-project-");
  await fs.writeFile(path.join(project, "CLAUDE.md"), "# User rules\n\nKeep this paragraph.\n@abilities.md\n@abilities.md\n", "utf8");

  const result = await writeClaudeRegistration({ projectRoot: project, abilityId: "image-vision", launcher });
  const claude = await fs.readFile(path.join(project, "CLAUDE.md"), "utf8");
  const abilities = await fs.readFile(path.join(project, "abilities.md"), "utf8");
  const skill = await fs.readFile(path.join(project, ".claude", "skills", "image-vision", "SKILL.md"), "utf8");

  const settings = JSON.parse(await fs.readFile(path.join(project, ".claude", "settings.json"), "utf8"));
  assert.equal(result.files.length, 4);
  assert.match(claude, /Keep this paragraph\./u);
  assert.equal((claude.match(/^@abilities\.md$/gmu) || []).length, 1);
  assert.doesNotMatch(claude, /suzu-lives:managed:start|suzu-lives:ability:/u);
  assert.match(abilities, /suzu-lives:abilities:start/u);
  assert.match(abilities, /suzu-lives:ability:image-vision/u);
  assert.match(skill, /suzu-lives capability image-vision analyze --input-json '<JSON>'/u);
  assert.doesNotMatch(skill, /--detail/u);
  assert.match(skill, /noRetry/u);
  assert.doesNotMatch(skill, /--authorization-credential/u);
  assert.doesNotMatch(skill, new RegExp(project.replace(/[\\^$.*+?()[\]{}|]/gu, "\\$&"), "u"));
  assert.doesNotMatch(skill, /config\.local|registry\.local|D:\\Apps|ling/iu);
  assert.equal(settings.skipWebFetchPreflight, true);
  assert.equal(settings.permissions.defaultMode, "acceptEdits");
  assert.deepEqual(settings.permissions.allow, ["Bash(suzu-lives *)", "Bash(playwright-cli *)", "Read", "WebFetch", "WebSearch"]);
});

test("Suzu project defaults preserve user settings and replace only a prior Suzu CLI permission", async () => {
  const project = await temporaryDirectory("suzu-project-settings-");
  const settingsPath = path.join(project, ".claude", "settings.json");
  await fs.mkdir(path.dirname(settingsPath), { recursive: true });
  await fs.writeFile(settingsPath, JSON.stringify({
    env: { KEEP: "yes" },
    hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: "user-hook" }] }] },
    permissions: {
      allow: [
        'Bash("D:\\old\\Suzu Lives Console.exe" --suzu-lives-cli:*)',
        "Bash(git status:*)",
      ],
      deny: ["Bash(rm:*)"],
    },
  }, null, 2), "utf8");
  const launcher = { command: '"D:\\current\\Suzu Lives Console.exe" --suzu-lives-cli', available: true };

  await ensureSuzuClaudeProjectSettings({ projectRoot: project, launcher });
  const settings = JSON.parse(await fs.readFile(settingsPath, "utf8"));
  assert.equal(settings.skipWebFetchPreflight, true);
  assert.equal(settings.permissions.defaultMode, "acceptEdits");
  assert.deepEqual(settings.permissions.allow, [
    "Bash(git status:*)",
    'Bash("D:\\current\\Suzu Lives Console.exe" --suzu-lives-cli *)',
    "Bash(playwright-cli *)",
    "Read",
    "WebFetch",
    "WebSearch",
  ]);
  assert.deepEqual(settings.permissions.deny, ["Bash(rm:*)"]);
  assert.deepEqual(settings.env, { KEEP: "yes" });
  assert.equal(settings.hooks.UserPromptSubmit[0].hooks[0].command, "user-hook");
  assert.equal((await ensureSuzuClaudeProjectSettings({ projectRoot: project, launcher })).changed, false);
});

test("shared Claude project defaults replace the managed tool and network rules for every contact", async () => {
  const project = await temporaryDirectory("suzu-project-shared-runtime-defaults-");
  const settingsPath = path.join(project, ".claude", "settings.json");
  await fs.mkdir(path.dirname(settingsPath), { recursive: true });
  await fs.writeFile(settingsPath, JSON.stringify({
    skipWebFetchPreflight: true,
    permissions: { allow: ["Read"], deny: ["Bash(rm:*)"] },
  }, null, 2), "utf8");

  const projectDefaults = {
    allowedTools: ["Bash(git status:*)"],
    deniedTools: ["Read(./.env)"],
    skipWebFetchPreflight: false,
  };
  await ensureSuzuClaudeProjectSettings({ projectRoot: project, launcher, projectDefaults });

  const settings = JSON.parse(await fs.readFile(settingsPath, "utf8"));
  assert.equal(settings.skipWebFetchPreflight, false);
  assert.ok(settings.permissions.allow.includes("Bash(git status:*)"));
  assert.deepEqual(settings.permissions.deny, ["Read(./.env)"]);
  const projectDefaultsWithoutWhitelist = { ...projectDefaults, allowedTools: [] };
  await ensureSuzuClaudeProjectSettings({ projectRoot: project, launcher, previousProjectDefaults: projectDefaults, projectDefaults: projectDefaultsWithoutWhitelist });
  const updated = JSON.parse(await fs.readFile(settingsPath, "utf8"));
  assert.equal(updated.permissions.allow.includes("Bash(git status:*)"), false);
  assert.equal((await ensureSuzuClaudeProjectSettings({ projectRoot: project, launcher, projectDefaults: projectDefaultsWithoutWhitelist })).changed, false);
});

test("development launcher is accepted and replaces an outdated packaged CLI permission", async () => {
  const project = await temporaryDirectory("suzu-project-development-launcher-");
  const settingsPath = path.join(project, ".claude", "settings.json");
  await fs.mkdir(path.dirname(settingsPath), { recursive: true });
  await fs.writeFile(settingsPath, JSON.stringify({
    permissions: { allow: ['Bash("D:\\old\\Suzu Lives Console.exe" --suzu-lives-cli:*)'] },
  }, null, 2), "utf8");
  const developmentLauncher = {
    command: '"D:\\Apps\\AI\\Suzu Lives-v1\\node_modules\\electron\\dist\\electron.exe" "D:\\Apps\\AI\\Suzu Lives-v1\\apps\\control-center" --suzu-lives-cli',
    available: true,
  };

  await writeClaudeRegistration({ projectRoot: project, abilityId: "voice-message", launcher: developmentLauncher });
  const settings = JSON.parse(await fs.readFile(settingsPath, "utf8"));
  const skill = await fs.readFile(path.join(project, ".claude", "skills", "voice-message", "SKILL.md"), "utf8");
  assert.ok(settings.permissions.allow.includes(`Bash(${developmentLauncher.command} *)`));
  assert.equal(settings.permissions.allow.some((item) => item.includes("D:\\old\\Suzu Lives Console.exe")), false);
  assert.match(skill, /electron\.exe" "D:\\Apps\\AI\\Suzu Lives-v1\\apps\\control-center" --suzu-lives-cli voice-message/u);
});

test("Suzu project settings honor disabled selectable read and web permissions", async () => {
  const project = await temporaryDirectory("suzu-project-selectable-permissions-");
  const settingsPath = path.join(project, ".claude", "settings.json");
  await fs.mkdir(path.dirname(settingsPath), { recursive: true });
  await fs.writeFile(settingsPath, JSON.stringify({
    permissions: { allow: ["Read", "WebFetch", "WebSearch", "Bash(git status:*)"] },
  }, null, 2), "utf8");

  await ensureSuzuClaudeProjectSettings({
    projectRoot: project,
    launcher,
    toolPermissions: { read: false, webFetch: true, webSearch: false },
  });

  const settings = JSON.parse(await fs.readFile(settingsPath, "utf8"));
  assert.deepEqual(settings.permissions.allow, [
    "WebFetch",
    "Bash(git status:*)",
    "Bash(suzu-lives *)",
    "Bash(playwright-cli *)",
  ]);
});

test("every Suzu contact project gets the shared workspace and automatic file edits", async () => {
  const project = await temporaryDirectory("suzu-project-shared-workspace-");
  const workspace = await temporaryDirectory("suzu-shared-workspace-");
  await ensureSuzuClaudeProjectSettings({ projectRoot: project, launcher, workspaceDirectories: [workspace] });

  const settingsPath = path.join(project, ".claude", "settings.json");
  const settings = JSON.parse(await fs.readFile(settingsPath, "utf8"));
  assert.equal(settings.permissions.defaultMode, "acceptEdits");
  assert.deepEqual(settings.additionalDirectories, [workspace]);
  assert.equal((await ensureSuzuClaudeProjectSettings({ projectRoot: project, launcher, workspaceDirectories: [workspace] })).changed, false);
});

test("managed registration updates its own file but refuses a user-owned skill collision", async () => {
  const project = await temporaryDirectory("suzu-claude-update-");
  await fs.writeFile(path.join(project, "abilities.md"), "# User ability notes\n\nKeep this paragraph.\n", "utf8");
  await writeClaudeRegistration({ projectRoot: project, abilityId: "image-vision", launcher });
  await writeClaudeRegistration({ projectRoot: project, abilityId: "video-understanding", launcher });
  const claude = await fs.readFile(path.join(project, "CLAUDE.md"), "utf8");
  const abilities = await fs.readFile(path.join(project, "abilities.md"), "utf8");
  const videoSkill = await fs.readFile(path.join(project, ".claude", "skills", "video-understanding", "SKILL.md"), "utf8");
  assert.equal((claude.match(/^@abilities\.md$/gmu) || []).length, 1);
  assert.match(abilities, /Keep this paragraph\./u);
  assert.match(abilities, /image-vision/u);
  assert.match(abilities, /video-understanding/u);
  assert.match(videoSkill, /suzu-lives capability video-understanding analyze --input-json '<JSON>'/u);
  assert.match(videoSkill, /cacheKey/u);
  assert.match(videoSkill, /noCache/u);
  assert.match(videoSkill, /keepClip/u);
  assert.match(videoSkill, /dryRun/u);
  assert.doesNotMatch(videoSkill, /--authorization-credential/u);
  assert.doesNotMatch(videoSkill, new RegExp(project.replace(/[\\^$.*+?()[\]{}|]/gu, "\\$&"), "u"));
  assert.doesNotMatch(videoSkill, /config\.local|registry\.local|D:\\Apps|ling/iu);

  const collision = path.join(project, ".claude", "skills", "voice-message", "SKILL.md");
  await fs.mkdir(path.dirname(collision), { recursive: true });
  await fs.writeFile(collision, "# A user skill\n", "utf8");
  await assert.rejects(() => writeClaudeRegistration({ projectRoot: project, abilityId: "voice-message", launcher }), ClaudeIntegrationError);
  assert.equal(await fs.readFile(collision, "utf8"), "# A user skill\n");
});

test("direct registrations write thin proactive and merchant Skills without using capability registry", async () => {
  const project = await temporaryDirectory("suzu-direct-compat-project-");
  await writeClaudeRegistration({ projectRoot: project, abilityId: "proactive-contact", launcher });
  await writeClaudeRegistration({ projectRoot: project, abilityId: "traveling-merchant", launcher });
  const abilities = await fs.readFile(path.join(project, "abilities.md"), "utf8");
  const proactive = await fs.readFile(path.join(project, ".claude", "skills", "proactive-contact", "SKILL.md"), "utf8");
  const merchant = await fs.readFile(path.join(project, ".claude", "skills", "traveling-merchant", "SKILL.md"), "utf8");

  assert.match(abilities, /suzu-lives:ability:proactive-contact/u);
  assert.match(abilities, /suzu-lives traveling-merchant/u);
  assert.match(proactive, /当前会话系统提示中的 schedule add 命令/u);
  assert.match(proactive, /当前会话系统提示中的 schedule list 命令/u);
  assert.match(merchant, /suzu-lives schedule add --cron/u);
  assert.match(merchant, /suzu-lives traveling-merchant/u);
  for (const skill of [proactive, merchant]) {
    assert.doesNotMatch(skill, /--authorization-credential|D:\\Apps|config\.local|registry\.local|(?:^|[\\/])ling(?:[\\/]|$)/iu);
  }
});

test("time-awareness is a managed perception registration without a project script", async () => {
  const project = await temporaryDirectory("suzu-time-awareness-project-");
  await writeClaudeRegistration({ projectRoot: project, abilityId: "time-awareness", launcher });
  const catalog = claudeAgentAbilityCatalog();
  const ability = catalog.find((item) => item.id === "time-awareness");
  const abilities = await fs.readFile(path.join(project, "abilities.md"), "utf8");
  const skill = await fs.readFile(path.join(project, ".claude", "skills", "time-awareness", "SKILL.md"), "utf8");

  assert.equal(ability?.category, "perceive");
  assert.match(abilities, /suzu-lives:ability:time-awareness/u);
  assert.match(skill, /suzu-lives:ability:time-awareness/u);
  assert.match(skill, /UserPromptSubmit/u);
  assert.doesNotMatch(skill, /timehook\.mjs/u);
});

test("browser, site automation, and iPhone registrations write their owned direct Skills", async () => {
  const project = await temporaryDirectory("suzu-direct-runtime-project-");
  await writeClaudeRegistration({ projectRoot: project, abilityId: "web-browser", launcher });
  await writeClaudeRegistration({ projectRoot: project, abilityId: "site-automation", launcher });
  await writeClaudeRegistration({ projectRoot: project, abilityId: "iphone-bridge", launcher });

  const abilities = await fs.readFile(path.join(project, "abilities.md"), "utf8");
  const browser = await fs.readFile(path.join(project, ".claude", "skills", "web-browser", "SKILL.md"), "utf8");
  const site = await fs.readFile(path.join(project, ".claude", "skills", "site-automation", "SKILL.md"), "utf8");
  const iphone = await fs.readFile(path.join(project, ".claude", "skills", "iphone-bridge", "SKILL.md"), "utf8");

  assert.match(abilities, /suzu-lives:ability:web-browser/u);
  assert.match(abilities, /suzu-lives:ability:site-automation/u);
  assert.match(abilities, /suzu-lives:ability:iphone-bridge/u);
  assert.match(abilities, /suzu-lives web-browser/u);
  assert.match(abilities, /suzu-lives site <site> <action>/u);
  assert.match(abilities, /suzu-lives iphone-bridge send/u);
  assert.match(browser, /suzu-lives web-browser --check/u);
  assert.match(browser, /suzu-lives site <site> <action>/u);
  assert.match(browser, /suzu-lives site list/u);
  assert.match(browser, /关闭的网站或动作会被适配器直接拒绝/u);
  assert.match(site, /suzu-lives site <site> <action>/u);
  assert.match(site, /显式隐私同意和 dry-run 保护/u);
  assert.match(iphone, /suzu-lives iphone-bridge send '闹钟' '08:30 起床'/u);
  assert.match(iphone, /手机反馈由正在运行的 Suzu 本地接收器直接投递/u);
  assert.doesNotMatch(iphone, /iphone-bridge receive|Webhook/u);
  for (const skill of [browser, site, iphone]) {
    assert.doesNotMatch(skill, /authorization-credential/u);
    assert.doesNotMatch(skill, /D:\\Apps|(?:^|[\\/])ling(?:[\\/]|$)/iu);
  }
});

test("image generation, phone camera, and visual references register owned direct Skills", async () => {
  const project = await temporaryDirectory("suzu-direct-create-project-");
  await writeClaudeRegistration({ projectRoot: project, abilityId: "image-generation", launcher });
  await writeClaudeRegistration({ projectRoot: project, abilityId: "phone-camera", launcher });
  await writeClaudeRegistration({ projectRoot: project, abilityId: "visual-reference-manager", launcher });

  const abilities = await fs.readFile(path.join(project, "abilities.md"), "utf8");
  const image = await fs.readFile(path.join(project, ".claude", "skills", "image-generation", "SKILL.md"), "utf8");
  const phone = await fs.readFile(path.join(project, ".claude", "skills", "phone-camera", "SKILL.md"), "utf8");
  const references = await fs.readFile(path.join(project, ".claude", "skills", "visual-reference-manager", "SKILL.md"), "utf8");

  assert.match(abilities, /suzu-lives:ability:image-generation/u);
  assert.match(abilities, /suzu-lives:ability:phone-camera/u);
  assert.match(abilities, /suzu-lives:ability:visual-reference-manager/u);
  assert.match(abilities, /suzu-lives image-generation --prompt <visible-scene>/u);
  assert.match(abilities, /suzu-lives phone-camera --shot <rear\|selfie\|mirror> --scene <visible-scene>/u);
  assert.match(abilities, /suzu-lives visual-reference-manager init\|list\|show\|validate\|apply/u);
  assert.match(image, /suzu-lives image-generation --prompt/u);
  assert.match(image, /--backend api\|comfyui/u);
  assert.match(image, /附件交付命令/u);
  assert.match(phone, /suzu-lives phone-camera --shot rear/u);
  assert.match(phone, /附件交付命令/u);
  assert.match(references, /suzu-lives visual-reference-manager apply --plan/u);
  for (const skill of [image, phone, references]) {
    assert.doesNotMatch(skill, /authorization-credential|--send/u);
  }
});

test("registration refuses CLAUDE.md, abilities.md, .claude, and nested skill symlink escapes", async (t) => {
  const outside = await temporaryDirectory("suzu-claude-outside-");
  const project = await temporaryDirectory("suzu-claude-symlink-");
  const linkedClaude = path.join(project, "CLAUDE.md");
  try {
    await fs.symlink(path.join(outside, "outside-claude.md"), linkedClaude, "file");
  } catch (error) {
    if (error?.code === "EPERM" || error?.code === "EACCES") { t.skip("当前 Windows 环境不允许创建测试符号链接。"); return; }
    throw error;
  }
  await assert.rejects(() => writeClaudeRegistration({ projectRoot: project, abilityId: "image-vision", launcher }), ClaudeIntegrationError);
  const abilitiesFileProject = await temporaryDirectory("suzu-abilities-file-link-");
  await fs.symlink(path.join(outside, "outside-abilities.md"), path.join(abilitiesFileProject, "abilities.md"), "file");
  await assert.rejects(() => writeClaudeRegistration({ projectRoot: abilitiesFileProject, abilityId: "image-vision", launcher }), ClaudeIntegrationError);
  const claudeDirectoryProject = await temporaryDirectory("suzu-claude-directory-link-");
  await fs.symlink(outside, path.join(claudeDirectoryProject, ".claude"), "junction");
  await assert.rejects(() => writeClaudeRegistration({ projectRoot: claudeDirectoryProject, abilityId: "image-vision", launcher }), ClaudeIntegrationError);
  const skillsDirectoryProject = await temporaryDirectory("suzu-claude-skills-link-");
  await fs.mkdir(path.join(skillsDirectoryProject, ".claude"));
  await fs.symlink(outside, path.join(skillsDirectoryProject, ".claude", "skills"), "junction");
  await assert.rejects(() => writeClaudeRegistration({ projectRoot: skillsDirectoryProject, abilityId: "image-vision", launcher }), ClaudeIntegrationError);
  const abilityDirectoryProject = await temporaryDirectory("suzu-claude-ability-link-");
  await fs.mkdir(path.join(abilityDirectoryProject, ".claude", "skills"), { recursive: true });
  await fs.symlink(outside, path.join(abilityDirectoryProject, ".claude", "skills", "image-vision"), "junction");
  await assert.rejects(() => writeClaudeRegistration({ projectRoot: abilityDirectoryProject, abilityId: "image-vision", launcher }), ClaudeIntegrationError);
  const skillFileProject = await temporaryDirectory("suzu-claude-skill-file-link-");
  const skillFile = path.join(skillFileProject, ".claude", "skills", "image-vision", "SKILL.md");
  await fs.mkdir(path.dirname(skillFile), { recursive: true });
  await fs.symlink(path.join(outside, "outside-skill.md"), skillFile, "file");
  await assert.rejects(() => writeClaudeRegistration({ projectRoot: skillFileProject, abilityId: "image-vision", launcher }), ClaudeIntegrationError);
  assert.equal(await fs.readdir(outside).then((entries) => entries.length), 0);
});

test("registration rolls back SKILL.md and abilities.md if CLAUDE.md commit fails", async () => {
  const project = await temporaryDirectory("suzu-claude-rollback-");
  const originalClaude = "# Existing user rules\n";
  await fs.writeFile(path.join(project, "CLAUDE.md"), originalClaude, "utf8");
  const fsOps = {
    ...fs,
    rename: async (from, to) => {
      if (path.basename(to) === "CLAUDE.md" && from.includes(".suzu-lives-")) {
        const error = new Error("simulated CLAUDE commit failure");
        error.code = "EIO";
        throw error;
      }
      return fs.rename(from, to);
    },
  };
  await assert.rejects(() => writeClaudeRegistration({ projectRoot: project, abilityId: "image-vision", launcher, fsOps }), ClaudeIntegrationError);
  assert.equal(await fs.readFile(path.join(project, "CLAUDE.md"), "utf8"), originalClaude);
  await assert.rejects(() => fs.stat(path.join(project, ".claude", "skills", "image-vision", "SKILL.md")), /ENOENT/u);
  await assert.rejects(() => fs.stat(path.join(project, "abilities.md")), /ENOENT/u);
});

test("registration requires an actual stable launcher and still refuses an unknown ability", async () => {
  const project = await temporaryDirectory("suzu-claude-reject-");
  await assert.rejects(() => writeClaudeRegistration({ projectRoot: project, abilityId: "image-vision", launcher: { command: "suzu-lives", available: false } }), ClaudeIntegrationError);
  await assert.rejects(() => writeClaudeRegistration({ projectRoot: project, abilityId: "not-migrated", launcher }), ClaudeIntegrationError);
  assert.match(renderCapabilitySkill({ abilityId: "video-understanding" }), /video-understanding/u);
  const voiceSkill = renderCapabilitySkill({ abilityId: "voice-message" });
  assert.match(voiceSkill, /suzu-lives voice-message '<要说的话>'/u);
  assert.match(voiceSkill, /--audio-file/u);
  assert.match(voiceSkill, /--inspect/u);
  assert.match(voiceSkill, /--audio "<savedPath>"/u);
  assert.doesNotMatch(voiceSkill, /--authorization-credential|\/v1\/voice-messages/u);
  assert.doesNotMatch(voiceSkill, /--mode|native|iLink/iu);
  assert.doesNotMatch(voiceSkill, /config\.local|registry\.local|D:\\Apps|ling/iu);
});

test("stable CLI keeps plan explicit, rejects bare authorize, and cannot self-issue a credential", async () => {
  const dataRoot = await temporaryDirectory("suzu-cli-data-");
  const cli = path.join(PACKAGE_ROOT, "bin", "suzu-lives.mjs");
  const planned = await execFileAsync(process.execPath, [cli, "ability", "plan", "--id", "voice-message", "--data-root", dataRoot, "--request-json", '{"text":"测试"}'], { cwd: PACKAGE_ROOT });
  const planResponse = JSON.parse(planned.stdout);
  assert.equal(planResponse.status, "ok");
  assert.equal(planResponse.plan.willSendMessage, false);
  await assert.rejects(
    () => execFileAsync(process.execPath, [cli, "ability", "invoke", "--id", "voice-message", "--data-root", dataRoot, "--authorize", "true", "--request-json", '{"text":"测试"}'], { cwd: PACKAGE_ROOT }),
    (error) => {
      const response = JSON.parse(error.stdout);
      return error.code === 1 && response.status === "error" && /不接受 --authorize/u.test(response.message);
    },
  );
  await assert.rejects(
    () => execFileAsync(process.execPath, [cli, "ability", "invoke", "--id", "voice-message", "--data-root", dataRoot, "--request-json", '{"text":"测试"}'], { cwd: PACKAGE_ROOT }),
    (error) => {
      const response = JSON.parse(error.stdout);
      return error.code === 1 && response.status === "error" && /未启用/u.test(response.message);
    },
  );
  const enabledCameraRoot = await temporaryDirectory("suzu-cli-authorize-reject-");
  configureCapability({ dataRoot: enabledCameraRoot, id: "computer-camera", configuration: { pythonCommand: "python" } });
  setCapabilityEnabled({ dataRoot: enabledCameraRoot, id: "computer-camera", enabled: true });
  await assert.rejects(
    () => execFileAsync(process.execPath, [cli, "ability", "invoke", "--id", "computer-camera", "--data-root", enabledCameraRoot, "--request-json", '{"operation":"start","authorize":true}'], { cwd: PACKAGE_ROOT }),
    (error) => {
      const response = JSON.parse(error.stdout);
      return error.code === 1 && response.status === "error" && /不接受裸 authorize/u.test(response.message);
    },
  );
});
