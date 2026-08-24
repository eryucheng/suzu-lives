#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Software-owned image-vision worker.

Suzu's host-neutral capability CLI starts this worker and writes its usage
through Suzu Lives' ledger. It never reads an external directory or a
workspace-local configuration file.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
from pathlib import Path
import re
import sys
import tempfile
from typing import Any, Callable, Optional
import urllib.error
import urllib.parse
import urllib.request


if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")


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

DEFAULT_ADAPTER = "openai-chat-completions"
CUSTOM_ADAPTER = "custom-http-vision"
ADAPTER_ALIASES = {
    "openai": "openai-chat-completions",
    "openai-compatible": "openai-chat-completions",
    "anthropic": "anthropic-messages",
    "gemini": "gemini-generate-content",
    "dashscope": "dashscope-multimodal",
}
SUPPORTED_ADAPTERS = {
    "openai-chat-completions",
    "openai-responses",
    "anthropic-messages",
    "gemini-generate-content",
    "dashscope-multimodal",
    CUSTOM_ADAPTER,
}
CUSTOM_TEMPLATE = re.compile(r"\{\{(apiKey|detail|imageBase64|imageDataUrl|imageMimeType|model|question|systemPrompt)\}\}")
JSON_PATH = re.compile(r"^[A-Za-z_$][\w$]*(?:\[\d+\]|\.[A-Za-z_$][\w$]*)*$")


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
    parser.add_argument("--config", default="", help="Suzu Lives 数据目录中的图像理解配置路径")
    parser.add_argument("--data-root", required=True, help="Suzu Lives 软件数据目录")
    parser.add_argument("--no-retry", action="store_true", help="人物图片被拒时不做中性描述重试")
    parser.add_argument("--event-stream", action="store_true", help=argparse.SUPPRESS)
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


def clean(value: Any) -> str:
    return str(value or "").strip()


def normalized_adapter(value: Any) -> str:
    candidate = clean(value).lower()
    if candidate in SUPPORTED_ADAPTERS:
        return candidate
    return ADAPTER_ALIASES.get(candidate, DEFAULT_ADAPTER)


def required_http_url(value: Any, label: str) -> str:
    source = clean(value).rstrip("/")
    parsed = urllib.parse.urlparse(source)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise VisionError(f"{label}必须是 HTTP(S) 地址")
    return source


def append_endpoint(base_url: str, endpoint: str, accepted: tuple[str, ...] = ()) -> str:
    base = required_http_url(base_url, "视觉模型地址")
    pathname = urllib.parse.urlparse(base).path.rstrip("/")
    if any(pathname.endswith(suffix) for suffix in accepted):
        return base
    return base + endpoint


def compatible_openai_base_url(base_url: str) -> str:
    base = required_http_url(base_url, "视觉模型地址")
    parsed = urllib.parse.urlparse(base)
    if parsed.hostname and parsed.hostname.lower() == "dashscope.aliyuncs.com" and parsed.path.rstrip("/") == "/api/v1":
        return f"{parsed.scheme}://{parsed.netloc}/compatible-mode/v1"
    return base


def gemini_endpoint(base_url: str, model: str) -> str:
    base = required_http_url(base_url, "视觉模型地址")
    selected_model = clean(model)
    if not selected_model:
        raise VisionError("Gemini 模型不能为空")
    parsed = urllib.parse.urlparse(base)
    pathname = parsed.path.rstrip("/")
    if re.search(r":[^/]*generateContent$", pathname):
        return base
    quoted_model = urllib.parse.quote(selected_model, safe="")
    if pathname.endswith("/v1beta") or pathname.endswith("/v1"):
        return f"{base}/models/{quoted_model}:generateContent"
    return f"{base}/v1beta/models/{quoted_model}:generateContent"


def custom_adapter_path(data_root: Path) -> Path:
    return data_root / "capabilities" / "image-vision" / "custom-vision-adapters.json"


