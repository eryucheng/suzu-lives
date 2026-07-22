#!/usr/bin/env python3
"""Shared helpers for the image-generation backends."""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any


class ImageGenerationError(RuntimeError):
    """A concise generation error safe to show to the calling Agent."""


def clean_text(value: Any) -> str:
    return str(value or "").strip()


def read_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise ImageGenerationError(f"找不到文件：{path}") from exc
    except json.JSONDecodeError as exc:
        raise ImageGenerationError(f"JSON 格式错误：{path}（{exc}）") from exc
    if not isinstance(value, dict):
        raise ImageGenerationError(f"JSON 顶层必须是对象：{path}")
    return value


def env_or_value(env_name: str, value: Any) -> str:
    from_env = clean_text(os.environ.get(env_name)) if env_name else ""
    return from_env or clean_text(value)


def resolve_relative(base_file: Path, value: str) -> Path:
    path = Path(value).expanduser()
    return path.resolve() if path.is_absolute() else (base_file.parent / path).resolve()
