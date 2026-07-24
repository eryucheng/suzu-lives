#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Use an OpenAI-compatible vision chat endpoint to inspect one local image."""

from __future__ import annotations

import argparse
import base64
import json
import os
from pathlib import Path
import sys
import tempfile
from typing import Any
import urllib.error
import urllib.request


if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")


SCRIPT_DIR = Path(__file__).resolve().parent
DEFAULT_CONFIG = SCRIPT_DIR / "config.local.json"

SYSTEM_PROMPT = """你负责读取图片并提供可靠的视觉观察。
只根据图中能直接看到的内容回答，不编造被遮挡、模糊或无法确认的信息。
图片中有人物时，可以描述人数、位置、衣着、动作、表情、视线、构图和环境关系；不要识别真实身份，也不要推测种族、宗教、健康状况等敏感属性。
使用中文，先直接回答用户的问题；不确定之处明确说不确定。除非用户明确要求，不要判断图片是否由 AI 生成，也不要泛泛进行技术质检。"""

DEFAULT_QUESTION = "请客观说明这张图片里能直接看到的主要内容，以及人物或物体之间正在发生什么。"

PORTRAIT_FALLBACK = """请只做中性的可见内容描述，不识别或确认任何人的真实身份，也不推测敏感属性。
说明画面中的人数、相对位置、衣着、动作、表情、视线、周围物体和环境；看不清的地方明确说不确定。"""

REFUSAL_MARKERS = (
    "抱歉，我不能",
    "抱歉，我无法",
    "无法协助",
    "无法分析这张",
    "不能帮助",
    "i'm sorry, but i can't",
    "i’m sorry, but i can’t",
    "i cannot assist",
    "unable to analyze this image",
)

SAFETY_ERROR_MARKERS = (
    "content policy",
    "content_policy",
    "safety",
    "moderation",
    "unsafe",
    "审核",
    "安全策略",
    "内容政策",
    "违规内容",
)


class VisionError(RuntimeError):
    pass


class VisionApiError(VisionError):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="用外部视觉模型读取一张本地图片")
    parser.add_argument("image", help="本地图片路径")
    parser.add_argument("--question", help="针对图片要回答的具体问题")
    parser.add_argument("--detail", dest="legacy_question", help=argparse.SUPPRESS)
    parser.add_argument("--config", default=str(DEFAULT_CONFIG), help="配置文件路径")
    parser.add_argument("--no-retry", action="store_true", help="人物图片被拒时不做中性描述重试")
    return parser.parse_args()


def read_json(path: Path) -> dict[str, Any]:
    if not path.is_file():
        raise VisionError(f"配置文件不存在：{path}")
    try:
        with path.open("r", encoding="utf-8") as handle:
            data = json.load(handle)
    except json.JSONDecodeError as exc:
        raise VisionError(f"配置文件不是有效 JSON：{exc}") from exc
    if not isinstance(data, dict):
        raise VisionError("配置文件顶层必须是 JSON 对象")
    return data


def as_int(value: Any, default: int, minimum: int = 1) -> int:
    try:
        result = int(value)
    except (TypeError, ValueError):
        return default
    return max(minimum, result)


def as_bool(value: Any, default: bool) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() in {"1", "true", "yes", "on"}
    return default


def load_settings(path: Path) -> dict[str, Any]:
    raw = read_json(path)
    provider = raw.get("openai") if isinstance(raw.get("openai"), dict) else {}
    vision = raw.get("vision") if isinstance(raw.get("vision"), dict) else {}

    api_key = os.environ.get("VISION_API_KEY") or os.environ.get("OPENAI_API_KEY") or provider.get("api_key", "")
    base_url = os.environ.get("VISION_BASE_URL") or os.environ.get("OPENAI_BASE_URL") or provider.get("base_url", "")
    model = os.environ.get("VISION_MODEL") or vision.get("model") or provider.get("model") or "gpt-4o-mini"

    if not api_key:
        raise VisionError("没有 API Key；请填写 config.local.json，或设置 VISION_API_KEY / OPENAI_API_KEY")
    if not base_url:
        raise VisionError("没有 base_url；请填写 config.local.json，或设置 VISION_BASE_URL / OPENAI_BASE_URL")

    detail = str(vision.get("detail", "auto")).lower()
    if detail not in {"auto", "low", "high"}:
        raise VisionError("vision.detail 只能是 auto、low 或 high")

    return {
        "api_key": str(api_key),
        "base_url": str(base_url),
        "model": str(model),
        "detail": detail,
        "timeout_seconds": as_int(vision.get("timeout_seconds"), 90),
        "max_output_tokens": as_int(vision.get("max_output_tokens"), 800),
        "max_image_bytes": as_int(vision.get("max_image_bytes"), 1_572_864),
        "max_edge": as_int(vision.get("max_edge"), 1600),
        "jpeg_quality": min(95, as_int(vision.get("jpeg_quality"), 90)),
        "retry_on_refusal": as_bool(vision.get("retry_on_refusal"), True),
    }


def endpoint_from_base_url(base_url: str) -> str:
    url = base_url.rstrip("/")
    if url.endswith("/chat/completions"):
        return url
    if url.endswith("/v1"):
        return url + "/chat/completions"
    return url + "/v1/chat/completions"


def mime_for(path: Path) -> str:
    return {
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".png": "image/png",
        ".webp": "image/webp",
        ".gif": "image/gif",
    }.get(path.suffix.lower(), "")


