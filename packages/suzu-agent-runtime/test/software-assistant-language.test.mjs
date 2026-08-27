import assert from "node:assert/strict";
import test from "node:test";

import {
  SOFTWARE_ASSISTANT_TOOL_TEXT,
  apply,
  localizeSoftwareAssistantMessages,
  localizeSoftwareAssistantSkillContent,
  localizeSoftwareAssistantToolAssembly,
  renderSoftwareAssistantSkillCatalog,
} from "../src/software-assistant-language.mjs";

function createContext() {
  const listeners = new Map();
  return {
    listeners,
    on(event, callback, options = {}) {
      listeners.set(event, { callback, options });
      return () => listeners.delete(event);
    },
  };
}

async function actualCoreToolSchemas() {
  const registered = [];
  const sandboxPolicy = {
    resolve() {
      return { mode: "workspace-write", workspaceRoot: "D:\\workspace" };
    },
  };
  const ctx = {
    tools: {
      register(tool) {
        registered.push(tool);
        return () => {};
      },
      get() { return undefined; },
    },
    fs: { sandboxMode: "workspace-write" },
    systemPrompt: {
      section() { return () => {}; },
      tools() { return () => {}; },
    },
    subprocess: {},
    shell: { sandboxMode: "workspace-write" },
    shellEnv: { collect() { return {}; } },
    agents: {},
    skills: {},
    attachments: {},
    on() { return () => {}; },
    get(service) { return service === "sandboxPolicy" ? sandboxPolicy : undefined; },
    inject(_dependencies, callback) {
      callback(ctx);
      return () => {};
    },
  };

  const filesystem = await import("../vendor/core/modules/filesystem.mjs");
  filesystem.apply(ctx, {
    readLimit: 2_000,
    readMaxLineLength: 2_000,
    readMaxBytes: 51_200,
    readStreamMinSize: 10_485_760,
  });
  const search = await import("../vendor/core/modules/filesystem-search.mjs");
  await search.apply(ctx, {
    sampleOverCapGlobResults: false,
    globMaxResults: 100,
    grepMaxMatches: 250,
    grepMaxLineBytes: 2_000,
    searchMetaMaxBytes: 65_536,
    rawOutputMaxBytes: 10_485_760,
    graceMs: 1_000,
    stderrMaxBytes: 65_536,
    timeoutMs: 30_000,
  });
  for (const moduleName of ["terminal-pwsh", "terminal-bash"]) {
    const terminal = await import(`../vendor/core/modules/${moduleName}.mjs`);
    terminal.apply(ctx, { enableRunInBackground: false });
  }
  const skillTool = await import("../vendor/core/modules/skill-tool.mjs");
  skillTool.apply(ctx, { catalogDescriptionMaxLength: 500 });

  return registered.map(({ name, description, parameters }) => ({ name, description, parameters }));
}

const SKILLS = Object.freeze([
  Object.freeze({
    name: "software-navigation",
    description: "当用户要查看当前软件状态、查找或打开页面，或切换主题时使用。",
  }),
  Object.freeze({
    name: "software-diagnostics",
    description: "当用户报告软件异常、页面状态问题，或希望核对本机设置时使用。",
  }),
]);

test("software assistant presents tool definitions in Chinese", () => {
  const original = {
    sections: [],
    contexts: [],
    variables: {},
    tools: [
      {
        name: "pwsh",
        description: "Execute a PowerShell command.",
        parameters: {
          type: "object",
          properties: {
            command: { type: "string", description: "The PowerShell command to execute." },
            timeoutMs: { type: "number", description: "Timeout in milliseconds." },
            workdir: { type: "string", description: "Working directory." },
          },
          required: ["command"],
        },
      },
      {
        name: "skill",
        description: "Load the full instructions for an available skill.",
        parameters: {
          type: "object",
          properties: { name: { type: "string", description: "The exact skill name." } },
          required: ["name"],
        },
      },
      {
        name: "suzu_software_status",
        description: "读取当前 Suzu Lives 的主题、版本、更新状态、数据目录和程序位置。",
        parameters: { type: "object", properties: {} },
      },
    ],
  };

  const localized = localizeSoftwareAssistantToolAssembly(original);

  assert.equal(localized.tools[0].description, SOFTWARE_ASSISTANT_TOOL_TEXT.pwsh.description);
  assert.equal(localized.tools[0].parameters.properties.command.description, "要执行的 PowerShell 命令。");
  assert.equal(localized.tools[0].parameters.properties.timeoutMs.description, "超时时间，单位为毫秒。执行器会应用当前配置的默认值和上限，并在超时后结束命令。");
  assert.equal(localized.tools[0].parameters.properties.workdir.description, "命令的工作目录。默认使用当前会话工作区；相对路径以工作区为基准解析。");
  assert.equal(localized.tools[1].description, "读取当前会话中一项可用技能的完整说明。参数使用技能目录中的准确名称。");
  assert.equal(localized.tools[1].parameters.properties.name.description, "技能目录中的准确名称。");
  assert.equal(localized.tools[2], original.tools[2]);
  assert.equal(original.tools[0].description, "Execute a PowerShell command.");
});

