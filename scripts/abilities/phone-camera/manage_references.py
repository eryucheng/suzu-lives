#!/usr/bin/env python3
"""Safely maintain the user-owned visual reference manifest and image library."""

from __future__ import annotations

import argparse
import copy
import json
import os
import shutil
import sys
import tempfile
from pathlib import Path
from typing import Any

from reference_library import (
    ROLE_DIRECTORIES,
    ReferenceLibraryError,
    clean_text,
    empty_manifest,
    read_json,
    relative_asset_path,
    safe_asset_path,
    validate_id,
    validate_manifest,
    validate_string_list,
)


SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_DIR = SCRIPT_DIR.parents[2]
DEFAULT_MANIFEST = PROJECT_DIR / "visual-references" / "manifest.json"
EXAMPLE_MANIFEST = PROJECT_DIR / "visual-references" / "manifest.example.json"


def write_json_atomic(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    handle, temp_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(handle, "w", encoding="utf-8", newline="\n") as stream:
            json.dump(value, stream, ensure_ascii=False, indent=2)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp_name, path)
    except Exception:
        try:
            os.unlink(temp_name)
        except OSError:
            pass
        raise


def initialize_library(manifest_path: Path) -> dict[str, Any]:
    root = manifest_path.parent
    created = []
    root.mkdir(parents=True, exist_ok=True)
    for directory in ROLE_DIRECTORIES.values():
        path = root / directory
        if not path.exists():
            path.mkdir(parents=True)
            created.append(str(path))
    if not manifest_path.exists():
        if EXAMPLE_MANIFEST.exists() and manifest_path == DEFAULT_MANIFEST:
            manifest = validate_manifest(read_json(EXAMPLE_MANIFEST), manifest_path, require_files=False)
        else:
            manifest = empty_manifest()
        write_json_atomic(manifest_path, manifest)
        created.append(str(manifest_path))
    else:
        validate_manifest(read_json(manifest_path), manifest_path, require_files=True)
    return {"status": "ready", "manifest": str(manifest_path), "created": created}


def current_manifest(manifest_path: Path) -> dict[str, Any]:
    if not manifest_path.exists():
        return empty_manifest()
    return validate_manifest(read_json(manifest_path), manifest_path, require_files=True)


def normalize_plan(plan: dict[str, Any]) -> dict[str, Any]:
    if plan.get("version") != 1:
        raise ReferenceLibraryError("plan.version 必须是 1")
    operations = plan.get("operations")
    if not isinstance(operations, list) or not operations:
        raise ReferenceLibraryError("plan.operations 必须是非空数组")
    raw_sets = plan.get("sets", {})
    if not isinstance(raw_sets, dict):
        raise ReferenceLibraryError("plan.sets 必须是对象")
    set_descriptions = {}
    for raw_id, raw_description in raw_sets.items():
        set_id = validate_id(raw_id, "plan set id")
        description = clean_text(raw_description)
        if not description:
            raise ReferenceLibraryError(f"plan.sets.{set_id} 不能为空")
        set_descriptions[set_id] = description
    return {"version": 1, "sets": set_descriptions, "operations": operations}


def operation_sets(value: Any, label: str) -> list[str] | None:
    if value is None:
        return None
    return [validate_id(item, label) for item in validate_string_list(value, label)]


def ensure_set(manifest: dict[str, Any], set_id: str, descriptions: dict[str, str]) -> None:
    if set_id in manifest["assets"]:
        raise ReferenceLibraryError(f"set id 与 asset id 不能同名：{set_id}")
    existing = manifest["sets"].get(set_id)
    if existing is None:
        description = descriptions.get(set_id)
        if not description:
            raise ReferenceLibraryError(f"新增 set {set_id} 时必须在 plan.sets 中填写描述")
        manifest["sets"][set_id] = {"description": description, "assets": []}
    elif set_id in descriptions:
        existing["description"] = descriptions[set_id]