def custom_adapter_for(data_root: Path, adapter_id: Any) -> dict[str, Any]:
    identity = clean(adapter_id).lower()
    if not identity:
        raise VisionError("请先选择已保存的自定义视觉协议")
    path = custom_adapter_path(data_root)
    if path.is_symlink() or not path.is_file():
        raise VisionError("所选自定义视觉协议不可用")
    try:
        document = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError) as exc:
        raise VisionError("无法读取自定义视觉协议") from exc
    adapters = document.get("adapters") if isinstance(document, dict) else []
    for item in adapters if isinstance(adapters, list) else []:
        if isinstance(item, dict) and clean(item.get("id")).lower() == identity:
            base_url = required_http_url(item.get("baseUrl"), "自定义视觉协议服务地址")
            endpoint_path = clean(item.get("endpointPath"))
            response_path = clean(item.get("responseTextPath"))
            headers = item.get("requestHeaders")
            body = item.get("requestBody")
            if not endpoint_path.startswith("/") or endpoint_path.startswith("//") or "://" in endpoint_path:
                raise VisionError("自定义视觉协议的请求路径无效")
            if not JSON_PATH.fullmatch(response_path):
                raise VisionError("自定义视觉协议的文字返回位置无效")
            if not isinstance(headers, dict) or not isinstance(body, dict) or not body:
                raise VisionError("自定义视觉协议的请求配置无效")
            return {
                "id": identity,
                "name": clean(item.get("name")) or "自定义视觉服务",
                "base_url": base_url,
                "endpoint_path": endpoint_path,
                "request_headers": headers,
                "request_body": body,
                "response_text_path": response_path,
            }
    raise VisionError("所选自定义视觉协议不可用")


def load_settings(path: Path, data_root: Path) -> dict[str, Any]:
    raw = read_json(path)
    vision = raw.get("vision") if isinstance(raw.get("vision"), dict) else {}

    api_key = os.environ.get("VISION_API_KEY", "")
    base_url = os.environ.get("VISION_BASE_URL", "")
    model = os.environ.get("VISION_MODEL", "")
    adapter = normalized_adapter(vision.get("adapter"))
    custom_adapter = custom_adapter_for(data_root, vision.get("custom_adapter_id")) if adapter == CUSTOM_ADAPTER else None

    if not api_key:
        raise VisionError("没有 API Key；请在 设置 → API 为“理解图像”选择并配置 API")
    if adapter != CUSTOM_ADAPTER and not base_url:
        raise VisionError("没有 API 地址；请在 设置 → API 编辑“理解图像”所选连接")
    if adapter != CUSTOM_ADAPTER and not model:
        raise VisionError("没有模型；请在 设置 → API 编辑“理解图像”所选连接")

    detail = str(vision.get("detail", "auto")).lower()
    if detail not in {"auto", "low", "high"}:
        raise VisionError("vision.detail 只能是 auto、low 或 high")

    return {
        "api_key": str(api_key),
        "base_url": str(base_url),
        "model": str(model),
        "adapter": adapter,
        "custom_adapter": custom_adapter,
        "detail": detail,
        "timeout_seconds": as_int(vision.get("timeout_seconds"), 90),
        "max_output_tokens": as_int(vision.get("max_output_tokens"), 800),
        "max_image_bytes": as_int(vision.get("max_image_bytes"), 1_572_864),
        "max_edge": as_int(vision.get("max_edge"), 1600),
        "jpeg_quality": min(95, as_int(vision.get("jpeg_quality"), 90)),
        "retry_on_refusal": as_bool(vision.get("retry_on_refusal"), True),
    }


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


def text_from_value(value: Any) -> str:
    if isinstance(value, str):
        return value.strip()
    if isinstance(value, list):
        return "\n".join(piece for piece in (text_from_value(item) for item in value) if piece).strip()
    if isinstance(value, dict):
        text = value.get("text")
        if isinstance(text, str):
            return text.strip()
        content = value.get("content")
        if isinstance(content, str):
            return content.strip()
    return ""


def value_at_path(value: Any, raw_path: str) -> Any:
    if not JSON_PATH.fullmatch(raw_path):
        return None
    tokens = re.findall(r"[A-Za-z_$][\w$]*|\d+", raw_path)
    current = value
    for token in tokens:
        if token in {"__proto__", "prototype", "constructor"}:
            return None
        if isinstance(current, list):
            try:
                current = current[int(token)]
            except (ValueError, IndexError):
                return None
        elif isinstance(current, dict):
            if token not in current:
                return None
            current = current[token]
        else:
            return None
    return current


def extract_text(response: dict[str, Any], settings: dict[str, Any]) -> str:
    adapter = settings["adapter"]
    value: Any = None
    if adapter == "openai-chat-completions":
        value = value_at_path(response, "choices[0].message.content")
    elif adapter == "openai-responses":
        value = response.get("output_text")
        if not text_from_value(value):
            output = response.get("output")
            if isinstance(output, list):
                value = [item.get("content") for item in output if isinstance(item, dict)]
    elif adapter == "anthropic-messages":
        value = response.get("content")
    elif adapter == "gemini-generate-content":
        value = value_at_path(response, "candidates[0].content.parts")
    elif adapter == "dashscope-multimodal":
        value = value_at_path(response, "output.choices[0].message.content")
    elif adapter == CUSTOM_ADAPTER:
        custom = settings.get("custom_adapter") if isinstance(settings.get("custom_adapter"), dict) else {}
        value = value_at_path(response, str(custom.get("response_text_path") or ""))
    text = text_from_value(value)
    if not text:
        raise VisionError("视觉 API 返回中缺少可用文字内容")
    return text


