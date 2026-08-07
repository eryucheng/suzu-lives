const AVATAR_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

export const AVATAR_CROP_MIN_ZOOM = 1;
export const AVATAR_CROP_MAX_ZOOM = 3;
export const AVATAR_CROP_OUTPUT_SIZE = 512;

function positiveNumber(value, fallback = 1) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function clamp(value, minimum, maximum) {
  return Math.min(Math.max(value, minimum), maximum);
}

function cropZoom(value) {
  const number = Number(value);
  return clamp(Number.isFinite(number) ? number : AVATAR_CROP_MIN_ZOOM, AVATAR_CROP_MIN_ZOOM, AVATAR_CROP_MAX_ZOOM);
}

function finiteOffset(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

export function avatarCropLayout(value = {}) {
  const imageWidth = positiveNumber(value.imageWidth);
  const imageHeight = positiveNumber(value.imageHeight);
  const viewportWidth = positiveNumber(value.viewportWidth, 320);
  const viewportHeight = positiveNumber(value.viewportHeight, viewportWidth);
  const zoom = cropZoom(value.zoom);
  const scale = Math.max(viewportWidth / imageWidth, viewportHeight / imageHeight) * zoom;
  const displayWidth = imageWidth * scale;
  const displayHeight = imageHeight * scale;
  const minimumX = Math.min(0, viewportWidth - displayWidth);
  const minimumY = Math.min(0, viewportHeight - displayHeight);
  const defaultX = (viewportWidth - displayWidth) / 2;
  const defaultY = (viewportHeight - displayHeight) / 2;
  return {
    imageWidth,
    imageHeight,
    viewportWidth,
    viewportHeight,
    zoom,
    displayWidth,
    displayHeight,
    minimumX,
    minimumY,
    offsetX: clamp(finiteOffset(value.offsetX, defaultX), minimumX, 0),
    offsetY: clamp(finiteOffset(value.offsetY, defaultY), minimumY, 0),
  };
}

function cropState(value, layout) {
  return {
    ...value,
    imageWidth: layout.imageWidth,
    imageHeight: layout.imageHeight,
    viewportWidth: layout.viewportWidth,
    viewportHeight: layout.viewportHeight,
    zoom: layout.zoom,
    offsetX: layout.offsetX,
    offsetY: layout.offsetY,
  };
}

export function createSquareAvatarCrop({ source = "", imageWidth, imageHeight, viewportWidth = 320, viewportHeight = viewportWidth } = {}) {
  const layout = avatarCropLayout({ imageWidth, imageHeight, viewportWidth, viewportHeight });
  return cropState({ source: String(source || "") }, layout);
}

export function moveAvatarCrop(value, deltaX = 0, deltaY = 0) {
  const layout = avatarCropLayout(value);
  const next = avatarCropLayout({
    ...value,
    ...layout,
    offsetX: layout.offsetX + finiteOffset(deltaX, 0),
    offsetY: layout.offsetY + finiteOffset(deltaY, 0),
  });
  return cropState(value, next);
}

function preserveCropCenter(value, nextValue) {
  const current = avatarCropLayout(value);
  const next = avatarCropLayout(nextValue);
  const focusX = (current.viewportWidth / 2 - current.offsetX) / current.displayWidth;
  const focusY = (current.viewportHeight / 2 - current.offsetY) / current.displayHeight;
  const positioned = avatarCropLayout({
    ...nextValue,
    ...next,
    offsetX: next.viewportWidth / 2 - focusX * next.displayWidth,
    offsetY: next.viewportHeight / 2 - focusY * next.displayHeight,
  });
  return cropState(value, positioned);
}

export function setAvatarCropZoom(value, zoom) {
  return preserveCropCenter(value, { ...value, zoom: cropZoom(zoom) });
}

export function resizeAvatarCropViewport(value, viewportWidth, viewportHeight = viewportWidth) {
  return preserveCropCenter(value, {
    ...value,
    viewportWidth: positiveNumber(viewportWidth, 320),
    viewportHeight: positiveNumber(viewportHeight, positiveNumber(viewportWidth, 320)),
  });
}

export function avatarCropSourceRect(value) {
  const layout = avatarCropLayout(value);
  const scaleX = layout.imageWidth / layout.displayWidth;
  const scaleY = layout.imageHeight / layout.displayHeight;
  const width = layout.viewportWidth * scaleX;
  const height = layout.viewportHeight * scaleY;
  return {
    x: clamp(-layout.offsetX * scaleX, 0, Math.max(0, layout.imageWidth - width)),
    y: clamp(-layout.offsetY * scaleY, 0, Math.max(0, layout.imageHeight - height)),
    width,
    height,
  };
}

export function readAvatarFile(file, { FileReaderCtor = globalThis.FileReader } = {}) {
  return new Promise((resolve, reject) => {
    if (!file || !AVATAR_TYPES.has(file.type)) {
      reject(new Error("请选择 PNG、JPEG 或 WebP 图片。"));
      return;
    }
    if (typeof FileReaderCtor !== "function") {
      reject(new Error("当前环境无法读取头像文件。"));
      return;
    }
    const reader = new FileReaderCtor();
    reader.addEventListener("load", () => resolve(String(reader.result || "")));
    reader.addEventListener("error", () => reject(new Error("无法读取该头像文件。")));
    reader.readAsDataURL(file);
  });
}