def prepare_image(source: Path, temp_dir: Path, settings: dict[str, Any]) -> tuple[Path, str]:
    if not source.is_file():
        raise VisionError(f"图片文件不存在：{source}")

    source_mime = mime_for(source)
    source_size = source.stat().st_size

    try:
        from PIL import Image, ImageOps
    except ImportError:
        if not source_mime:
            raise VisionError("该图片格式需要 Pillow 转换；请先安装：python -m pip install Pillow")
        if source_size > settings["max_image_bytes"]:
            raise VisionError("图片过大且未安装 Pillow，无法自动压缩；请先安装：python -m pip install Pillow")
        return source, source_mime

    try:
        with Image.open(source) as opened:
            image = ImageOps.exif_transpose(opened)
            width, height = image.size
            supported_original = bool(source_mime) and not (source.suffix.lower() == ".gif" and getattr(opened, "n_frames", 1) > 1)
            needs_resize = max(width, height) > settings["max_edge"]
            needs_convert = not supported_original or source_size > settings["max_image_bytes"] or needs_resize

            if not needs_convert:
                return source, source_mime

            image = image.convert("RGB")
            image.thumbnail((settings["max_edge"], settings["max_edge"]))
            target = temp_dir / "vision-upload.jpg"
            image.save(target, format="JPEG", quality=settings["jpeg_quality"], optimize=True)
            return target, "image/jpeg"
    except VisionError:
        raise
    except Exception as exc:
        raise VisionError(f"读取或压缩图片失败：{exc}") from exc


def to_data_url(path: Path, mime: str) -> str:
    encoded = base64.b64encode(path.read_bytes()).decode("ascii")
    return f"data:{mime};base64,{encoded}"


def extract_text(response: dict[str, Any]) -> str:
    try:
        content = response["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError) as exc:
        raise VisionError("视觉 API 返回中缺少 choices[0].message.content") from exc

    if isinstance(content, str):
        text = content.strip()
    elif isinstance(content, list):
        pieces = []
        for item in content:
            if isinstance(item, dict) and isinstance(item.get("text"), str):
                pieces.append(item["text"])
        text = "\n".join(pieces).strip()
    else:
        text = ""

    if not text:
        raise VisionError("视觉 API 返回了空内容")
    return text


def call_vision(settings: dict[str, Any], image_url: str, question: str) -> str:
    image_part: dict[str, Any] = {"url": image_url, "detail": settings["detail"]}
    payload = {
        "model": settings["model"],
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": question},
                    {"type": "image_url", "image_url": image_part},
                ],
            },
        ],
        "temperature": 0.2,
        "max_tokens": settings["max_output_tokens"],
    }

    request = urllib.request.Request(
        endpoint_from_base_url(settings["base_url"]),
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {settings['api_key']}",
            "Content-Type": "application/json",
            "User-Agent": "suzu-lives-image-vision/1.0",
        },
        method="POST",
    )

    try:
        with urllib.request.urlopen(request, timeout=settings["timeout_seconds"]) as response:
            parsed = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", errors="replace")
        try:
            parsed_error = json.loads(raw)
            message = parsed_error.get("error", {}).get("message") or raw
        except json.JSONDecodeError:
            message = raw or str(exc)
        raise VisionApiError(exc.code, str(message).strip()) from exc
    except urllib.error.URLError as exc:
        raise VisionError(f"连接视觉 API 失败：{exc.reason}") from exc
    except TimeoutError as exc:
        raise VisionError("视觉 API 请求超时") from exc
    except json.JSONDecodeError as exc:
        raise VisionError(f"视觉 API 返回的不是有效 JSON：{exc}") from exc

    if not isinstance(parsed, dict):
        raise VisionError("视觉 API 返回的 JSON 顶层不是对象")
    return extract_text(parsed)


def looks_like_refusal(text: str) -> bool:
    lowered = text.lower()
    return any(marker in lowered for marker in REFUSAL_MARKERS)


def looks_like_safety_error(error: VisionApiError) -> bool:
    lowered = error.message.lower()
    return error.status in {400, 403} and any(marker in lowered for marker in SAFETY_ERROR_MARKERS)


def inspect_image(settings: dict[str, Any], image_url: str, question: str, retry: bool) -> str:
    try:
        first = call_vision(settings, image_url, question)
    except VisionApiError as exc:
        if not retry or not looks_like_safety_error(exc):
            raise
        first = ""

    if first and not looks_like_refusal(first):
        return first
    if not retry:
        return first

    second = call_vision(settings, image_url, PORTRAIT_FALLBACK)
    if looks_like_refusal(second):
        raise VisionError("VISION_REFUSED：上游视觉模型仍拒绝读取这张图片")
    return second


def main() -> int:
    args = parse_args()
    question = (args.question or args.legacy_question or DEFAULT_QUESTION).strip()
    if not question:
        question = DEFAULT_QUESTION

    try:
        settings = load_settings(Path(args.config).expanduser().resolve())
        source = Path(args.image).expanduser().resolve()
        with tempfile.TemporaryDirectory(prefix="suzu-vision-") as temp:
            upload_path, mime = prepare_image(source, Path(temp), settings)
            image_url = to_data_url(upload_path, mime)
            retry = settings["retry_on_refusal"] and not args.no_retry
            result = inspect_image(settings, image_url, question, retry)
        print(result)
        return 0
    except VisionApiError as exc:
        print(f"VISION_ERROR：视觉 API 返回 HTTP {exc.status}：{exc.message}", file=sys.stderr)
        return 5
    except VisionError as exc:
        print(f"VISION_ERROR：{exc}", file=sys.stderr)
        return 4
    except Exception as exc:
        print(f"VISION_ERROR：未预期错误：{exc}", file=sys.stderr)
        return 10


if __name__ == "__main__":
    raise SystemExit(main())
