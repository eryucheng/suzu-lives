#!/usr/bin/env python3
"""Backend-neutral image generation engine."""

from __future__ import annotations

import subprocess
import time
from pathlib import Path
from typing import Any

from backends import comfyui, openai_images
from image_common import ImageGenerationError, clean_text, env_or_value, read_json


SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_DIR = SCRIPT_DIR.parents[2]
DEFAULT_CONFIG = SCRIPT_DIR / "config.local.json"
EXAMPLE_CONFIG = SCRIPT_DIR / "config.example.json"


def load_config(config_path: Path) -> dict[str, Any]:
    if config_path.exists():
        return read_json(config_path)
    if config_path == DEFAULT_CONFIG and EXAMPLE_CONFIG.exists():
        return read_json(EXAMPLE_CONFIG)
    raise ImageGenerationError(f"找不到图像生成配置：{config_path}")


def select_backend(config: dict[str, Any], override: str = "") -> str:
    selected = clean_text(override) or clean_text(config.get("default_backend")) or "api"
    if selected not in {"api", "comfyui"}:
        raise ImageGenerationError(f"未知图像生成后端：{selected}")
    return selected


def project_path(value: str) -> Path:
    path = Path(value).expanduser()
    return path.resolve() if path.is_absolute() else (PROJECT_DIR / path).resolve()


def image_extension(data: bytes) -> str:
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return ".png"
    if data.startswith(b"\xff\xd8\xff"):
        return ".jpg"
    if data.startswith(b"RIFF") and data[8:12] == b"WEBP":
        return ".webp"
    return ".png"


def save_image(data: bytes, output_dir: Path, prefix: str) -> Path:
    if not data:
        raise ImageGenerationError("生成图片为空")
    try:
        output_dir.mkdir(parents=True, exist_ok=True)
        stamp = time.strftime("%Y%m%d-%H%M%S")
        millis = int(time.time() * 1000) % 1000
        path = output_dir / f"{prefix}-{stamp}-{millis:03d}{image_extension(data)}"
        path.write_bytes(data)
        return path.resolve()
    except OSError as exc:
        raise ImageGenerationError(f"无法保存生成图片到 {output_dir}：{exc}") from exc


def delivery_settings(config: dict[str, Any]) -> tuple[str, str]:
    delivery = config.get("delivery")
    if not isinstance(delivery, dict):
        raise ImageGenerationError("使用 --send 前请在图像生成配置中添加 delivery 对象")
    command = clean_text(delivery.get("command")) or "cc-connect"
    env_name = clean_text(delivery.get("session_key_env")) or "CC_CONNECT_SESSION_KEY"
    session_key = env_or_value(env_name, delivery.get("session_key"))
    if not session_key:
        raise ImageGenerationError(f"使用 --send 前请填写 delivery.session_key 或环境变量 {env_name}")
    return command, session_key


def send_image(path: Path, command: str, session_key: str) -> None:
    try:
        result = subprocess.run(
            [command, "send", "--image", str(path), "-s", session_key],
            capture_output=True,
            text=True,
            timeout=60,
            check=False,
        )
    except FileNotFoundError as exc:
        raise ImageGenerationError(f"找不到发送命令：{command}") from exc
    except subprocess.TimeoutExpired as exc:
        raise ImageGenerationError("cc-connect 发送图片超时") from exc
    if result.returncode != 0:
        detail = clean_text(result.stderr) or clean_text(result.stdout) or str(result.returncode)
        raise ImageGenerationError(f"cc-connect 发送失败：{detail[:500]}")


def generate_image(
    *,
    prompt: str,
    config_path: Path = DEFAULT_CONFIG,
    backend: str = "",
    workflow: str = "",
    size: str = "1024x1024",
    seed: int | None = None,
    references: list[dict[str, Any]] | None = None,
    output_dir: str = "",
    output_prefix: str = "image",
    send: bool = False,
) -> dict[str, Any]:
    prompt = clean_text(prompt)
    if not prompt:
        raise ImageGenerationError("prompt 不能为空")
    resolved_config = config_path.expanduser().resolve()
    config = load_config(resolved_config)
    selected = select_backend(config, backend)
    refs = references or []
    for item in refs:
        path = Path(item.get("absolute_path", "")).expanduser().resolve()
        if not path.is_file():
            raise ImageGenerationError(f"参考图不存在：{path}")
        item["absolute_path"] = path
    if selected == "api":
        api = config.get("api")
        if not isinstance(api, dict):
            raise ImageGenerationError("图像生成配置缺少 api 对象")
        image, metadata = openai_images.generate(
            api, resolved_config, prompt=prompt, size=size, references=refs
        )
    else:
        comfy = config.get("comfyui")
        if not isinstance(comfy, dict):
            raise ImageGenerationError("图像生成配置缺少 comfyui 对象")
        image, metadata = comfyui.generate(
            comfy,
            resolved_config,
            prompt=prompt,
            size=size,
            seed=seed,
            workflow_name=workflow,
            references=refs,
        )
    output = config.get("output", {})
    configured_output = clean_text(output.get("directory")) if isinstance(output, dict) else ""
    directory = project_path(output_dir or configured_output or "output/image-generation")
    path = save_image(image, directory, output_prefix)
    sent = False
    if send:
        command, session_key = delivery_settings(config)
        send_image(path, command, session_key)
        sent = True
    return {
        "status": "ok",
        "backend": selected,
        "path": str(path),
        "sent": sent,
        **metadata,
    }


def list_comfy_workflows(config_path: Path = DEFAULT_CONFIG) -> dict[str, Any]:
    resolved = config_path.expanduser().resolve()
    config = load_config(resolved)
    comfy = config.get("comfyui")
    if not isinstance(comfy, dict):
        raise ImageGenerationError("图像生成配置缺少 comfyui 对象")
    return comfyui.list_workflows(comfy, resolved)


def validate_comfy_workflows(config_path: Path = DEFAULT_CONFIG) -> dict[str, Any]:
    resolved = config_path.expanduser().resolve()
    config = load_config(resolved)
    comfy = config.get("comfyui")
    if not isinstance(comfy, dict):
        raise ImageGenerationError("图像生成配置缺少 comfyui 对象")
    return comfyui.validate_workflows(comfy, resolved)