def usage_event(settings: dict[str, Any], parsed: dict[str, Any]) -> dict[str, Any]:
    adapter = settings["adapter"]
    providers = {
        "openai-chat-completions": "OpenAI Compatible",
        "openai-responses": "OpenAI",
        "anthropic-messages": "Anthropic",
        "gemini-generate-content": "Google Gemini",
        "dashscope-multimodal": "阿里云百炼",
    }
    custom = settings.get("custom_adapter") if isinstance(settings.get("custom_adapter"), dict) else {}
    return {
        "provider": custom.get("name") if adapter == CUSTOM_ADAPTER and custom.get("name") else providers.get(adapter, "视觉模型"),
        "model": str(parsed.get("model") or settings["model"]),
        "source": "图片识别",
        "feature": "image-vision",
        "requestId": str(parsed.get("request_id") or parsed.get("id") or ""),
        "usage": parsed.get("usage") if isinstance(parsed.get("usage"), dict) else {},
        "metadata": {"adapter": adapter, "detail": settings["detail"]},
    }


def interpolate_template(value: Any, variables: dict[str, str]) -> Any:
    if isinstance(value, list):
        return [interpolate_template(item, variables) for item in value]
    if isinstance(value, dict):
        return {str(key): interpolate_template(item, variables) for key, item in value.items()}
    if not isinstance(value, str):
        return value
    return CUSTOM_TEMPLATE.sub(lambda match: variables.get(match.group(1), ""), value)


def request_configuration(settings: dict[str, Any], image_url: str, image_mime: str, question: str) -> tuple[str, dict[str, Any], dict[str, str]]:
    adapter = settings["adapter"]
    api_key = settings["api_key"]
    model = settings["model"]
    detail = settings["detail"]
    max_tokens = settings["max_output_tokens"]
    headers = {"Content-Type": "application/json", "User-Agent": "suzu-lives-image-vision/1.0"}
    image_base64 = image_url.split(",", 1)[1] if "," in image_url else ""
    if not image_base64:
        raise VisionError("图片数据无效")

    if adapter == "openai-chat-completions":
        headers["Authorization"] = f"Bearer {api_key}"
        return (
            append_endpoint(compatible_openai_base_url(settings["base_url"]), "/chat/completions", ("/chat/completions",)),
            {
                "model": model,
                "messages": [
                    {"role": "system", "content": SYSTEM_PROMPT},
                    {"role": "user", "content": [
                        {"type": "text", "text": question},
                        {"type": "image_url", "image_url": {"url": image_url, "detail": detail}},
                    ]},
                ],
                "temperature": 0.2,
                "max_tokens": max_tokens,
            },
            headers,
        )

    if adapter == "openai-responses":
        headers["Authorization"] = f"Bearer {api_key}"
        return (
            append_endpoint(settings["base_url"], "/responses", ("/responses",)),
            {
                "model": model,
                "instructions": SYSTEM_PROMPT,
                "input": [{"role": "user", "content": [
                    {"type": "input_text", "text": question},
                    {"type": "input_image", "image_url": image_url, "detail": detail},
                ]}],
                "max_output_tokens": max_tokens,
            },
            headers,
        )

    if adapter == "anthropic-messages":
        headers.update({"anthropic-version": "2023-06-01", "x-api-key": api_key})
        return (
            append_endpoint(settings["base_url"], "/messages", ("/messages",)),
            {
                "model": model,
                "max_tokens": max_tokens,
                "system": SYSTEM_PROMPT,
                "messages": [{"role": "user", "content": [
                    {"type": "text", "text": question},
                    {"type": "image", "source": {"type": "base64", "media_type": image_mime, "data": image_base64}},
                ]}],
            },
            headers,
        )

    if adapter == "gemini-generate-content":
        headers["x-goog-api-key"] = api_key
        return (
            gemini_endpoint(settings["base_url"], model),
            {
                "system_instruction": {"parts": [{"text": SYSTEM_PROMPT}]},
                "contents": [{"role": "user", "parts": [
                    {"text": question},
                    {"inline_data": {"mime_type": image_mime, "data": image_base64}},
                ]}],
                "generationConfig": {"maxOutputTokens": max_tokens},
            },
            headers,
        )

    if adapter == "dashscope-multimodal":
        headers["Authorization"] = f"Bearer {api_key}"
        return (
            append_endpoint(settings["base_url"], "/services/aigc/multimodal-generation/generation", ("/services/aigc/multimodal-generation/generation",)),
            {
                "model": model,
                "input": {"messages": [
                    {"role": "system", "content": [{"text": SYSTEM_PROMPT}]},
                    {"role": "user", "content": [{"image": image_url}, {"text": question}]},
                ]},
                "parameters": {"max_tokens": max_tokens},
            },
            headers,
        )

    custom = settings.get("custom_adapter") if isinstance(settings.get("custom_adapter"), dict) else {}
    variables = {
        "apiKey": api_key,
        "detail": detail,
        "imageBase64": image_base64,
        "imageDataUrl": image_url,
        "imageMimeType": image_mime,
        "model": model,
        "question": question,
        "systemPrompt": SYSTEM_PROMPT,
    }
    custom_headers = interpolate_template(custom.get("request_headers"), variables)
    if not isinstance(custom_headers, dict):
        raise VisionError("自定义视觉协议 Headers 无效")
    for name, value in custom_headers.items():
        header_name = str(name).strip()
        header_value = str(value).strip()
        if not header_name or "\r" in header_name or "\n" in header_name or "\r" in header_value or "\n" in header_value:
            raise VisionError("自定义视觉协议 Headers 无效")
        headers[header_name] = header_value
    base_url = required_http_url(custom.get("base_url"), "自定义视觉协议服务地址")
    endpoint_path = str(custom.get("endpoint_path") or "")
    return base_url + endpoint_path, interpolate_template(custom.get("request_body"), variables), headers


