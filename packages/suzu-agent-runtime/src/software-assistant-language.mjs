export const name = "suzu-software-assistant-language";
export const inject = [];

export const SOFTWARE_ASSISTANT_TOOL_TEXT = Object.freeze({
  bash: Object.freeze({
    description: "在新的 Bash 进程中执行命令，并返回标准输出和标准错误。每次调用彼此独立，使用 workdir 指定工作目录。非零退出码以 [exit code: N] 标记；过长输出会返回末尾，并在可保存时给出完整输出文件路径。当前配置使用前台执行，命令需要在 timeoutMs 内结束。",
    parameters: Object.freeze({
      command: "要执行的 Bash 命令。",
      description: "简短概括命令用途，使用主动语态；这段文字会显示在操作界面中。",
      timeoutMs: "超时时间，单位为毫秒。执行器会应用当前配置的默认值和上限，并在超时后结束命令。",
      workdir: "命令的工作目录。默认使用当前会话工作区；相对路径以工作区为基准解析。",
      run_in_background: "是否在后台运行并立即返回任务 ID。",
      sandbox_permissions: "本次命令需要的扩展沙箱权限。用于在沙箱拒绝同一命令后原样重试，并交由用户审批。",
      justification: "申请扩展沙箱权限时，向用户说明本次命令需要该权限的原因。",
    }),
  }),
  edit: Object.freeze({
    description: "在现有 UTF-8 文本文件中按字面内容替换文本。",
    parameters: Object.freeze({
      file_path: "要编辑的文件路径，由文件系统后端解析。",
      old_string: "要替换的原文字面内容，必须准确匹配。",
      new_string: "替换后的字面内容；传入空字符串可删除匹配内容。",
      replace_all: "是否替换全部匹配项。默认关闭；关闭时，原文必须只出现一次。",
      sandbox_permissions: "本次文件操作需要的扩展沙箱权限。用于在沙箱拒绝同一操作后原样重试，并交由用户审批。",
      justification: "申请扩展沙箱权限时，向用户说明本次文件操作需要该权限的原因。",
    }),
  }),
  glob: Object.freeze({
    description: "查找路径符合 glob 模式的文件。结果只包含文件路径，覆盖隐藏文件和被忽略的文件，并排除版本控制元数据目录；路径按修改时间返回，超过上限时会说明完整结果的保存位置。",
    parameters: Object.freeze({
      pattern: "用于匹配文件路径的 glob 模式，例如 **/*.ts 或 src/**/*.test.js。不含路径分隔符的模式会在任意深度匹配文件名。",
      path: "要搜索的目录。默认使用当前会话工作区；相对路径以工作区为基准解析。",
    }),
  }),
  grep: Object.freeze({
    description: "使用 ripgrep 正则表达式搜索文件内容，按文件分组返回带行号的匹配行。结果超过上限时会说明完整结果的保存位置；需要上下文时可继续读取对应文件。",
    parameters: Object.freeze({
      pattern: "要搜索的正则表达式，使用 ripgrep 语法。",
      path: "要搜索的文件或目录。默认使用当前会话工作区；相对路径以工作区为基准解析。",
      include: "限定搜索文件的单个 glob 模式，例如 *.ts 或 *.{js,jsx}；一次传入一个模式，当前不支持取反模式。",
    }),
  }),
  pwsh: Object.freeze({
    description: "在新的 PowerShell 进程中执行命令，并返回标准输出和标准错误。每次调用彼此独立，使用 workdir 指定工作目录。非零退出码以 [exit code: N] 标记；过长输出会返回末尾，并在可保存时给出完整输出文件路径。当前配置使用前台执行，命令需要在 timeoutMs 内结束。",
    parameters: Object.freeze({
      command: "要执行的 PowerShell 命令。",
      description: "简短概括命令用途，使用主动语态；这段文字会显示在操作界面中。",
      timeoutMs: "超时时间，单位为毫秒。执行器会应用当前配置的默认值和上限，并在超时后结束命令。",
      workdir: "命令的工作目录。默认使用当前会话工作区；相对路径以工作区为基准解析。",
      run_in_background: "是否在后台运行并立即返回任务 ID。",
      sandbox_permissions: "本次命令需要的扩展沙箱权限。用于在沙箱拒绝同一命令后原样重试，并交由用户审批。",
      justification: "申请扩展沙箱权限时，向用户说明本次命令需要该权限的原因。",
    }),
  }),
  read: Object.freeze({
    description: "读取 UTF-8 文本文件，并返回带行号的内容。",
    parameters: Object.freeze({
      file_path: "要读取的文件路径，由文件系统后端解析。",
      offset: "开始返回的行号，从 1 计数；默认从第 1 行开始。",
      limit: "最多返回的行数；默认使用工具的当前配置。",
      sandbox_permissions: "本次文件操作需要的扩展沙箱权限。用于在沙箱拒绝同一操作后原样重试，并交由用户审批。",
      justification: "申请扩展沙箱权限时，向用户说明本次文件操作需要该权限的原因。",
    }),
  }),
  read_image: Object.freeze({
    description: "读取 PNG、JPEG、WebP 或 GIF 图片，并把图片内容交给当前模型。当前模型需要支持图片输入。",
    parameters: Object.freeze({
      file_path: "要读取的图片路径，由文件系统后端解析。",
      sandbox_permissions: "本次文件操作需要的扩展沙箱权限。用于在沙箱拒绝同一操作后原样重试，并交由用户审批。",
      justification: "申请扩展沙箱权限时，向用户说明本次文件操作需要该权限的原因。",
    }),
  }),
  skill: Object.freeze({
    description: "读取当前会话中一项可用技能的完整说明。参数使用技能目录中的准确名称。",
    parameters: Object.freeze({
      name: "技能目录中的准确名称。",
    }),
  }),
  write: Object.freeze({
    description: "创建或完整替换一个 UTF-8 文本文件。",
    parameters: Object.freeze({
      file_path: "要写入的文件路径，由文件系统后端解析。",
      content: "要写入文件的完整 UTF-8 文本内容。",
      sandbox_permissions: "本次文件操作需要的扩展沙箱权限。用于在沙箱拒绝同一操作后原样重试，并交由用户审批。",
      justification: "申请扩展沙箱权限时，向用户说明本次文件操作需要该权限的原因。",
    }),
  }),
});

