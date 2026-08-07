import fs from "node:fs/promises";
import path from "node:path";

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

export function imageVisionModelFromPublicConfig(value = {}) {
  const vision = object(value.vision);
  const openai = object(value.openai);
  return text(vision.model) || text(openai.model);
}

export function imageVisionBaseUrlFromPublicConfig(value = {}) {
  const vision = object(value.vision);
  const openai = object(value.openai);
  return text(vision.baseUrl) || text(vision.base_url) || text(openai.baseUrl) || text(openai.base_url);
}

/**
 * A named connection owns the relay address and encrypted credential. Some
 * compatible relays expose different models for generation and vision, so a
 * feature keeps its non-secret model setting instead of inheriting the image
 * generator model from the shared connection.
 */
export async function applyFeatureConnectionOverrides({ kind = "", dataRoot = "", connection = null, readFile = fs.readFile } = {}) {
  if (kind !== "image-vision" || !connection || typeof connection !== "object") return connection;
  const root = text(dataRoot);
  if (!root) return connection;
  try {
    const filePath = path.join(root, "capabilities", "image-vision", "config.json");
    const config = JSON.parse(await readFile(filePath, "utf8"));
    const model = imageVisionModelFromPublicConfig(config);
    const baseUrl = imageVisionBaseUrlFromPublicConfig(config);
    return model || baseUrl
      ? {
          ...connection,
          ...(baseUrl ? { baseUrl } : {}),
          ...(model ? { model } : {}),
        }
      : connection;
  } catch {
    return connection;
  }
}
