import { createSuzuAgentCoreNativeRequire } from "./core-bundle.mjs";

let sharpRuntime = null;

function sharp(value, options) {
  if (!sharpRuntime) {
    const loaded = createSuzuAgentCoreNativeRequire()("sharp");
    sharpRuntime = typeof loaded === "function" ? loaded : loaded?.default;
    if (typeof sharpRuntime !== "function") throw new Error("Sharp 图片运行时无效。");
  }
  return sharpRuntime(value, options);
}

const DEFAULT_MAX_EDGE_PIXELS = 512;
const MAX_DECODED_PIXELS = 40_000_000;
const SUPPORTED_FORMATS = new Set(["png", "jpeg", "webp"]);

function positiveInteger(value, fallback) {
  const candidate = Number(value);
  return Number.isSafeInteger(candidate) && candidate > 0 ? candidate : fallback;
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function normalizedBox(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const coordinates = [source.left, source.top, source.right, source.bottom].map(Number);
  if (coordinates.some((coordinate) => !Number.isFinite(coordinate))) return null;
  const scale = coordinates.some((coordinate) => coordinate > 1)
    && coordinates.every((coordinate) => coordinate >= 0 && coordinate <= 100)
    ? 100
    : 1;
  const [left, top, right, bottom] = coordinates.map((coordinate) => clamp(coordinate / scale, 0, 1));
  if (right - left < 0.01 || bottom - top < 0.01) return null;
  return { left, top, right, bottom };
}

export function centeredSquareCrop({ width, height }) {
  const resolvedWidth = positiveInteger(width, 0);
  const resolvedHeight = positiveInteger(height, 0);
  if (!resolvedWidth || !resolvedHeight) throw new Error("头像图片尺寸无法读取。");
  const edge = Math.min(resolvedWidth, resolvedHeight);
  return Object.freeze({
    left: Math.floor((resolvedWidth - edge) / 2),
    top: Math.floor((resolvedHeight - edge) / 2),
    width: edge,
    height: edge,
  });
}

/**
 * A deterministic fallback for portrait artwork. Character portraits normally
 * place the face above the geometric centre, so spare vertical area stays below.
 */
export function portraitBiasedSquareCrop({ width, height }) {
  const resolvedWidth = positiveInteger(width, 0);
  const resolvedHeight = positiveInteger(height, 0);
  if (!resolvedWidth || !resolvedHeight) throw new Error("头像图片尺寸无法读取。");
  const edge = Math.min(resolvedWidth, resolvedHeight);
  return Object.freeze({
    left: resolvedWidth > edge ? Math.floor((resolvedWidth - edge) / 2) : 0,
    top: resolvedHeight > edge ? Math.floor((resolvedHeight - edge) * 0.12) : 0,
    width: edge,
    height: edge,
  });
}

/**
 * Converts a normalized head-and-hair box into an in-bounds square crop.
 * Framing, padding, and clamping remain deterministic in code.
 */
export function squareCropAroundNormalizedBox({ width, height, box, padding = 0.35 }) {
  const resolvedWidth = positiveInteger(width, 0);
  const resolvedHeight = positiveInteger(height, 0);
  if (!resolvedWidth || !resolvedHeight) throw new Error("头像图片尺寸无法读取。");
  const resolvedBox = normalizedBox(box);
  if (!resolvedBox) throw new Error("头像主体位置无法读取。");
  const safePadding = clamp(Number.isFinite(Number(padding)) ? Number(padding) : 0.35, 0, 1);
  const boxWidth = (resolvedBox.right - resolvedBox.left) * resolvedWidth;
  const boxHeight = (resolvedBox.bottom - resolvedBox.top) * resolvedHeight;
  const maximumEdge = Math.min(resolvedWidth, resolvedHeight);
  const minimumEdge = Math.max(1, Math.round(maximumEdge * 0.35));
  const edge = clamp(Math.ceil(Math.max(boxWidth, boxHeight) * (1 + safePadding)), minimumEdge, maximumEdge);
  const centerX = ((resolvedBox.left + resolvedBox.right) / 2) * resolvedWidth;
  const centerY = (((resolvedBox.top + resolvedBox.bottom) / 2) * resolvedHeight) + (boxHeight * 0.08);
  const left = clamp(Math.round(centerX - (edge / 2)), 0, resolvedWidth - edge);
  const top = clamp(Math.round(centerY - (edge / 2)), 0, resolvedHeight - edge);
  return Object.freeze({ left, top, width: edge, height: edge });
}

export async function normalizeSquareAvatarImage(value, {
  cropBox = null,
  maxEdgePixels = DEFAULT_MAX_EDGE_PIXELS,
} = {}) {
  const bytes = Buffer.isBuffer(value)
    ? value
    : value instanceof Uint8Array ? Buffer.from(value) : Buffer.alloc(0);
  if (!bytes.length) throw new Error("头像图片为空。");
  const outputEdgeLimit = positiveInteger(maxEdgePixels, DEFAULT_MAX_EDGE_PIXELS);

  let metadata;
  try {
    metadata = await sharp(bytes, { failOn: "error", limitInputPixels: MAX_DECODED_PIXELS }).metadata();
  } catch (error) {
    throw new Error("头像图片无法解码。", { cause: error });
  }
  if (!SUPPORTED_FORMATS.has(String(metadata?.format || ""))) {
    throw new Error("头像图片格式无法识别；请选择 PNG、JPEG 或 WebP 图片。");
  }
  const oriented = metadata?.autoOrient && typeof metadata.autoOrient === "object"
    ? metadata.autoOrient
    : metadata;
  const crop = cropBox
    ? squareCropAroundNormalizedBox({ width: oriented?.width, height: oriented?.height, box: cropBox })
    : portraitBiasedSquareCrop({ width: oriented?.width, height: oriented?.height });
  if (crop.width * crop.height > MAX_DECODED_PIXELS) {
    throw new Error("头像图片像素尺寸过大。");
  }
  const outputEdge = Math.min(crop.width, outputEdgeLimit);
  if (metadata.format === "png"
    && (!metadata.orientation || metadata.orientation === 1)
    && crop.left === 0
    && crop.top === 0
    && crop.width === outputEdge) {
    return Object.freeze({
      bytes,
      crop,
      mimeType: "image/png",
      strategy: cropBox ? "subject-box" : "portrait-bias",
      width: outputEdge,
      height: outputEdge,
    });
  }

  let output;
  try {
    let pipeline = sharp(bytes, { failOn: "error", limitInputPixels: MAX_DECODED_PIXELS })
      .autoOrient()
      .extract(crop);
    if (outputEdge < crop.width) {
      pipeline = pipeline.resize({
        width: outputEdge,
        height: outputEdge,
        fit: "fill",
        kernel: "lanczos3",
      });
    }
    output = await pipeline.png().toBuffer();
  } catch (error) {
    throw new Error("头像图片无法裁剪。", { cause: error });
  }
  return Object.freeze({
    bytes: output,
    crop,
    mimeType: "image/png",
    strategy: cropBox ? "subject-box" : "portrait-bias",
    width: outputEdge,
    height: outputEdge,
  });
}