def set_membership(
    manifest: dict[str, Any], asset_id: str, memberships: list[str], descriptions: dict[str, str]
) -> None:
    for set_id in memberships:
        ensure_set(manifest, set_id, descriptions)
    for item in manifest["sets"].values():
        item["assets"] = [value for value in item["assets"] if value != asset_id]
    for set_id in memberships:
        manifest["sets"][set_id]["assets"].append(asset_id)


def build_transaction(
    manifest_path: Path, plan: dict[str, Any]
) -> tuple[dict[str, Any], list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]]]:
    result = copy.deepcopy(current_manifest(manifest_path))
    additions = []
    deletions = []
    summary = []
    seen_operation_ids = set()

    for index, raw in enumerate(plan["operations"]):
        if not isinstance(raw, dict):
            raise ReferenceLibraryError(f"operations[{index}] 必须是对象")
        action = clean_text(raw.get("action"))
        asset_id = validate_id(raw.get("id"), f"operations[{index}].id")
        if asset_id in seen_operation_ids:
            raise ReferenceLibraryError(f"同一计划不能多次操作同一 asset：{asset_id}")
        seen_operation_ids.add(asset_id)

        if action == "add":
            if asset_id in result["assets"]:
                raise ReferenceLibraryError(f"asset 已存在，不能静默覆盖：{asset_id}")
            role = clean_text(raw.get("role"))
            if role not in ROLE_DIRECTORIES:
                raise ReferenceLibraryError(f"operations[{index}].role 无效：{role}")
            source = Path(clean_text(raw.get("source"))).expanduser().resolve()
            if not source.is_file():
                raise ReferenceLibraryError(f"源图片不存在：{source}")
            description = clean_text(raw.get("description"))
            if not description:
                raise ReferenceLibraryError(f"operations[{index}].description 不能为空")
            preserve = validate_string_list(raw.get("preserve"), f"operations[{index}].preserve")
            ignore = validate_string_list(raw.get("ignore"), f"operations[{index}].ignore")
            memberships = operation_sets(raw.get("sets", []), f"operations[{index}].sets") or []
            relative = relative_asset_path(asset_id, role, source.suffix)
            target = safe_asset_path(manifest_path.parent, relative)
            if target.exists():
                raise ReferenceLibraryError(f"目标文件已存在，不能静默覆盖：{relative}")
            result["assets"][asset_id] = {
                "path": relative,
                "role": role,
                "description": description,
                "preserve": preserve,
                "ignore": ignore,
            }
            set_membership(result, asset_id, memberships, plan["sets"])
            additions.append({"id": asset_id, "source": source, "target": target, "relative": relative})
            summary.append({"action": "add", "id": asset_id, "path": relative, "sets": memberships})
            continue

        if action == "update":
            if asset_id not in result["assets"]:
                raise ReferenceLibraryError(f"找不到要更新的 asset：{asset_id}")
            asset = result["assets"][asset_id]
            if "description" in raw:
                description = clean_text(raw.get("description"))
                if not description:
                    raise ReferenceLibraryError(f"operations[{index}].description 不能为空")
                asset["description"] = description
            if "role" in raw:
                role = clean_text(raw.get("role"))
                if role not in ROLE_DIRECTORIES:
                    raise ReferenceLibraryError(f"operations[{index}].role 无效：{role}")
                if role != asset["role"]:
                    old_relative = asset["path"]
                    old_path = safe_asset_path(manifest_path.parent, old_relative)
                    new_relative = relative_asset_path(asset_id, role, old_path.suffix)
                    new_path = safe_asset_path(manifest_path.parent, new_relative)
                    if new_path.exists():
                        raise ReferenceLibraryError(
                            f"修改 role 后的目标文件已存在，不能静默覆盖：{new_relative}"
                        )
                    asset["role"] = role
                    asset["path"] = new_relative
                    additions.append(
                        {
                            "id": asset_id,
                            "source": old_path,
                            "target": new_path,
                            "relative": new_relative,
                        }
                    )
                    deletions.append(
                        {"id": asset_id, "target": old_path, "relative": old_relative}
                    )
            for field in ("preserve", "ignore"):
                if field in raw:
                    asset[field] = validate_string_list(raw.get(field), f"operations[{index}].{field}")
            memberships = operation_sets(raw.get("sets"), f"operations[{index}].sets")
            if memberships is not None:
                set_membership(result, asset_id, memberships, plan["sets"])
            summary.append(
                {
                    "action": "update",
                    "id": asset_id,
                    "role": asset["role"],
                    "path": asset["path"],
                    "sets": memberships,
                }
            )
            continue

        if action == "remove":
            if asset_id not in result["assets"]:
                raise ReferenceLibraryError(f"找不到要删除的 asset：{asset_id}")
            if not isinstance(raw.get("delete_file"), bool):
                raise ReferenceLibraryError(
                    f"operations[{index}].delete_file 必须明确填写 true 或 false"
                )
            asset = result["assets"].pop(asset_id)
            target = safe_asset_path(manifest_path.parent, asset["path"])
            for item in result["sets"].values():
                item["assets"] = [value for value in item["assets"] if value != asset_id]
            if raw["delete_file"]:
                deletions.append({"id": asset_id, "target": target, "relative": asset["path"]})
            summary.append({"action": "remove", "id": asset_id, "deleted_file": raw["delete_file"]})
            continue

        raise ReferenceLibraryError(f"operations[{index}].action 只能是 add、update 或 remove")

    for set_id, description in plan["sets"].items():
        if set_id in result["sets"]:
            result["sets"][set_id]["description"] = description

    allowed_missing = {item["relative"] for item in additions}
    normalized = validate_manifest(
        result, manifest_path, require_files=True, allowed_missing=allowed_missing
    )
    return normalized, additions, deletions, summary


