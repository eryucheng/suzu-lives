#!/usr/bin/env python3
"""Local ComfyUI workflow backend."""

from __future__ import annotations

import copy
import json
import secrets
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path
from typing import Any

from image_common import ImageGenerationError, clean_text, read_json, resolve_relative


def base_url(config: dict[str, Any]) -> str:
    return (clean_text(config.get("base_url")) or "http://127.0.0.1:8188").rstrip("/")


def integer_setting(config: dict[str, Any], name: str, default: int, minimum: int = 1) -> int:
    try:
        value = int(config.get(name, default))
    except (TypeError, ValueError) as exc:
        raise ImageGenerationError(f"comfyui.{name} 必须是整数") from exc
    if value < minimum:
        raise ImageGenerationError(f"comfyui.{name} 必须不小于 {minimum}")
    return value


def registry_path(config: dict[str, Any], config_path: Path) -> Path:
    configured = clean_text(config.get("registry")) or "workflows/registry.local.json"
    return resolve_relative(config_path, configured)


def validate_api_workflow(value: dict[str, Any], path: Path) -> dict[str, Any]:
    if isinstance(value.get("nodes"), list):
        raise ImageGenerationError(
            f"{path} 是 ComfyUI 界面工作流，不是 API Format；请在 ComfyUI 中导出 API Format"
        )
    if not value:
        raise ImageGenerationError(f"工作流为空：{path}")
    for node_id, node in value.items():
        if not isinstance(node_id, str) or not isinstance(node, dict):
            raise ImageGenerationError(f"工作流节点格式错误：{path}")
        if not clean_text(node.get("class_type")) or not isinstance(node.get("inputs"), dict):
            raise ImageGenerationError(f"工作流节点 {node_id} 缺少 class_type 或 inputs：{path}")
    return value


def validate_binding(
    workflow: dict[str, Any], binding: Any, label: str
) -> dict[str, str]:
    if not isinstance(binding, dict):
        raise ImageGenerationError(f"{label} 必须是对象")
    node_id = clean_text(binding.get("node"))
    input_name = clean_text(binding.get("input"))
    if node_id not in workflow:
        raise ImageGenerationError(f"{label}.node 不存在：{node_id or '<empty>'}")
    if not input_name or input_name not in workflow[node_id]["inputs"]:
        raise ImageGenerationError(f"{label}.input 在节点 {node_id} 中不存在：{input_name or '<empty>'}")
    return {"node": node_id, "input": input_name}


def normalize_entry(
    workflow_id: str, raw: Any, registry_file: Path, *, require_enabled: bool = False
) -> dict[str, Any]:
    if not isinstance(raw, dict):
        raise ImageGenerationError(f"工作流 {workflow_id} 的配置必须是对象")
    enabled = raw.get("enabled", False)
    if not isinstance(enabled, bool):
        raise ImageGenerationError(f"工作流 {workflow_id}.enabled 必须是布尔值")
    if require_enabled and not enabled:
        raise ImageGenerationError(f"COMFYUI_WORKFLOW_NOT_ENABLED：{workflow_id}")
    file_name = clean_text(raw.get("file"))
    if not file_name:
        raise ImageGenerationError(f"工作流 {workflow_id}.file 不能为空")
    workflow_file = resolve_relative(registry_file, file_name)
    workflow = validate_api_workflow(read_json(workflow_file), workflow_file)
    bindings_raw = raw.get("bindings", {})
    defaults = raw.get("defaults", {})
    slots_raw = raw.get("reference_slots", [])
    output_nodes = raw.get("output_nodes", [])
    if not isinstance(bindings_raw, dict) or not isinstance(defaults, dict):
        raise ImageGenerationError(f"工作流 {workflow_id} 的 bindings 和 defaults 必须是对象")
    if not isinstance(slots_raw, list) or not isinstance(output_nodes, list):
        raise ImageGenerationError(f"工作流 {workflow_id} 的 reference_slots 和 output_nodes 必须是数组")
    bindings = {
        name: validate_binding(workflow, value, f"workflows.{workflow_id}.bindings.{name}")
        for name, value in bindings_raw.items()
    }
    if "prompt" not in bindings:
        raise ImageGenerationError(f"工作流 {workflow_id} 必须注册 prompt binding")
    for name in defaults:
        if name not in bindings:
            raise ImageGenerationError(f"工作流 {workflow_id}.defaults.{name} 没有对应 binding")
    slots = []
    for index, raw_slot in enumerate(slots_raw):
        binding = validate_binding(
            workflow, raw_slot, f"workflows.{workflow_id}.reference_slots[{index}]"
        )
        roles = raw_slot.get("roles", []) if isinstance(raw_slot, dict) else []
        required = raw_slot.get("required", False) if isinstance(raw_slot, dict) else False
        if not isinstance(roles, list) or not all(isinstance(role, str) and role for role in roles):
            raise ImageGenerationError(
                f"workflows.{workflow_id}.reference_slots[{index}].roles 必须是字符串数组"
            )
        if not isinstance(required, bool):
            raise ImageGenerationError(
                f"workflows.{workflow_id}.reference_slots[{index}].required 必须是布尔值"
            )
        slots.append({**binding, "roles": roles, "required": required})
    normalized_outputs = []
    for raw_node in output_nodes:
        node_id = clean_text(raw_node)
        if node_id not in workflow:
            raise ImageGenerationError(f"工作流 {workflow_id}.output_nodes 不存在节点：{node_id}")
        normalized_outputs.append(node_id)
    return {
        "id": workflow_id,
        "enabled": enabled,
        "description": clean_text(raw.get("description")),
        "file": workflow_file,
        "workflow": workflow,
        "bindings": bindings,
        "defaults": defaults,
        "reference_slots": slots,
        "output_nodes": normalized_outputs,
    }


