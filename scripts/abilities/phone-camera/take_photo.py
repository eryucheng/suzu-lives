#!/usr/bin/env python3
"""Generate one smartphone-style photo through the shared image engine."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any


SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_DIR = SCRIPT_DIR.parents[2]
ENGINE_DIR = SCRIPT_DIR.parent / "image-generation"
if str(ENGINE_DIR) not in sys.path:
    sys.path.insert(0, str(ENGINE_DIR))

from image_common import ImageGenerationError, clean_text, read_json, resolve_relative
from image_engine import generate_image, load_config as load_engine_config, select_backend
from reference_library import (
    MAX_API_REFERENCES,
    ReferenceLibraryError,
    expand_references,
    reference_prompt,
)


DEFAULT_CONFIG = SCRIPT_DIR / "config.local.json"
EXAMPLE_CONFIG = SCRIPT_DIR / "config.example.json"
PROFILES_PATH = SCRIPT_DIR / "profiles.json"
DEFAULT_MANIFEST = PROJECT_DIR / "visual-references" / "manifest.json"


def load_phone_config(config_path: Path) -> dict[str, Any]:
    if config_path.exists():
        return read_json(config_path)
    if config_path == DEFAULT_CONFIG and EXAMPLE_CONFIG.exists():
        return read_json(EXAMPLE_CONFIG)
    raise ImageGenerationError(f"找不到手机拍照配置：{config_path}")


def resolve_project_path(value: str) -> Path:
    path = Path(value).expanduser()
    return path.resolve() if path.is_absolute() else (PROJECT_DIR / path).resolve()


def engine_config_path(config: dict[str, Any], phone_config_path: Path) -> Path:
    configured = clean_text(config.get("engine_config"))
    if configured:
        return resolve_relative(phone_config_path, configured)
    # Backward compatibility for the first phone-camera release, whose API settings
    # lived directly inside phone-camera/config.local.json.
    return phone_config_path


def load_profiles() -> dict[str, Any]:
    profiles = read_json(PROFILES_PATH)
    shots = profiles.get("shots")
    if not isinstance(shots, dict) or not shots:
        raise ImageGenerationError("profiles.json 缺少 shots")
    return profiles


def build_prompt(
    scene: str,
    shot_name: str,
    profiles: dict[str, Any],
    config: dict[str, Any],
    references: list[dict[str, Any]],
) -> str:
    shot = profiles["shots"].get(shot_name)
    if not isinstance(shot, dict):
        raise ImageGenerationError(f"未知拍摄方式：{shot_name}")
    shared = profiles.get("shared", {})
    if not isinstance(shared, dict):
        raise ImageGenerationError("profiles.json 的 shared 必须是对象")
    sections = [("Goal", clean_text(shared.get("goal"))), ("Visible scene", scene)]
    if references:
        sections.append(("Reference image roles", reference_prompt(references)))
    sections.extend(
        [
            ("Shot and framing", clean_text(shot.get("shot"))),
            ("Camera geometry", clean_text(shot.get("geometry"))),
            (
                "Natural phone-camera look",
                " ".join(
                    part
                    for part in (clean_text(shared.get("look")), clean_text(shot.get("look")))
                    if part
                ),
            ),
            (
                "Hard constraints",
                " ".join(
                    part
                    for part in (
                        clean_text(shared.get("constraints")),
                        clean_text(shot.get("constraints")),
                    )
                    if part
                ),
            ),
        ]
    )
    prompt = "\n\n".join(f"{title}:\n{text}" for title, text in sections if text)
    prompt_config = config.get("prompt", {})
    if isinstance(prompt_config, dict):
        prefix = clean_text(prompt_config.get("prefix"))
        suffix = clean_text(prompt_config.get("suffix"))
        if prefix:
            prompt = f"{prefix}\n\n{prompt}"
        if suffix:
            prompt = f"{prompt}\n\n{suffix}"
    return prompt


def default_size(shot_name: str, profiles: dict[str, Any], config: dict[str, Any]) -> str:
    by_shot = config.get("size_by_shot", {})
    if not isinstance(by_shot, dict):
        by_shot = {}
    # Backward compatibility with the old combined API/phone config.
    legacy_api = config.get("api", {})
    if not by_shot and isinstance(legacy_api, dict):
        candidate = legacy_api.get("size_by_shot", {})
        if isinstance(candidate, dict):
            by_shot = candidate
    configured = clean_text(by_shot.get(shot_name))
    if configured:
        return configured
    shot = profiles["shots"].get(shot_name, {})
    return clean_text(shot.get("default_size")) or "1024x1024"


def reference_settings(
    config: dict[str, Any], manifest_override: Path | None
) -> tuple[Path, int]:
    raw = config.get("references", {})
    if raw is not None and not isinstance(raw, dict):
        raise ImageGenerationError("手机拍照配置的 references 必须是对象")
    settings = raw or {}
    if manifest_override:
        manifest = manifest_override.expanduser().resolve()
    else:
        configured = clean_text(settings.get("manifest"))
        manifest = resolve_project_path(configured) if configured else DEFAULT_MANIFEST
    try:
        max_images = int(settings.get("max_images", 8))
    except (TypeError, ValueError) as exc:
        raise ImageGenerationError("references.max_images 必须是整数") from exc
    if max_images < 1 or max_images > MAX_API_REFERENCES:
        raise ImageGenerationError(f"references.max_images 必须在 1 到 {MAX_API_REFERENCES} 之间")
    return manifest, max_images


def output_directory(config: dict[str, Any], override: str) -> str:
    if override:
        return override
    output = config.get("output", {})
    if isinstance(output, dict) and clean_text(output.get("directory")):
        return clean_text(output.get("directory"))
    return "output/phone-camera"


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="生成一张符合真实手机拍摄视角的图片")
    parser.add_argument("--shot", required=True, choices=("rear", "selfie", "mirror"))
    parser.add_argument("--scene", required=True, help="画面中实际可见的场景、人物动作和环境")
    parser.add_argument("--ref", action="append", default=[], help="参考 asset 或 set ID，可重复")
    parser.add_argument("--manifest", type=Path, help="临时覆盖视觉参考 manifest")
    parser.add_argument("--backend", choices=("api", "comfyui"), help="默认使用 API")
    parser.add_argument("--workflow", help="明确使用 ComfyUI 时指定已注册工作流")
    parser.add_argument("--send", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--size", help="临时覆盖尺寸")
    parser.add_argument("--seed", type=int, help="需要复现本地结果时才指定")
    parser.add_argument("--out", help="临时覆盖输出目录")
    parser.add_argument("--config", type=Path, default=DEFAULT_CONFIG)
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv or sys.argv[1:])
    scene = clean_text(args.scene)
    if not scene:
        raise ImageGenerationError("--scene 不能为空")
    if len(scene) > 5000:
        raise ImageGenerationError("--scene 过长，请只写画面中真正可见的内容")
    phone_config_path = args.config.expanduser().resolve()
    config = load_phone_config(phone_config_path)
    engine_path = engine_config_path(config, phone_config_path)
    engine_config = load_engine_config(engine_path)
    backend = select_backend(engine_config, args.backend or "")
    profiles = load_profiles()
    manifest_path, max_images = reference_settings(config, args.manifest)
    references = expand_references(args.ref, manifest_path, max_images=max_images)
    prompt = build_prompt(scene, args.shot, profiles, config, references)
    size = clean_text(args.size) or default_size(args.shot, profiles, config)
    if args.dry_run:
        preview = {
            "status": "dry-run",
            "backend": backend,
            "workflow": clean_text(args.workflow) or None,
            "shot": args.shot,
            "size": size,
            "send": bool(args.send),
            "references": [
                {
                    "index": item["index"],
                    "id": item["id"],
                    "role": item["role"],
                    "path": str(item["absolute_path"]),
                }
                for item in references
            ],
            "prompt": prompt,
        }
        print(json.dumps(preview, ensure_ascii=False, indent=2))
        return 0
    result = generate_image(
        prompt=prompt,
        config_path=engine_path,
        backend=backend,
        workflow=args.workflow or "",
        size=size,
        seed=args.seed,
        references=references,
        output_dir=output_directory(config, args.out or ""),
        output_prefix=f"phone-{args.shot}",
        send=args.send,
    )
    result.update({"shot": args.shot, "references": [item["id"] for item in references]})
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (ImageGenerationError, ReferenceLibraryError) as exc:
        print(f"PHOTO_ERROR: {exc}", file=sys.stderr)
        raise SystemExit(1)