def commit_transaction(
    manifest_path: Path,
    manifest: dict[str, Any],
    additions: list[dict[str, Any]],
    deletions: list[dict[str, Any]],
) -> None:
    root = manifest_path.parent.resolve()
    root.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=".reference-stage-", dir=root))
    moved_additions = []
    moved_deletions = []
    try:
        staged_additions = []
        for index, item in enumerate(additions):
            staged = staging / f"add-{index}{item['source'].suffix.lower()}"
            shutil.copy2(item["source"], staged)
            staged_additions.append((staged, item["target"]))

        for index, item in enumerate(deletions):
            target = item["target"]
            if target.exists():
                backup = staging / f"deleted-{index}{target.suffix.lower()}"
                target.replace(backup)
                moved_deletions.append((backup, target))

        for staged, target in staged_additions:
            target.parent.mkdir(parents=True, exist_ok=True)
            staged.replace(target)
            moved_additions.append(target)

        write_json_atomic(manifest_path, manifest)
    except Exception:
        for target in reversed(moved_additions):
            try:
                target.unlink(missing_ok=True)
            except OSError:
                pass
        for backup, target in reversed(moved_deletions):
            try:
                target.parent.mkdir(parents=True, exist_ok=True)
                if backup.exists():
                    backup.replace(target)
            except OSError:
                pass
        raise
    finally:
        shutil.rmtree(staging, ignore_errors=True)


def list_library(
    manifest_path: Path, *, query: str = "", role: str = "", limit: int = 20
) -> dict[str, Any]:
    manifest = validate_manifest(current_manifest(manifest_path), manifest_path, require_files=True)
    terms = [item.casefold() for item in query.split() if item]
    matched_assets = []
    for asset_id, item in manifest["assets"].items():
        memberships = [
            set_id for set_id, value in manifest["sets"].items() if asset_id in value["assets"]
        ]
        membership_descriptions = [manifest["sets"][set_id]["description"] for set_id in memberships]
        searchable = " ".join(
            [
                asset_id,
                item["description"],
                *item["preserve"],
                *item["ignore"],
                *memberships,
                *membership_descriptions,
            ]
        ).casefold()
        if role and item["role"] != role:
            continue
        if terms and not all(term in searchable for term in terms):
            continue
        matched_assets.append(
            {
                "id": asset_id,
                "role": item["role"],
                "description": item["description"],
                "sets": memberships,
            }
        )
    matched_sets = []
    for set_id, item in manifest["sets"].items():
        searchable = f"{set_id} {item['description']}".casefold()
        if terms and not all(term in searchable for term in terms):
            continue
        matched_sets.append(
            {"id": set_id, "description": item["description"], "assets": item["assets"]}
        )
    return {
        "status": "ok",
        "manifest": str(manifest_path),
        "asset_count": len(manifest["assets"]),
        "set_count": len(manifest["sets"]),
        "query": query,
        "role": role or None,
        "matched_asset_count": len(matched_assets),
        "matched_set_count": len(matched_sets),
        "assets": matched_assets[:limit],
        "sets": matched_sets[:limit],
        "truncated": len(matched_assets) > limit or len(matched_sets) > limit,
    }


