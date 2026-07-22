#!/usr/bin/env python3
"""Unified CLI for API and explicitly selected local ComfyUI generation."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from image_common import ImageGenerationError, clean_text
from image_engine import (
    DEFAULT_CONFIG,
    generate_image,
    list_comfy_workflows,
    validate_comfy_workflows,
)


REFERENCE_ROLES = {"identity", "location", "object", "style"}


def parse_reference(value: str, index: int) -> dict[str, object]:
    role, separator, raw_path = value.partition("=")
    if not separator:
        role, raw_path = "object", role
    role = clean_text(role)
    if role not in REFERENCE_ROLES:
        raise ImageGenerationError(
            f"--ref 角色必须是 identity、location、object 或 style：{role}"
        )
    path = Path(raw_path).expanduser().resolve()
    return {
        "id": f"cli-reference-{index}",
        "role": role,
        "description": path.stem,
        "preserve": [],
        "ignore": [],
        "absolute_path": path,
    }


def prompt_with_reference_roles(prompt: str, references: list[dict[str, object]]) -> str:
    """Tell edit-capable models how each ordered input image should be used."""
    if not references:
        return prompt
    lines = []
    for index, item in enumerate(references, 1):
        label = clean_text(item.get("description")) or f"reference-{index}"
        lines.append(f"- Input image {index}: role={item['role']}; label={label}")
    return (
        f"{prompt}\n\nReference image roles (do not confuse their purposes):\n"
        + "\n".join(lines)
    )


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="使用云端 API 或明确指定的 ComfyUI 工作流生成图片")
    parser.add_argument("--prompt", help="画面内容")
    parser.add_argument("--backend", choices=("api", "comfyui"), help="默认读取配置")
    parser.add_argument("--workflow", help="ComfyUI 注册工作流 ID")
    parser.add_argument("--size", default="1024x1024")
    parser.add_argument("--seed", type=int, help="需要复现结果时才指定")
    parser.add_argument(
        "--ref", action="append", default=[], metavar="[ROLE=]PATH", help="参考图，可重复"
    )
    parser.add_argument("--out", help="临时覆盖输出目录")
    parser.add_argument("--send", action="store_true")
    parser.add_argument("--config", type=Path, default=DEFAULT_CONFIG)
    parser.add_argument("--list-workflows", action="store_true")
    parser.add_argument("--validate-workflows", action="store_true")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv or sys.argv[1:])
    if args.list_workflows:
        print(json.dumps(list_comfy_workflows(args.config), ensure_ascii=False, indent=2))
        return 0
    if args.validate_workflows:
        print(json.dumps(validate_comfy_workflows(args.config), ensure_ascii=False, indent=2))
        return 0
    if not clean_text(args.prompt):
        raise ImageGenerationError("生成图片时必须填写 --prompt")
    references = [parse_reference(value, index) for index, value in enumerate(args.ref, 1)]
    result = generate_image(
        prompt=prompt_with_reference_roles(args.prompt, references),
        config_path=args.config,
        backend=args.backend or "",
        workflow=args.workflow or "",
        size=args.size,
        seed=args.seed,
        references=references,
        output_dir=args.out or "",
        output_prefix="image",
        send=args.send,
    )
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except ImageGenerationError as exc:
        print(f"IMAGE_ERROR: {exc}", file=sys.stderr)
        raise SystemExit(1)
