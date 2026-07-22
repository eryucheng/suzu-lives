#!/usr/bin/env python3
"""OpenAI Images-compatible generation and edit backend."""

from __future__ import annotations

import base64
import json
import urllib.error
import urllib.request
import uuid
from pathlib import Path
from typing import Any

from image_common import ImageGenerationError, clean_text, env_or_value, read_json, resolve_relative


def endpoint_url(base_url: str, endpoint: str) -> str:
    if endpoint.startswith(("http://", "https://")):
        return endpoint
    return f"{base_url.rstrip('/')}/{endpoint.lstrip('/')}"


def settings(config: dict[str, Any], config_path: Path) -> dict[str, Any]:
    shared: dict[str, Any] = {}
    credentials_file = clean_text(config.get("credentials_file"))
    if credentials_file:
        shared_config = read_json(resolve_relative(config_path, credentials_file))
        candidate = shared_config.get("openai", shared_config.get("api", shared_config))
        if isinstance(candidate, dict):
            shared = candidate

    key_env = clean_text(config.get("api_key_env")) or "IMAGE_API_KEY"
    base_env = clean_text(config.get("base_url_env")) or "IMAGE_BASE_URL"
    model_env = clean_text(config.get("model_env")) or "IMAGE_MODEL"
    configured_key = clean_text(config.get("api_key"))
    configured_base = clean_text(config.get("base_url"))
    if configured_key.lower() == "your-api-key":
        configured_key = ""
    if configured_base.lower() == "https://example.com/v1":
        configured_base = ""
    api_key = env_or_value(key_env, configured_key or shared.get("api_key"))
    base_url = env_or_value(base_env, configured_base or shared.get("base_url"))
    model = env_or_value(model_env, config.get("model"))
    placeholders = {"your-api-key", "your-image-model", "https://example.com/v1"}
    if not api_key or api_key.lower() in placeholders:
        raise ImageGenerationError(f"请在图像生成配置或环境变量 {key_env} 中填写 API Key")
    if not base_url or base_url.lower() in placeholders:
        raise ImageGenerationError(f"请在图像生成配置或环境变量 {base_env} 中填写 API 地址")
    if not model or model.lower() in placeholders:
        raise ImageGenerationError(f"请在图像生成配置或环境变量 {model_env} 中填写模型名")

    try:
        timeout = int(config.get("timeout_seconds", 180))
    except (TypeError, ValueError) as exc:
        raise ImageGenerationError("api.timeout_seconds 必须是整数") from exc
    if timeout < 1:
        raise ImageGenerationError("api.timeout_seconds 必须大于 0")
    generation_extra = config.get("extra_body", {})
    edit_extra = config.get("edit_extra_body", {})
    if not isinstance(generation_extra, dict) or not isinstance(edit_extra, dict):
        raise ImageGenerationError("api.extra_body 和 api.edit_extra_body 必须是对象")
    return {
        "api_key": api_key,
        "base_url": base_url.rstrip("/"),
        "model": model,
        "timeout": timeout,
        "quality": clean_text(config.get("quality")),
        "output_format": clean_text(config.get("output_format")),
        "input_fidelity": clean_text(config.get("input_fidelity")),
        "generation_endpoint": clean_text(config.get("generation_endpoint"))
        or "/images/generations",
        "edit_endpoint": clean_text(config.get("edit_endpoint")) or "/images/edits",
        "generation_extra": generation_extra,
        "edit_extra": edit_extra,
    }


def parse_http_error(exc: urllib.error.HTTPError) -> str:
    try:
        raw = exc.read().decode("utf-8", errors="replace")
    except Exception:
        return f"HTTP {exc.code} {exc.reason}"
    try:
        payload = json.loads(raw)
        error = payload.get("error", payload) if isinstance(payload, dict) else payload
        if isinstance(error, dict) and clean_text(error.get("message")):
            return f"HTTP {exc.code}: {clean_text(error.get('message'))}"
    except json.JSONDecodeError:
        pass
    return f"HTTP {exc.code}: {' '.join(raw.split())[:500] or exc.reason}"


def request_json(request: urllib.request.Request, timeout: int) -> dict[str, Any]:
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        raise ImageGenerationError(parse_http_error(exc)) from exc
    except urllib.error.URLError as exc:
        raise ImageGenerationError(f"连接图像 API 失败：{exc.reason}") from exc
    except TimeoutError as exc:
        raise ImageGenerationError("图像 API 请求超时") from exc
    except json.JSONDecodeError as exc:
        raise ImageGenerationError(f"图像 API 返回的不是有效 JSON：{exc}") from exc
    if not isinstance(payload, dict):
        raise ImageGenerationError("图像 API 返回格式不正确")
    return payload