def call_vision(
    settings: dict[str, Any],
    image_url: str,
    image_mime: str,
    question: str,
    on_usage: Optional[Callable[[dict[str, Any]], None]] = None,
) -> str:
    endpoint, payload, headers = request_configuration(settings, image_url, image_mime, question)

    request = urllib.request.Request(
        endpoint,
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers=headers,
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
    if on_usage:
        on_usage(usage_event(settings, parsed))
    return extract_text(parsed, settings)


def looks_like_refusal(text: str) -> bool:
    lowered = text.lower()
    return any(marker in lowered for marker in REFUSAL_MARKERS)


def looks_like_safety_error(error: VisionApiError) -> bool:
    lowered = error.message.lower()
    return error.status in {400, 403} and any(marker in lowered for marker in SAFETY_ERROR_MARKERS)


def inspect_image(
    settings: dict[str, Any],
    image_url: str,
    image_mime: str,
    question: str,
    retry: bool,
    on_usage: Optional[Callable[[dict[str, Any]], None]] = None,
) -> str:
    try:
        first = call_vision(settings, image_url, image_mime, question, on_usage)
    except VisionApiError as exc:
        if not retry or not looks_like_safety_error(exc):
            raise
        first = ""

    if first and not looks_like_refusal(first):
        return first
    if not retry:
        return first

    second = call_vision(settings, image_url, image_mime, PORTRAIT_FALLBACK, on_usage)
    if looks_like_refusal(second):
        raise VisionError("VISION_REFUSED：上游视觉模型仍拒绝读取这张图片")
    return second


def default_config_path(data_root: Path) -> Path:
    return data_root / "capabilities" / "image-vision" / "config.json"


def runtime_temp_dir(data_root: Path) -> Path:
    destination = data_root / "capabilities" / "image-vision" / "runtime"
    destination.mkdir(parents=True, exist_ok=True)
    return destination


def emit_event(value: dict[str, Any]) -> None:
    print(json.dumps(value, ensure_ascii=False), flush=True)


def main() -> int:
    args = parse_args()
    question = (args.question or DEFAULT_QUESTION).strip()
    if not question:
        question = DEFAULT_QUESTION

    try:
        data_root = Path(args.data_root).expanduser().resolve()
        config_path = Path(args.config).expanduser().resolve() if args.config else default_config_path(data_root)
        settings = load_settings(config_path, data_root)
        source = Path(args.image).expanduser().resolve()
        with tempfile.TemporaryDirectory(prefix="suzu-vision-", dir=runtime_temp_dir(data_root)) as temp:
            upload_path, mime = prepare_image(source, Path(temp), settings)
            image_url = to_data_url(upload_path, mime)
            retry = settings["retry_on_refusal"] and not args.no_retry
            on_usage = (lambda event: emit_event({"type": "usage", "event": event})) if args.event_stream else None
            result = inspect_image(settings, image_url, mime, question, retry, on_usage)
        if args.event_stream:
            emit_event({"type": "result", "answer": result})
        else:
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