def load_registry(config: dict[str, Any], config_path: Path) -> tuple[Path, dict[str, Any]]:
    path = registry_path(config, config_path)
    registry = read_json(path)
    if registry.get("version") != 1 or not isinstance(registry.get("workflows"), dict):
        raise ImageGenerationError("ComfyUI registry 必须包含 version: 1 和 workflows 对象")
    return path, registry


def list_workflows(config: dict[str, Any], config_path: Path) -> dict[str, Any]:
    path, registry = load_registry(config, config_path)
    items = []
    for workflow_id, raw in registry["workflows"].items():
        if not isinstance(raw, dict):
            raise ImageGenerationError(f"工作流 {workflow_id} 的配置必须是对象")
        items.append(
            {
                "id": workflow_id,
                "enabled": raw.get("enabled", False),
                "description": clean_text(raw.get("description")),
                "file": clean_text(raw.get("file")),
            }
        )
    return {"registry": str(path), "workflows": items}


def validate_workflows(config: dict[str, Any], config_path: Path) -> dict[str, Any]:
    path, registry = load_registry(config, config_path)
    validated = []
    for workflow_id, raw in registry["workflows"].items():
        item = normalize_entry(workflow_id, raw, path)
        validated.append({"id": workflow_id, "enabled": item["enabled"], "file": str(item["file"])})
    return {"status": "valid", "registry": str(path), "workflows": validated}


def selected_entry(
    config: dict[str, Any], config_path: Path, workflow_name: str
) -> dict[str, Any]:
    path, registry = load_registry(config, config_path)
    selected = clean_text(workflow_name) or clean_text(config.get("default_workflow"))
    if not selected:
        raise ImageGenerationError("COMFYUI_WORKFLOW_NOT_CONFIGURED：没有指定或配置默认工作流")
    if selected not in registry["workflows"]:
        raise ImageGenerationError(f"COMFYUI_WORKFLOW_NOT_CONFIGURED：{selected}")
    return normalize_entry(selected, registry["workflows"][selected], path, require_enabled=True)


def set_binding(workflow: dict[str, Any], binding: dict[str, str], value: Any) -> None:
    workflow[binding["node"]]["inputs"][binding["input"]] = value


def parse_size(size: str) -> tuple[int, int] | None:
    if not size:
        return None
    try:
        width, height = (int(value) for value in size.lower().split("x", 1))
    except (TypeError, ValueError) as exc:
        raise ImageGenerationError(f"图片尺寸必须是 WIDTHxHEIGHT：{size}") from exc
    if width < 64 or height < 64:
        raise ImageGenerationError("图片宽高必须至少为 64")
    return width, height


def prepare_workflow(
    entry: dict[str, Any], *, prompt: str, size: str, seed: int | None
) -> tuple[dict[str, Any], int]:
    workflow = copy.deepcopy(entry["workflow"])
    for name, value in entry["defaults"].items():
        set_binding(workflow, entry["bindings"][name], value)
    set_binding(workflow, entry["bindings"]["prompt"], prompt)
    actual_seed = seed if seed is not None else secrets.randbelow(2**63 - 1) + 1
    if "seed" in entry["bindings"]:
        set_binding(workflow, entry["bindings"]["seed"], actual_seed)
    parsed_size = parse_size(size)
    if parsed_size:
        if "width" in entry["bindings"]:
            set_binding(workflow, entry["bindings"]["width"], parsed_size[0])
        if "height" in entry["bindings"]:
            set_binding(workflow, entry["bindings"]["height"], parsed_size[1])
    return workflow, actual_seed


