import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import { resolveAgentDataRoot } from "@suzu-lives/agent-registry";
import { appendUsageEvent } from "@suzu-lives/cost-ledger";
import { createVoiceCandidates, DEFAULT_VOICE_DESIGN_CONFIG, readCandidates, readPreview, validateVoiceDesignConfig, validateVoiceDesignSettings } from "@suzu-lives/voice-design";

function existsDirectory(value) { try { return Boolean(value && fs.statSync(value).isDirectory()); } catch { return false; } }
function requireAgent(settings) {
  if (!settings.agentId || !settings.projectRoot || !existsDirectory(settings.projectRoot)) throw new Error("请先选择有效的 Claude 项目目录，再配置或创建音色。");
}
function pathsFor(settingsService) {
  const settings = settingsService.load();
  requireAgent(settings);
  const dataRoot = settingsService.response(settings).dataRoot;
  const agentRoot = resolveAgentDataRoot({ dataRoot, agentId: settings.agentId });
  const root = path.join(agentRoot, "voice-design");
  return { settings, root, configPath: path.join(root, "config.json"), ledgerPath: settingsService.usageLedgerPath(settings) };
}
async function readJson(filePath, fallback = {}) { try { return JSON.parse(await fsp.readFile(filePath, "utf8")); } catch { return fallback; } }
async function writeJsonAtomic(filePath, value) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = filePath + ".tmp";
  await fsp.writeFile(temporary, JSON.stringify(value, null, 2) + "\n", "utf8");
  await fsp.rename(temporary, filePath);
}
async function storedSettings(configPath) {
  const stored = await readJson(configPath);
  let settings;
  try { settings = validateVoiceDesignSettings(stored); } catch { settings = validateVoiceDesignSettings(DEFAULT_VOICE_DESIGN_CONFIG); }
  return settings;
}
function capabilityConfig(settings, connection) { return validateVoiceDesignConfig({ ...settings, baseUrl: connection.baseUrl }); }
async function snapshot(settingsService, connectionsService) {
  const settings = settingsService.load();
  if (!settings.agentId || !settings.projectRoot || !existsDirectory(settings.projectRoot)) {
    return { status: "needs-project", config: validateVoiceDesignSettings(DEFAULT_VOICE_DESIGN_CONFIG), connection: await connectionsService.dashScopeSnapshot(), candidates: [] };
  }
  const values = pathsFor(settingsService);
  const stored = await storedSettings(values.configPath);
  return { status: "ready", config: stored, connection: await connectionsService.dashScopeSnapshot(), candidates: await readCandidates(values.root) };
}

export function registerVoiceDesignIpc({ connectionsService, ipcMain, settingsService }) {
  ipcMain.handle("voice-design:snapshot", () => snapshot(settingsService, connectionsService));
  ipcMain.handle("voice-design:save-settings", async (_event, value) => {
    const values = pathsFor(settingsService);
    const settings = validateVoiceDesignSettings(value);
    await writeJsonAtomic(values.configPath, settings);
    return snapshot(settingsService, connectionsService);
  });
  ipcMain.handle("voice-design:create", async (_event, input) => {
    const values = pathsFor(settingsService);
    const stored = await storedSettings(values.configPath);
    const connection = await connectionsService.resolveDashScope();
    if (!connection.key) throw new Error("未配置 DashScope 连接。请前往 管理 → API 与服务 保存 API Key，或设置 DASHSCOPE_API_KEY。");
    const config = capabilityConfig(stored, connection);
    await createVoiceCandidates({
      root: values.root,
      config,
      input,
      apiKey: connection.key,
      onSuccess: async (item) => appendUsageEvent(values.ledgerPath, {
        agentId: values.settings.agentId,
        provider: "阿里云百炼",
        model: item.request.model || config.designModel,
        source: "音色设计",
        feature: "voice-design",
        requestId: item.request.requestId,
        usage: item.request.usage,
        units: { generatedVoices: 1 },
        metadata: { targetModel: config.targetModel, language: config.language, previewCharacters: item.input.previewText.length },
      }),
    });
    return snapshot(settingsService, connectionsService);
  });
  ipcMain.handle("voice-design:preview", async (_event, id) => {
    const values = pathsFor(settingsService);
    const preview = await readPreview(values.root, id);
    if (!preview) return null;
    const mime = preview.responseFormat === "wav" ? "audio/wav" : preview.responseFormat === "mp3" ? "audio/mpeg" : "audio/" + preview.responseFormat;
    return "data:" + mime + ";base64," + preview.data;
  });
}
