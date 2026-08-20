import { resolveAgentDataRoot, resolveSuzuLivesDataRoot } from "@suzu-lives/agent-registry";

import { loadPhoneCameraComfyConnection, loadPhoneConfig, PhoneCameraError, takePhonePhoto } from "./index.mjs";

function clean(value) { return String(value ?? "").trim(); }
function nextValue(values, index, flag) { const value = values[index + 1]; if (!value || value.startsWith("--")) throw new PhoneCameraError(`${flag} 缺少值。`); return value; }
function scopedReference(value) {
  const reference = clean(value);
  if (!/^(?:shared|contact):[a-z0-9]+(?:[.-][a-z0-9]+)*$/u.test(reference)) {
    throw new PhoneCameraError("--ref 必须写成 shared:<asset-or-set-id> 或 contact:<asset-or-set-id>。 ");
  }
  return reference;
}

export function parsePhoneCameraArgs(values = []) {
  const result = { refs: [] };
  const flags = new Set(["dry-run"]); const options = new Set(["shot", "scene", "ref", "backend", "workflow", "size", "seed", "out", "config", "data-root", "agent-id", "project-root"]);
  for (let index = 0; index < values.length; index += 1) { const token = values[index]; if (!token.startsWith("--")) throw new PhoneCameraError("未知位置参数：" + token); const key = token.slice(2); if (key === "send") throw new PhoneCameraError("手机拍照式图片不再支持 --send；生成完成后请使用当前 Suzu 会话提供的附件交付命令。 "); if (flags.has(key)) { result[key === "dry-run" ? "dryRun" : key] = true; continue; } if (!options.has(key)) throw new PhoneCameraError("未知选项：" + token); const value = nextValue(values, index, token); index += 1; if (key === "ref") result.refs.push(scopedReference(value)); else if (key === "seed") { const seed = Number(value); if (!Number.isInteger(seed)) throw new PhoneCameraError("--seed 必须是整数。 "); result.seed = seed; } else result[key.replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase())] = value; }
  if (!clean(result.shot) || !clean(result.scene)) throw new PhoneCameraError("--shot 与 --scene 均为必填。 "); return result;
}

export async function runPhoneCameraCli(values, { environment = process.env, fetchImpl = fetch, connectionResolver } = {}) {
  const options = parsePhoneCameraArgs(values); const dataRoot = resolveSuzuLivesDataRoot({ configuredRoot: options.dataRoot || environment.SUZU_LIVES_DATA_ROOT, localAppData: environment.LOCALAPPDATA, appData: environment.APPDATA, fallbackBase: "", fallbackToLocatorWhenMissing: true }); const agentRoot = resolveAgentDataRoot({ dataRoot, agentId: options.agentId || environment.SUZU_LIVES_AGENT_ID, projectRoot: options.projectRoot || environment.SUZU_LIVES_PROJECT_ROOT });
  const phone = await loadPhoneConfig({ dataRoot, configPath: options.config }); const backend = options.backend || phone.config.defaultBackend;
  let connection;
  if (backend === "api") {
    if (typeof connectionResolver === "function") {
      const selected = await connectionResolver({ kind: "phone-camera", dataRoot, agentRoot, options });
      const apiKey = clean(selected?.apiKey || selected?.key);
      if (!apiKey && options.dryRun !== true) throw new PhoneCameraError("“生图”API 尚未配置可用 Key；请前往 设置 → API 重新选择或保存。 ");
      connection = { ...(selected && typeof selected === "object" ? selected : {}), apiKey, key: apiKey };
    } else if (options.dryRun !== true) {
      throw new PhoneCameraError("手机拍照式生图必须由软件在 设置 → API 中选定的“生图”连接提供。 ");
    }
  }
  const comfyui = await loadPhoneCameraComfyConnection(dataRoot);
  return takePhonePhoto({ agentRoot, dataRoot, connection: backend === "comfyui" ? comfyui : connection, registry: comfyui.registry, fetchImpl, options });
}