test("software assistant covers every mounted Core tool description and parameter", async () => {
  const localized = localizeSoftwareAssistantToolAssembly({ tools: await actualCoreToolSchemas() });
  assert.deepEqual(localized.tools.map((tool) => tool.name), [
    "read",
    "read_image",
    "write",
    "edit",
    "glob",
    "grep",
    "pwsh",
    "bash",
    "skill",
  ]);
  for (const tool of localized.tools) {
    const copy = SOFTWARE_ASSISTANT_TOOL_TEXT[tool.name];
    assert.equal(tool.description, copy.description);
    for (const [parameterName, property] of Object.entries(tool.parameters.properties)) {
      assert.equal(property.description, copy.parameters[parameterName]);
    }
  }
});

test("software assistant presents the initial and refreshed skill catalogs in Chinese", () => {
  const initialText = renderSoftwareAssistantSkillCatalog(SKILLS);
  const refreshedText = renderSoftwareAssistantSkillCatalog(SKILLS, { update: true });

  assert.match(initialText, /技能是一组可复用的任务说明/u);
  assert.match(initialText, /使用 `skill` 工具读取该技能的完整说明/u);
  assert.match(initialText, /目录只提供适用范围，具体步骤以技能正文为准/u);
  assert.match(initialText, /<skill_content>/u);
  assert.match(refreshedText, /技能目录已经更新，以下完整目录替代此前的目录/u);
  assert.match(refreshedText, /software-navigation/u);

  const messages = localizeSoftwareAssistantMessages([
    {
      id: "catalog-1",
      role: "user",
      source: { kind: "skill-catalog", form: "catalog", entries: SKILLS },
      content: [{ type: "text", text: "English catalog" }],
    },
    {
      id: "catalog-2",
      role: "user",
      source: { kind: "skill-catalog", form: "catalog", update: true, entries: SKILLS },
      content: [{ type: "text", text: "English replacement catalog" }],
    },
  ]);

  assert.equal(messages[0].content[0].text, initialText);
  assert.equal(messages[1].content[0].text, refreshedText);
});

test("software assistant presents loaded skill resources in Chinese", () => {
  const rendered = [
    '<skill_content name="software-navigation">',
    "<skill_resources>",
    "Base directory for this skill: D:\\Suzu\\skills\\software-navigation",
    "Resolve relative paths mentioned by this skill against the base directory before using them. Load referenced resources only as needed.",
    "</skill_resources>",
    "",
    "<skill_instructions>",
    "按用户目标打开页面。",
    "</skill_instructions>",
    "</skill_content>",
  ].join("\n");
  const localized = localizeSoftwareAssistantSkillContent(rendered);

  assert.match(localized, /此技能的资源目录：D:\\Suzu\\skills\\software-navigation/u);
  assert.match(localized, /技能中提到的相对路径以该资源目录为基准/u);
  assert.match(localized, /按用户目标打开页面/u);
});

test("software assistant language hooks cover prompt assembly, skill messages, and skill results", async () => {
  const ctx = createContext();
  apply(ctx);

  assert.equal(ctx.listeners.get("system-prompt/assemble").options.prepend, true);
  assert.equal(ctx.listeners.get("agent/pre-step").options.prepend, true);
  assert.equal(ctx.listeners.get("tools/post-execute").options.prepend, true);

  const assembled = await ctx.listeners.get("system-prompt/assemble").callback(
    {},
    {},
    async () => ({
      tools: [{
        name: "read",
        description: "Read a UTF-8 text file.",
        parameters: {
          type: "object",
          properties: { file_path: { type: "string", description: "Path to read." } },
        },
      }],
    }),
  );
  assert.equal(assembled.tools[0].description, "读取 UTF-8 文本文件，并返回带行号的内容。");

  const preStep = await ctx.listeners.get("agent/pre-step").callback({}, async () => ({
    kind: "enter",
    messages: [{
      id: "skill-invocation-1",
      role: "user",
      source: { kind: "skill-invocation", name: "software-navigation", form: "instructions" },
      content: [{
        type: "text",
        text: [
          '<skill_content name="software-navigation">',
          "<skill_resources>",
          'Resources for this skill are managed by provider "filesystem".',
          "Load referenced resources only as needed.",
          "</skill_resources>",
          "</skill_content>",
        ].join("\n"),
      }],
    }],
  }));
  assert.match(preStep.messages[0].content[0].text, /此技能的资源由提供方“filesystem”管理/u);

  const result = {
    content: [{
      type: "text",
      text: "Base URL for this skill: https://example.test/skill\nResolve relative URLs mentioned by this skill against the base URL before using them. Load referenced resources only as needed.",
    }],
  };
  const decision = await ctx.listeners.get("tools/post-execute").callback(
    { name: "skill" },
    result,
    async () => ({ kind: "accept" }),
  );
  assert.match(decision.content[0].text, /此技能的资源地址：https:\/\/example\.test\/skill/u);
  assert.match(decision.content[0].text, /技能中提到的相对地址以该资源地址为基准/u);
});
