#!/usr/bin/env python3
"""Shared validation and lookup helpers for the visual reference library."""

from __future__ import annotations

import json
import re
from pathlib import Path, PurePosixPath
from typing import Any


ID_PATTERN = re.compile(r"^[a-z0-9]+(?:[.-][a-z0-9]+)*$")
SUPPORTED_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp"}
ROLE_DIRECTORIES = {
    "identity": "characters",
    "location": "places",
    "object": "objects",
    "style": "styles",
}
MAX_API_REFERENCES = 16
MAX_REFERENCE_BYTES = 50 * 1024 * 1024


class ReferenceLibraryError(RuntimeError):
    """A concise reference-library error safe to show to the Agent."""


def clean_text(value: Any) -> str:
    return str(value or "").strip()


def read_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise ReferenceLibraryError(f"找不到文件：{path}") from exc
    except json.JSONDecodeError as exc:
        raise ReferenceLibraryError(f"JSON 格式错误：{path}（{exc}）") from exc
    if not isinstance(value, dict):
        raise ReferenceLibraryError(f"JSON 顶层必须是对象：{path}")
    return value


def empty_manifest() -> dict[str, Any]:
    return {"version": 1, "assets": {}, "sets": {}}


def validate_id(value: Any, label: str) -> str:
    item_id = clean_text(value)
    if not ID_PATTERN.fullmatch(item_id):
        raise ReferenceLibraryError(
            f"{label} 必须由小写字母、数字、点和连字符组成，且不能连续使用分隔符：{item_id or '<empty>'}"
        )
    return item_id


def validate_string_list(value: Any, label: str) -> list[str]:
    if value is None:
        return []
    if not isinstance(value, list):
        raise ReferenceLibraryError(f"{label} 必须是字符串数组")
    result = []
    for index, item in enumerate(value):
        text = clean_text(item)
        if not text:
            raise ReferenceLibraryError(f"{label}[{index}] 不能为空")
        result.append(text)
    return result


def safe_asset_path(root: Path, relative_value: Any) -> Path:
    raw = clean_text(relative_value).replace("\\", "/")
    pure = PurePosixPath(raw)
    if not raw or pure.is_absolute() or ".." in pure.parts:
        raise ReferenceLibraryError(f"参考图路径必须位于视觉参考库内：{raw or '<empty>'}")
    candidate = (root / Path(*pure.parts)).resolve()
    try:
        candidate.relative_to(root.resolve())
    except ValueError as exc:
        raise ReferenceLibraryError(f"参考图路径越出视觉参考库：{raw}") from exc
    if candidate.suffix.lower() not in SUPPORTED_EXTENSIONS:
        raise ReferenceLibraryError(f"不支持的参考图格式：{raw}")
    return candidate


def relative_asset_path(asset_id: str, role: str, suffix: str) -> str:
    validated_id = validate_id(asset_id, "asset id")
    if role not in ROLE_DIRECTORIES:
        raise ReferenceLibraryError(f"未知 role：{role}")
    normalized_suffix = suffix.lower()
    if normalized_suffix not in SUPPORTED_EXTENSIONS:
        raise ReferenceLibraryError(f"不支持的参考图格式：{suffix}")
    parts = validated_id.split(".")
    return PurePosixPath(ROLE_DIRECTORIES[role], *parts[:-1], f"{parts[-1]}{normalized_suffix}").as_posix()