function escapeCatalogText(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function skillCatalogEntries(source) {
  if (!Array.isArray(source?.entries)) return;
  const entries = [];
  for (const entry of source.entries) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return;
    if (typeof entry.name !== "string" || !entry.name || typeof entry.description !== "string") return;
    entries.push({ name: entry.name, description: entry.description });
  }
  return entries;
}

export function renderSoftwareAssistantSkillCatalog(entries, { update = false } = {}) {
  const catalog = entries.map(({ name: skillName, description }) => (
    `- \`${skillName}\`: ${escapeCatalogText(description)}`
  ));
  const guidance = entries.length === 0
    ? [
      "当前目录中没有可通过 `skill` 工具读取的技能。用户直接触发后出现在会话中的 <skill_content> 仍可直接使用。",
    ]
    : [
      "用户点名某项技能，或当前任务明显符合某项描述时，使用 `skill` 工具读取该技能的完整说明；有多项适用时依次读取，并按正文协助用户。目录只提供适用范围，具体步骤以技能正文为准。",
      "用户直接触发技能时，会话中会出现对应的 <skill_content>，直接按其中说明处理。",
    ];
  return [
    "<system-reminder>",
    update
      ? "技能目录已经更新，以下完整目录替代此前的目录："
      : "技能是一组可复用的任务说明。本会话可以使用以下技能：",
    "",
    "<available_skills>",
    ...catalog,
    "</available_skills>",
    "",
    ...guidance,
    "</system-reminder>",
  ].join("\n");
}

