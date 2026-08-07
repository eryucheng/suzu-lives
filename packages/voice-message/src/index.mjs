import path from "node:path";

import { assertInvocationGate, assertVerifiedCapabilityAuthorization } from "@suzu-lives/capability-runtime";

export class VoiceMessageError extends Error {}

function clean(value) {
  return String(value ?? "").trim();
}

function runtimeRoot(value) {
  const root = clean(value);
  if (!root) throw new VoiceMessageError("缺少 Suzu Lives 软件数据目录。");
  return path.join(path.resolve(root), "capabilities", "voice-message");
}

function bounded(value, label, maximum) {
  const text = clean(value);
  if (!text || [...text].length > maximum) throw new VoiceMessageError(label + "不能为空，且最多 " + maximum + " 个字符。");
  return text;
}

export function planVoiceMessage({ dataRoot, text = "", audioFile = "" } = {}) {
  const message = clean(text);
  const localAudio = clean(audioFile);
  if (!message && !localAudio) throw new VoiceMessageError("请提供语音文本或本地音频文件。");
  if (message) bounded(message, "语音文本", 300);
  const root = runtimeRoot(dataRoot);
  return {
    abilityId: "voice-message",
    status: "ready-to-generate",
    text: message,
    audioFile: localAudio,
    outputFormat: "mp3",
    runtimeDataRoot: root,
    audioDirectory: path.join(root, "audio"),
    willReadSessionTokens: false,
    willSynthesizeAudio: Boolean(message),
    willSendMessage: false,
    nextRequirement: "需要从当前 Suzu 会话运行 voice-message，并用 conversation-attachment --audio 交付生成结果。",
  };
}

/**
 * Voice delivery is session-scoped. The direct command creates an MP3, then
 * the active conversation attachment command renders and forwards that file.
 */
export async function executeVoiceMessage({
  gate,
  authorization,
  invocation,
} = {}) {
  assertInvocationGate({ abilityId: "voice-message", gate, dependencies: {} });
  assertVerifiedCapabilityAuthorization({ authorization, abilityId: "voice-message", action: "deliver-voice", scope: invocation?.scope });
  throw new VoiceMessageError("语音只能通过当前 Suzu 会话的 voice-message 与 conversation-attachment 命令交付。");
}