def show_item(manifest_path: Path, item_id: str) -> dict[str, Any]:
    manifest = validate_manifest(current_manifest(manifest_path), manifest_path, require_files=True)
    if item_id in manifest["assets"]:
        memberships = [
            set_id for set_id, item in manifest["sets"].items() if item_id in item["assets"]
        ]
        return {
            "status": "ok",
            "type": "asset",
            "id": item_id,
            **manifest["assets"][item_id],
            "sets": memberships,
        }
    if item_id in manifest["sets"]:
        return {"status": "ok", "type": "set", "id": item_id, **manifest["sets"][item_id]}
    raise ReferenceLibraryError(f"找不到 asset 或 set：{item_id}")


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="维护视觉参考图片和 manifest")
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST, help="manifest.json 路径")
    subparsers = parser.add_subparsers(dest="command", required=True)
    subparsers.add_parser("init", help="创建空参考库")
    apply_parser = subparsers.add_parser("apply", help="校验并原子执行批量维护计划")
    apply_parser.add_argument("--plan", type=Path, required=True, help="维护计划 JSON")
    apply_parser.add_argument("--dry-run", action="store_true", help="只校验和预览，不写文件")
    list_parser = subparsers.add_parser("list", help="搜索或列出参考图片和参考组")
    list_parser.add_argument("--query", default="", help="按 ID、描述、保留项或组名搜索")
    list_parser.add_argument("--role", choices=tuple(ROLE_DIRECTORIES), default="")
    list_parser.add_argument("--limit", type=int, default=20, help="最多返回多少条 asset 和 set")
    show_parser = subparsers.add_parser("show", help="显示一个 asset 或 set")
    show_parser.add_argument("id")
    subparsers.add_parser("validate", help="检查 manifest、引用和图片文件")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv or sys.argv[1:])
    manifest_path = args.manifest.expanduser().resolve()

    if args.command == "init":
        result = initialize_library(manifest_path)
    elif args.command == "apply":
        plan = normalize_plan(read_json(args.plan.expanduser().resolve()))
        manifest, additions, deletions, summary = build_transaction(manifest_path, plan)
        result = {
            "status": "dry-run" if args.dry_run else "written",
            "manifest": str(manifest_path),
            "operations": summary,
            "asset_count": len(manifest["assets"]),
            "set_count": len(manifest["sets"]),
        }
        if not args.dry_run:
            commit_transaction(manifest_path, manifest, additions, deletions)
    elif args.command == "list":
        if args.limit < 1 or args.limit > 200:
            raise ReferenceLibraryError("--limit 必须在 1 到 200 之间")
        result = list_library(
            manifest_path, query=clean_text(args.query), role=args.role, limit=args.limit
        )
    elif args.command == "show":
        result = show_item(manifest_path, validate_id(args.id, "id"))
    elif args.command == "validate":
        manifest = validate_manifest(current_manifest(manifest_path), manifest_path, require_files=True)
        result = {
            "status": "valid",
            "manifest": str(manifest_path),
            "asset_count": len(manifest["assets"]),
            "set_count": len(manifest["sets"]),
        }
    else:
        raise ReferenceLibraryError(f"未知命令：{args.command}")

    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except ReferenceLibraryError as exc:
        print(f"REFERENCE_ERROR: {exc}", file=sys.stderr)
        raise SystemExit(1)
    except OSError as exc:
        print(f"REFERENCE_ERROR: 文件操作失败：{exc}", file=sys.stderr)
        raise SystemExit(1)