export function localizeSoftwareAssistantSkillContent(value) {
  const lines = String(value ?? "").split(/\r?\n/u);
  return lines.map((line) => {
    const directory = /^Base directory for this skill: (.+)$/u.exec(line);
    if (directory) return `此技能的资源目录：${directory[1]}`;
    const url = /^Base URL for this skill: (.+)$/u.exec(line);
    if (url) return `此技能的资源地址：${url[1]}`;
    const provider = /^Resources for this skill are managed by provider "(.+)"\.$/u.exec(line);
    if (provider) return `此技能的资源由提供方“${provider[1]}”管理。`;
    const opaque = /^Resources for this skill: (.+)$/u.exec(line);
    if (opaque) return `此技能的资源说明：${opaque[1]}`;
    if (line === "Load referenced resources only as needed.") {
      return "按当前任务需要读取引用资源。";
    }
    if (line === "Resolve relative paths mentioned by this skill against the base directory before using them. Load referenced resources only as needed.") {
      return "技能中提到的相对路径以该资源目录为基准；按当前任务需要读取引用资源。";
    }
    if (line === "Resolve relative URLs mentioned by this skill against the base URL before using them. Load referenced resources only as needed.") {
      return "技能中提到的相对地址以该资源地址为基准；按当前任务需要读取引用资源。";
    }
    return line;
  }).join("\n");
}

function localizeContentBlocks(content) {
  if (!Array.isArray(content)) return content;
  let changed = false;
  const localized = content.map((block) => {
    if (block?.type !== "text" || typeof block.text !== "string") return block;
    const text = localizeSoftwareAssistantSkillContent(block.text);
    if (text === block.text) return block;
    changed = true;
    return { ...block, text };
  });
  return changed ? localized : content;
}

function localizeSkillMessage(message) {
  const source = message?.source;
  if (source?.kind === "skill-catalog") {
    const entries = skillCatalogEntries(source);
    if (entries === undefined) return message;
    return {
      ...message,
      content: [{
        type: "text",
        text: renderSoftwareAssistantSkillCatalog(entries, { update: source.update === true }),
      }],
    };
  }
  if (source?.kind !== "skill-invocation") return message;
  const content = localizeContentBlocks(message.content);
  return content === message.content ? message : { ...message, content };
}

export function localizeSoftwareAssistantMessages(messages) {
  if (!Array.isArray(messages)) return messages;
  let changed = false;
  const localized = messages.map((message) => {
    const result = localizeSkillMessage(message);
    if (result !== message) changed = true;
    return result;
  });
  return changed ? localized : messages;
}

function localizeToolParameters(parameters, copy) {
  if (!parameters || typeof parameters !== "object" || !copy) return parameters;
  const localized = structuredClone(parameters);
  const properties = localized?.properties;
  if (!properties || typeof properties !== "object") return localized;
  for (const [parameterName, description] of Object.entries(copy)) {
    const property = properties[parameterName];
    if (property && typeof property === "object") property.description = description;
  }
  return localized;
}

export function localizeSoftwareAssistantToolAssembly(assembly) {
  if (!assembly || typeof assembly !== "object" || !Array.isArray(assembly.tools)) return assembly;
  let changed = false;
  const localizedTools = assembly.tools.map((tool) => {
    const copy = SOFTWARE_ASSISTANT_TOOL_TEXT[tool?.name];
    if (!copy) return tool;
    changed = true;
    return {
      ...tool,
      description: copy.description,
      parameters: localizeToolParameters(tool.parameters, copy.parameters),
    };
  });
  return changed ? { ...assembly, tools: localizedTools } : assembly;
}

export function apply(ctx) {
  ctx.on("system-prompt/assemble", async (_assembly, _options, next) => {
    const assembled = await next();
    return localizeSoftwareAssistantToolAssembly(assembled);
  }, { prepend: true });

  ctx.on("agent/pre-step", async (_event, next) => {
    const outcome = await next();
    if (outcome?.kind !== "enter") return outcome;
    const messages = localizeSoftwareAssistantMessages(outcome.messages);
    return messages === outcome.messages ? outcome : { ...outcome, messages };
  }, { prepend: true });

  ctx.on("tools/post-execute", async (execution, result, next) => {
    const decision = await next();
    if (execution?.name !== "skill" || decision?.kind !== "accept" || Object.hasOwn(decision, "value")) {
      return decision;
    }
    const originalContent = decision.content ?? result?.content;
    const content = localizeContentBlocks(originalContent);
    return content === originalContent ? decision : { ...decision, content };
  }, { prepend: true });
}