def image_mime(path: Path) -> str:
    return {
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".webp": "image/webp",
    }.get(path.suffix.lower(), "application/octet-stream")


def multipart_value(value: Any) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (dict, list)):
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    return str(value)


def multipart_body(fields: dict[str, Any], references: list[dict[str, Any]]) -> tuple[bytes, str]:
    boundary = f"----suzu-lives-{uuid.uuid4().hex}"
    chunks: list[bytes] = []

    def line(value: str = "") -> None:
        chunks.extend((value.encode("utf-8"), b"\r\n"))

    for name, value in fields.items():
        if value is None or value == "":
            continue
        line(f"--{boundary}")
        line(f'Content-Disposition: form-data; name="{name}"')
        line()
        line(multipart_value(value))
    for item in references:
        path = Path(item["absolute_path"])
        line(f"--{boundary}")
        line(f'Content-Disposition: form-data; name="image[]"; filename="{path.name}"')
        line(f"Content-Type: {image_mime(path)}")
        line()
        chunks.extend((path.read_bytes(), b"\r\n"))
    line(f"--{boundary}--")
    return b"".join(chunks), boundary


def decode_result(payload: dict[str, Any], timeout: int) -> tuple[bytes, dict[str, Any]]:
    data = payload.get("data")
    if not isinstance(data, list) or not data or not isinstance(data[0], dict):
        raise ImageGenerationError("图像 API 没有返回 data[0]")
    item = data[0]
    encoded = clean_text(item.get("b64_json") or item.get("b64") or item.get("image_base64"))
    url = clean_text(item.get("url"))
    metadata: dict[str, Any] = {}
    if clean_text(item.get("revised_prompt")):
        metadata["revised_prompt"] = clean_text(item.get("revised_prompt"))
    if encoded:
        try:
            return base64.b64decode(encoded, validate=True), metadata
        except (ValueError, TypeError) as exc:
            raise ImageGenerationError("图像 API 返回了无效的 Base64 图片") from exc
    if not url:
        raise ImageGenerationError("图像 API 返回项既没有 b64_json 也没有 url")
    try:
        request = urllib.request.Request(url, headers={"User-Agent": "suzu-lives-image/1.0"})
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.read(), metadata
    except urllib.error.HTTPError as exc:
        raise ImageGenerationError(f"下载生成图片失败：HTTP {exc.code}") from exc
    except urllib.error.URLError as exc:
        raise ImageGenerationError(f"下载生成图片失败：{exc.reason}") from exc


def generate(
    config: dict[str, Any],
    config_path: Path,
    *,
    prompt: str,
    size: str,
    references: list[dict[str, Any]],
) -> tuple[bytes, dict[str, Any]]:
    current = settings(config, config_path)
    fields: dict[str, Any] = {
        "model": current["model"],
        "prompt": prompt,
        "n": 1,
        "size": size,
    }
    if current["quality"]:
        fields["quality"] = current["quality"]
    if current["output_format"]:
        fields["output_format"] = current["output_format"]
    headers = {
        "Authorization": f"Bearer {current['api_key']}",
        "Accept": "application/json",
        "User-Agent": "suzu-lives-image/1.0",
    }
    if references:
        body_fields = dict(current["edit_extra"])
        body_fields.update(fields)
        if current["input_fidelity"]:
            body_fields["input_fidelity"] = current["input_fidelity"]
        body, boundary = multipart_body(body_fields, references)
        headers["Content-Type"] = f"multipart/form-data; boundary={boundary}"
        endpoint = current["edit_endpoint"]
        mode = "edit"
    else:
        body_fields = dict(current["generation_extra"])
        body_fields.update(fields)
        body = json.dumps(body_fields, ensure_ascii=False).encode("utf-8")
        headers["Content-Type"] = "application/json"
        endpoint = current["generation_endpoint"]
        mode = "generation"
    request = urllib.request.Request(
        endpoint_url(current["base_url"], endpoint), data=body, headers=headers, method="POST"
    )
    image, metadata = decode_result(request_json(request, current["timeout"]), current["timeout"])
    metadata.update({"mode": mode, "model": current["model"]})
    return image, metadata