def validate_manifest(
    manifest: dict[str, Any],
    manifest_path: Path,
    *,
    require_files: bool = True,
    allowed_missing: set[str] | None = None,
) -> dict[str, Any]:
    if manifest.get("version") != 1:
        raise ReferenceLibraryError("manifest.version 必须是 1")
    assets = manifest.get("assets")
    sets = manifest.get("sets")
    if not isinstance(assets, dict):
        raise ReferenceLibraryError("manifest.assets 必须是对象")
    if not isinstance(sets, dict):
        raise ReferenceLibraryError("manifest.sets 必须是对象")

    root = manifest_path.parent.resolve()
    missing = allowed_missing or set()
    seen_paths: dict[str, str] = {}
    normalized_assets: dict[str, dict[str, Any]] = {}

    for raw_id, raw_asset in assets.items():
        asset_id = validate_id(raw_id, "asset id")
        if not isinstance(raw_asset, dict):
            raise ReferenceLibraryError(f"assets.{asset_id} 必须是对象")
        role = clean_text(raw_asset.get("role"))
        if role not in ROLE_DIRECTORIES:
            raise ReferenceLibraryError(
                f"assets.{asset_id}.role 必须是 identity、location、object 或 style"
            )
        description = clean_text(raw_asset.get("description"))
        if not description:
            raise ReferenceLibraryError(f"assets.{asset_id}.description 不能为空")
        preserve = validate_string_list(raw_asset.get("preserve"), f"assets.{asset_id}.preserve")
        ignore = validate_string_list(raw_asset.get("ignore"), f"assets.{asset_id}.ignore")
        relative = clean_text(raw_asset.get("path")).replace("\\", "/")
        image_path = safe_asset_path(root, relative)
        key = str(image_path).lower()
        if key in seen_paths:
            raise ReferenceLibraryError(
                f"assets.{asset_id} 与 assets.{seen_paths[key]} 使用了同一文件：{relative}"
            )
        seen_paths[key] = asset_id
        if require_files and relative not in missing:
            if not image_path.is_file():
                raise ReferenceLibraryError(f"参考图不存在：{relative}")
            if image_path.stat().st_size > MAX_REFERENCE_BYTES:
                raise ReferenceLibraryError(f"参考图超过 50MB：{relative}")
        normalized_assets[asset_id] = {
            "path": relative,
            "role": role,
            "description": description,
            "preserve": preserve,
            "ignore": ignore,
        }

    normalized_sets: dict[str, dict[str, Any]] = {}
    for raw_id, raw_set in sets.items():
        set_id = validate_id(raw_id, "set id")
        if set_id in normalized_assets:
            raise ReferenceLibraryError(f"set id 与 asset id 不能同名：{set_id}")
        if not isinstance(raw_set, dict):
            raise ReferenceLibraryError(f"sets.{set_id} 必须是对象")
        description = clean_text(raw_set.get("description"))
        if not description:
            raise ReferenceLibraryError(f"sets.{set_id}.description 不能为空")
        members = raw_set.get("assets")
        if not isinstance(members, list):
            raise ReferenceLibraryError(f"sets.{set_id}.assets 必须是数组")
        normalized_members = []
        seen_members = set()
        for index, member in enumerate(members):
            member_id = validate_id(member, f"sets.{set_id}.assets[{index}]")
            if member_id not in normalized_assets:
                raise ReferenceLibraryError(f"sets.{set_id} 引用了不存在的 asset：{member_id}")
            if member_id not in seen_members:
                seen_members.add(member_id)
                normalized_members.append(member_id)
        normalized_sets[set_id] = {"description": description, "assets": normalized_members}

    return {"version": 1, "assets": normalized_assets, "sets": normalized_sets}


def load_manifest(manifest_path: Path, *, require_files: bool = True) -> dict[str, Any]:
    return validate_manifest(read_json(manifest_path), manifest_path, require_files=require_files)


def expand_references(
    requested: list[str], manifest_path: Path, *, max_images: int = 8
) -> list[dict[str, Any]]:
    if not requested:
        return []
    manifest = load_manifest(manifest_path, require_files=True)
    assets = manifest["assets"]
    sets = manifest["sets"]
    selected_ids: list[str] = []
    seen = set()

    for raw_name in requested:
        name = validate_id(raw_name, "--ref")
        if name in assets:
            candidates = [name]
        elif name in sets:
            candidates = sets[name]["assets"]
        else:
            raise ReferenceLibraryError(f"找不到参考 asset 或 set：{name}")
        for asset_id in candidates:
            if asset_id not in seen:
                seen.add(asset_id)
                selected_ids.append(asset_id)

    effective_limit = min(max(1, int(max_images)), MAX_API_REFERENCES)
    if len(selected_ids) > effective_limit:
        raise ReferenceLibraryError(
            f"本次展开出 {len(selected_ids)} 张参考图，超过配置上限 {effective_limit}；请只选择当前场景需要的参考组"
        )

    root = manifest_path.parent.resolve()
    selected = []
    for index, asset_id in enumerate(selected_ids, start=1):
        asset = dict(assets[asset_id])
        asset["id"] = asset_id
        asset["index"] = index
        asset["absolute_path"] = safe_asset_path(root, asset["path"])
        selected.append(asset)
    return selected


def reference_prompt(references: list[dict[str, Any]]) -> str:
    blocks = []
    for item in references:
        lines = [
            f"Image {item['index']}",
            f"ID: {item['id']}",
            f"Role: {item['role']} reference",
            f"Description: {item['description']}",
        ]
        if item.get("preserve"):
            lines.append(f"Preserve: {'; '.join(item['preserve'])}")
        if item.get("ignore"):
            lines.append(f"Do not inherit: {'; '.join(item['ignore'])}")
        blocks.append("\n".join(lines))
    return "Reference images are ordered exactly as uploaded. Use each image only for its stated role.\n\n" + "\n\n".join(blocks)