def multipart_upload(path: Path, subfolder: str) -> tuple[bytes, str]:
    boundary = f"----suzu-lives-{uuid.uuid4().hex}"
    mime = {
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".webp": "image/webp",
    }.get(path.suffix.lower(), "application/octet-stream")
    chunks = [
        f"--{boundary}\r\n".encode(),
        f'Content-Disposition: form-data; name="image"; filename="{path.name}"\r\n'.encode(),
        f"Content-Type: {mime}\r\n\r\n".encode(),
        path.read_bytes(),
        b"\r\n",
    ]
    for name, value in (("type", "input"), ("subfolder", subfolder), ("overwrite", "true")):
        chunks.extend(
            [
                f"--{boundary}\r\n".encode(),
                f'Content-Disposition: form-data; name="{name}"\r\n\r\n'.encode(),
                f"{value}\r\n".encode(),
            ]
        )
    chunks.append(f"--{boundary}--\r\n".encode())
    return b"".join(chunks), boundary


def json_request(request: urllib.request.Request, timeout: int) -> dict[str, Any]:
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            value = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")[:1000]
        raise ImageGenerationError(f"ComfyUI HTTP {exc.code}：{' '.join(detail.split())}") from exc
    except urllib.error.URLError as exc:
        raise ImageGenerationError(f"COMFYUI_UNAVAILABLE：{exc.reason}") from exc
    except TimeoutError as exc:
        raise ImageGenerationError("ComfyUI 请求超时") from exc
    except json.JSONDecodeError as exc:
        raise ImageGenerationError(f"ComfyUI 返回的不是有效 JSON：{exc}") from exc
    if not isinstance(value, dict):
        raise ImageGenerationError("ComfyUI 返回格式不正确")
    return value


def upload_reference(
    server: str, path: Path, *, subfolder: str, timeout: int
) -> str:
    body, boundary = multipart_upload(path, subfolder)
    request = urllib.request.Request(
        f"{server}/upload/image",
        data=body,
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
        method="POST",
    )
    result = json_request(request, timeout)
    name = clean_text(result.get("name"))
    returned_subfolder = clean_text(result.get("subfolder"))
    if not name:
        raise ImageGenerationError("ComfyUI 上传参考图后没有返回文件名")
    return f"{returned_subfolder}/{name}" if returned_subfolder else name


def bind_references(
    workflow: dict[str, Any],
    entry: dict[str, Any],
    references: list[dict[str, Any]],
    *,
    server: str,
    subfolder: str,
    timeout: int,
) -> list[str]:
    unused = list(range(len(references)))
    used_ids = []
    for slot in entry["reference_slots"]:
        selected_index = next(
            (
                index
                for index in unused
                if not slot["roles"] or clean_text(references[index].get("role")) in slot["roles"]
            ),
            None,
        )
        if selected_index is None:
            if slot["required"]:
                raise ImageGenerationError(
                    f"工作流 {entry['id']} 缺少必需参考图，允许角色：{slot['roles'] or ['any']}"
                )
            continue
        unused.remove(selected_index)
        item = references[selected_index]
        path = Path(item["absolute_path"]).resolve()
        uploaded = upload_reference(server, path, subfolder=subfolder, timeout=timeout)
        set_binding(workflow, slot, uploaded)
        used_ids.append(clean_text(item.get("id")) or path.name)
    if unused:
        extra = [clean_text(references[index].get("id")) or str(index + 1) for index in unused]
        raise ImageGenerationError(
            f"工作流 {entry['id']} 没有足够的参考图输入槽，未使用：{', '.join(extra)}"
        )
    return used_ids


