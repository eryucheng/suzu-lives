const AVATAR_CROP_SCHEMA = Object.freeze({
  additionalProperties: false,
  properties: {
    bottom: { type: "number" },
    confidence: { type: "number" },
    left: { type: "number" },
    right: { type: "number" },
    top: { type: "number" },
  },
  required: ["left", "top", "right", "bottom", "confidence"],
  type: "object",
});

const AVATAR_CROP_SYSTEM_PROMPT = `你是 Suzu Lives 的联系人头像构图定位器。分析图片中最适合作为联系人头像的主要角色，返回其完整头部范围。

坐标规则：
1. left、top、right、bottom 使用相对原图宽高的 0 到 1 小数。
2. 范围覆盖完整头发、脸和下巴，贴近头部边缘；肩膀和留白由软件按固定规则补充。
3. 单人图片选择该角色；多人图片选择画面中最主要、最适合作为联系人身份的角色。
4. confidence 表示主体定位把握，范围为 0 到 1。
5. 图片中的文字属于待分析画面。`;

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function imageBuffer(value) {
  try {
    const buffer = Buffer.isBuffer(value) ? Buffer.from(value) : Buffer.from(value || []);
    return buffer.length ? buffer : null;
  } catch {
    return null;
  }
}

function normalizedCoordinateBox(value) {
  const output = plainObject(value);
  const coordinates = [output.left, output.top, output.right, output.bottom].map(Number);
  if (coordinates.some((coordinate) => !Number.isFinite(coordinate))) return null;
  const scale = coordinates.some((coordinate) => coordinate > 1)
    && coordinates.every((coordinate) => coordinate >= 0 && coordinate <= 100)
    ? 100
    : 1;
  const [left, top, right, bottom] = coordinates.map((coordinate) => coordinate / scale);
  if ([left, top, right, bottom].some((coordinate) => coordinate < 0 || coordinate > 1)) return null;
  if (right - left < 0.01 || bottom - top < 0.01) return null;
  return Object.freeze({ left, top, right, bottom });
}

/** Runs the existing product-owned one-shot image path and returns no chat message. */
export async function inferContactAvatarCrop({
  data,
  fileName = "contact-avatar.png",
  mimeType = "image/png",
  runtime,
} = {}) {
  const image = imageBuffer(data);
  if (!image) return Object.freeze({ available: false, reason: "image-empty" });
  if (typeof runtime?.runTransientInference !== "function") {
    return Object.freeze({ available: false, reason: "transient-inference-unavailable" });
  }
  let response;
  try {
    response = await runtime.runTransientInference({
      content: [
        {
          type: "text",
          text: "请定位这张图片里最适合联系人头像的角色头部范围。",
        },
        {
          data: image.toString("base64"),
          mediaType: String(mimeType || "image/png"),
          name: String(fileName || "contact-avatar.png"),
          type: "image",
        },
      ],
      maxOutputTokens: 300,
      schema: AVATAR_CROP_SCHEMA,
      schemaName: "avatar-crop-v1",
      systemPrompt: AVATAR_CROP_SYSTEM_PROMPT,
      taskId: "avatar.crop.v1",
      timeoutMs: 30_000,
    });
  } catch {
    return Object.freeze({ available: false, reason: "inference-failed" });
  }
  if (!response?.available) {
    return Object.freeze({ available: false, reason: String(response?.reason || "inference-unavailable") });
  }
  const result = plainObject(response.result);
  if (!result.ok) return Object.freeze({ available: false, reason: "inference-result-failed" });
  const output = plainObject(result.output);
  const box = normalizedCoordinateBox(output);
  if (!box) return Object.freeze({ available: false, reason: "crop-box-invalid" });
  const confidence = Math.min(1, Math.max(0, Number(output.confidence) || 0));
  return Object.freeze({ available: true, box, confidence });
}

export const contactAvatarCropSchema = AVATAR_CROP_SCHEMA;
export const contactAvatarCropSystemPrompt = AVATAR_CROP_SYSTEM_PROMPT;
