function clean(value) {
  return String(value ?? "").trim();
}

/** Keeps Suzu-owned controls independent from the underlying Agent runtime. */
export function parseSuzuConversationCommand(value) {
  const content = clean(value);
  if (!content.startsWith("/")) return { action: "message", content };
  if (/^\/new(?:\s|$)/iu.test(content)) {
    return { action: "notice", message: "请使用左侧联系人列表右上角的“＋”新建联系人。" };
  }
  const match = /^\/suzu(?:\s+([a-z-]+))?(?:\s+([\s\S]*))?$/iu.exec(content);
  if (!match) return { action: "message", content };
  const command = clean(match[1]).toLowerCase();
  const argument = clean(match[2]);
  if (command === "stop" && !argument) return { action: "stop" };
  if (command === "steer" && argument) return { action: "steer", content: argument };
  if (command === "queue" && argument) return { action: "queue", content: argument };
  return { action: "notice", message: "可用的 Suzu 命令：/suzu stop 停止；/suzu queue <内容> 排队发送。普通消息会优先处理。" };
}