def submit(server: str, workflow: dict[str, Any], client_id: str, timeout: int) -> str:
    body = json.dumps({"prompt": workflow, "client_id": client_id}, ensure_ascii=False).encode()
    request = urllib.request.Request(
        f"{server}/prompt",
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    result = json_request(request, timeout)
    prompt_id = clean_text(result.get("prompt_id"))
    if not prompt_id:
        raise ImageGenerationError(
            f"ComfyUI 拒绝工作流：{json.dumps(result.get('node_errors', result), ensure_ascii=False)[:1000]}"
        )
    return prompt_id


def find_output(entry: dict[str, Any], history: dict[str, Any]) -> dict[str, Any] | None:
    outputs = history.get("outputs", {})
    if not isinstance(outputs, dict):
        return None
    node_ids = entry["output_nodes"] or list(outputs)
    for node_id in node_ids:
        output = outputs.get(node_id, {})
        if not isinstance(output, dict):
            continue
        images = output.get("images", [])
        if isinstance(images, list) and images and isinstance(images[0], dict):
            return {"node_id": node_id, **images[0]}
    return None


def wait_output(
    server: str,
    prompt_id: str,
    entry: dict[str, Any],
    *,
    timeout: int,
    poll_seconds: float,
) -> dict[str, Any]:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        request = urllib.request.Request(f"{server}/history/{urllib.parse.quote(prompt_id)}")
        result = json_request(request, min(timeout, 30))
        history = result.get(prompt_id)
        if isinstance(history, dict):
            output = find_output(entry, history)
            if output:
                return output
            status = history.get("status", {})
            if isinstance(status, dict):
                messages = status.get("messages", [])
                status_name = clean_text(status.get("status_str")).lower()
                message_types = {
                    clean_text(item[0]).lower()
                    for item in messages
                    if isinstance(item, list) and item
                }
                if status_name in {"error", "failed", "cancelled", "canceled"} or (
                    "execution_error" in message_types
                ):
                    raise ImageGenerationError(
                        "ComfyUI 工作流执行失败："
                        f"{json.dumps(messages, ensure_ascii=False)[:1000]}"
                    )
                if status.get("completed"):
                    raise ImageGenerationError(
                        "ComfyUI 工作流结束但没有图片输出："
                        f"{json.dumps(messages, ensure_ascii=False)[:1000]}"
                    )
        time.sleep(poll_seconds)
    raise ImageGenerationError(f"ComfyUI 工作流等待超过 {timeout} 秒")


def download_output(server: str, output: dict[str, Any], timeout: int) -> bytes:
    query = urllib.parse.urlencode(
        {
            "filename": clean_text(output.get("filename")),
            "subfolder": clean_text(output.get("subfolder")),
            "type": clean_text(output.get("type")) or "output",
        }
    )
    try:
        with urllib.request.urlopen(f"{server}/view?{query}", timeout=timeout) as response:
            return response.read()
    except urllib.error.HTTPError as exc:
        raise ImageGenerationError(f"下载 ComfyUI 输出失败：HTTP {exc.code}") from exc
    except urllib.error.URLError as exc:
        raise ImageGenerationError(f"下载 ComfyUI 输出失败：{exc.reason}") from exc


def generate(
    config: dict[str, Any],
    config_path: Path,
    *,
    prompt: str,
    size: str,
    seed: int | None,
    workflow_name: str,
    references: list[dict[str, Any]],
) -> tuple[bytes, dict[str, Any]]:
    entry = selected_entry(config, config_path, workflow_name)
    workflow, actual_seed = prepare_workflow(entry, prompt=prompt, size=size, seed=seed)
    server = base_url(config)
    timeout = integer_setting(config, "timeout_seconds", 600)
    try:
        poll_seconds = float(config.get("poll_interval_seconds", 1.0))
    except (TypeError, ValueError) as exc:
        raise ImageGenerationError("comfyui.poll_interval_seconds 必须是数字") from exc
    if poll_seconds < 0.1 or poll_seconds > 30:
        raise ImageGenerationError("comfyui.poll_interval_seconds 必须在 0.1 到 30 之间")
    client_id = str(uuid.uuid4())
    configured_subfolder = clean_text(config.get("upload_subfolder")) or "suzu-lives"
    used_references = bind_references(
        workflow,
        entry,
        references,
        server=server,
        subfolder=f"{configured_subfolder}/{client_id}",
        timeout=min(timeout, 120),
    )
    prompt_id = submit(server, workflow, client_id, min(timeout, 120))
    output = wait_output(
        server,
        prompt_id,
        entry,
        timeout=timeout,
        poll_seconds=poll_seconds,
    )
    image = download_output(server, output, min(timeout, 120))
    return image, {
        "mode": "workflow",
        "workflow": entry["id"],
        "prompt_id": prompt_id,
        "output_node": output["node_id"],
        "seed": actual_seed,
        "references_used": used_references,
    }
