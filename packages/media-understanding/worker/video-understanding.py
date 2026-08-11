#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Software-owned OpenAI-compatible video-understanding worker.

Suzu's host-neutral capability CLI starts this worker.
Configuration, temporary clips, cache entries, retained clips, and usage
events belong to Suzu Lives; no Agent workspace runtime is used.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
from typing import Any
import urllib.error
import urllib.parse
import urllib.request


if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")


PROMPT_VERSION = "video-summary-v2-whole-input"
SYSTEM_PROMPT = """你负责理解一段视频中的画面、人物动作、语音、字幕、音乐和环境声音。
只陈述这段视频里实际出现或能够可靠听到的内容，不用上下文补写，不猜测看不清或听不清的细节。
输出简洁的中文自然语言，不输出 JSON，不替观看者决定是否点赞、评论或继续观看。"""

DEFAULT_QUESTION = """请概括这个片段实际发生了什么。
先说清主要内容和过程，再保留理解它所需的关键话语、字幕、转折、结果或悬念。
如果某项信息看不清或听不清，明确说不确定；不要写空泛的镜头语言分析。"""


class VideoError(RuntimeError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


class VideoApiError(VideoError):
    def __init__(self, status: int, message: str):
        super().__init__("api_error", message)
        self.status = status


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="理解一个本地视频或可公开访问的视频 URL")
    parser.add_argument("video", help="本地视频路径或 http(s) URL")
    parser.add_argument("--question", help="希望模型重点回答的问题")
    parser.add_argument("--cache-key", help="上游内容的稳定标识；仍会结合视频内容校验缓存")
    parser.add_argument("--config", default="", help="Suzu Lives 数据目录中的视频理解配置路径")
    parser.add_argument("--data-root", required=True, help="Suzu Lives 软件数据目录")
    parser.add_argument("--no-cache", action="store_true", help="忽略并不写入结果缓存")
    parser.add_argument("--keep-clip", action="store_true", help="把送给模型的 MP4 片段保留到软件数据目录")
    parser.add_argument("--dry-run", action="store_true", help="只准备片段并检查大小，不请求 API")
    parser.add_argument("--event-stream", action="store_true", help=argparse.SUPPRESS)
    return parser.parse_args()


def is_inside(root: Path, candidate: Path) -> bool:
    try:
        candidate.relative_to(root)
        return True
    except ValueError:
        return False


def capability_root(data_root: Path) -> Path:
    return data_root / "capabilities" / "video-understanding"


def default_config_path(data_root: Path) -> Path:
    return capability_root(data_root) / "config.json"


def resolve_config_path(data_root: Path, value: str) -> Path:
    candidate = Path(value).expanduser().resolve() if value else default_config_path(data_root).resolve()
    if not is_inside(data_root, candidate):
        raise VideoError("config_invalid", "视频理解配置必须位于 Suzu Lives 软件数据目录内")
    return candidate


def read_json(path: Path) -> dict[str, Any]:
    if not path.is_file():
        raise VideoError(
            "config_missing",
            f"配置文件不存在：{path}；请在软件数据目录中创建视频理解配置并填写公开字段",
        )
    try:
        with path.open("r", encoding="utf-8-sig") as handle:
            data = json.load(handle)
    except json.JSONDecodeError as exc:
        raise VideoError("config_invalid", f"配置文件不是有效 JSON：{exc}") from exc
    if not isinstance(data, dict):
        raise VideoError("config_invalid", "配置文件顶层必须是 JSON 对象")
    return data


def as_int(value: Any, default: int, minimum: int = 1) -> int:
    try:
        result = int(value)
    except (TypeError, ValueError):
        return default
    return max(minimum, result)


def as_float(value: Any, default: float, minimum: float = 0.0) -> float:
    try:
        result = float(value)
    except (TypeError, ValueError):
        return default
    return max(minimum, result)


def as_bool(value: Any, default: bool) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() in {"1", "true", "yes", "on"}
    return default


def load_settings(path: Path, require_api_key: bool) -> dict[str, Any]:
    raw = read_json(path)
    provider = raw.get("provider") if isinstance(raw.get("provider"), dict) else {}
    video = raw.get("video") if isinstance(raw.get("video"), dict) else {}

    key_env = str(provider.get("api_key_env") or "DASHSCOPE_API_KEY")
    api_key = (
        os.environ.get("VIDEO_UNDERSTANDING_API_KEY")
        or os.environ.get(key_env)
        or provider.get("api_key", "")
    )
    base_url = (
        os.environ.get("VIDEO_UNDERSTANDING_BASE_URL")
        or provider.get("base_url")
        or "https://dashscope.aliyuncs.com/compatible-mode/v1"
    )
    model = (
        os.environ.get("VIDEO_UNDERSTANDING_MODEL")
        or provider.get("model")
        or "qwen3.5-omni-flash"
    )

    if require_api_key and not api_key:
        raise VideoError(
            "api_key_missing",
            f"没有 API Key；请填写 provider.api_key，或设置 {key_env} / VIDEO_UNDERSTANDING_API_KEY",
        )

    fps = as_float(video.get("fps"), 1.0, 0.1)
    if fps > 10:
        raise VideoError("config_invalid", "video.fps 必须在 0.1 到 10 之间")

    return {
        "api_key": str(api_key),
        "base_url": str(base_url),
        "model": str(model),
        "fps": fps,
        "timeout_seconds": as_int(video.get("timeout_seconds"), 240),
        "max_output_tokens": as_int(video.get("max_output_tokens"), 350),
        "temperature": min(1.99, as_float(video.get("temperature"), 0.2)),
        "max_binary_bytes": as_int(video.get("max_binary_bytes"), 7_000_000),
        "ffmpeg_path": str(video.get("ffmpeg_path") or "ffmpeg"),
        "ffprobe_path": str(video.get("ffprobe_path") or "ffprobe"),
        "cache_enabled": as_bool(video.get("cache_enabled"), True),
        "cache_dir": str(video.get("cache_dir") or "runtime/cache"),
    }


def endpoint_from_base_url(base_url: str) -> str:
    url = base_url.rstrip("/")
    if url.endswith("/chat/completions"):
        return url
    if url.endswith("/v1"):
        return url + "/chat/completions"
    return url + "/v1/chat/completions"


def is_url(value: str) -> bool:
    parsed = urllib.parse.urlparse(value)
    return parsed.scheme.lower() in {"http", "https"} and bool(parsed.netloc)


def source_for_tools(value: str) -> tuple[str, str]:
    if is_url(value):
        parsed = urllib.parse.urlsplit(value)
        safe_label = urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, parsed.path, "", ""))
        return value, safe_label
    path = Path(value).expanduser().resolve()
    if not path.is_file():
        raise VideoError("video_missing", f"视频文件不存在：{path}")
    return str(path), str(path)


def ensure_command(command: str, label: str) -> None:
    if Path(command).is_file() or shutil.which(command):
        return
    raise VideoError(
        "dependency_missing",
        f"找不到 {label}：{command}；请安装 FFmpeg，或在配置中填写完整路径",
    )


def run_process(command: list[str], code: str, label: str) -> subprocess.CompletedProcess[str]:
    try:
        completed = subprocess.run(
            command,
            check=False,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
    except OSError as exc:
        raise VideoError(code, f"{label}启动失败：{exc}") from exc
    if completed.returncode != 0:
        detail = (completed.stderr or completed.stdout or "").strip()
        if len(detail) > 1200:
            detail = detail[-1200:]
        raise VideoError(code, f"{label}失败：{detail or f'退出码 {completed.returncode}'}")
    return completed


def probe_duration(source: str, ffprobe: str) -> float:
    completed = run_process(
        [
            ffprobe,
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "json",
            source,
        ],
        "probe_failed",
        "读取视频信息",
    )
    try:
        payload = json.loads(completed.stdout)
        duration = float(payload["format"]["duration"])
    except (json.JSONDecodeError, KeyError, TypeError, ValueError) as exc:
        raise VideoError("probe_failed", "FFprobe 没有返回可用的视频时长") from exc
    if duration <= 0:
        raise VideoError("probe_failed", "视频时长必须大于 0")
    return duration


def transcode_once(
    source: str,
    target: Path,
    ffmpeg: str,
    max_edge: int,
    crf: int,
    audio_bitrate: str,
) -> None:
    command = [
        ffmpeg,
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        source,
        "-map",
        "0:v:0",
        "-map",
        "0:a:0?",
        "-vf",
        f"scale={max_edge}:{max_edge}:force_original_aspect_ratio=decrease:force_divisible_by=2",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        str(crf),
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-b:a",
        audio_bitrate,
        "-ar",
        "16000",
        "-ac",
        "1",
        "-movflags",
        "+faststart",
        str(target),
    ]
    run_process(command, "transcode_failed", "准备视频片段")


def prepare_clip(source: str, target: Path, settings: dict[str, Any]) -> tuple[int, dict[str, Any]]:
    profiles = (
        {"maxEdge": 854, "crf": 29, "audioBitrate": "56k"},
        {"maxEdge": 640, "crf": 32, "audioBitrate": "48k"},
        {"maxEdge": 480, "crf": 35, "audioBitrate": "40k"},
    )
    attempts: list[dict[str, Any]] = []
    for profile in profiles:
        transcode_once(
            source,
            target,
            settings["ffmpeg_path"],
            profile["maxEdge"],
            profile["crf"],
            profile["audioBitrate"],
        )
        size = target.stat().st_size
        attempts.append({**profile, "bytes": size})
        if size <= settings["max_binary_bytes"]:
            return size, {"selected": profile, "attempts": attempts}
    raise VideoError(
        "clip_too_large",
        (
            f"压缩后的片段仍有 {target.stat().st_size} 字节，超过配置上限 "
            f"{settings['max_binary_bytes']}；请让上游先导出更短的视频片段"
        ),
    )


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def build_prompt(question: str, duration: float) -> str:
    return (
        f"你收到的是一段完整输入视频，时长约 {duration:.2f} 秒。\n"
        f"{question.strip() or DEFAULT_QUESTION}"
    )


def make_cache_digest(clip_sha256: str, question: str, cache_key: str, settings: dict[str, Any]) -> str:
    material = {
        "promptVersion": PROMPT_VERSION,
        "clipSha256": clip_sha256,
        "question": question,
        "upstreamKey": cache_key,
        "model": settings["model"],
        "fps": settings["fps"],
        "maxOutputTokens": settings["max_output_tokens"],
        "temperature": settings["temperature"],
    }
    encoded = json.dumps(material, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def resolve_runtime_path(data_root: Path, value: str) -> Path:
    root = capability_root(data_root).resolve()
    candidate = Path(value).expanduser()
    if candidate.is_absolute():
        raise VideoError("config_invalid", "video.cache_dir 必须是软件数据目录内的相对路径")
    resolved = (root / candidate).resolve()
    if not is_inside(root, resolved):
        raise VideoError("config_invalid", "video.cache_dir 必须位于 Suzu Lives 软件数据目录内")
    return resolved


def runtime_temp_dir(data_root: Path) -> Path:
    destination = (capability_root(data_root) / "runtime").resolve()
    root = capability_root(data_root).resolve()
    if not is_inside(root, destination):
        raise VideoError("runtime_path_invalid", "视频理解运行目录必须位于 Suzu Lives 软件数据目录内")
    destination.mkdir(parents=True, exist_ok=True)
    return destination


def retained_clip_path(data_root: Path, digest: str) -> Path:
    root = capability_root(data_root).resolve()
    destination = (root / "clips" / f"{digest}.mp4").resolve()
    if not is_inside(root, destination):
        raise VideoError("runtime_path_invalid", "保留的视频片段必须位于 Suzu Lives 软件数据目录内")
    return destination


def read_cached(path: Path) -> dict[str, Any] | None:
    if not path.is_file():
        return None
    try:
        with path.open("r", encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(data, dict) or data.get("status") != "ok":
        return None
    data["cached"] = True
    return data


def write_json_atomic(path: Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    with temporary.open("w", encoding="utf-8", newline="\n") as handle:
        json.dump(data, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
    temporary.replace(path)


def content_piece(value: Any) -> str:
    if isinstance(value, str):
        return value
    if not isinstance(value, list):
        return ""
    pieces: list[str] = []
    for item in value:
        if isinstance(item, dict) and isinstance(item.get("text"), str):
            pieces.append(item["text"])
    return "".join(pieces)


def parse_stream_line(line: str, text_parts: list[str], state: dict[str, Any]) -> bool:
    stripped = line.strip()
    if not stripped or stripped.startswith(":"):
        return False
    if not stripped.startswith("data:"):
        return False
    data = stripped[5:].strip()
    if data == "[DONE]":
        return True
    try:
        chunk = json.loads(data)
    except json.JSONDecodeError as exc:
        raise VideoError("api_response_invalid", f"API 流中出现无效 JSON：{exc}") from exc
    if not isinstance(chunk, dict):
        return False

    if chunk.get("id"):
        state["requestId"] = chunk["id"]
    if chunk.get("model"):
        state["responseModel"] = chunk["model"]
    if isinstance(chunk.get("usage"), dict):
        state["usage"] = chunk["usage"]

    choices = chunk.get("choices")
    if isinstance(choices, list):
        for choice in choices:
            if not isinstance(choice, dict):
                continue
            delta = choice.get("delta")
            if isinstance(delta, dict):
                piece = content_piece(delta.get("content"))
                if piece:
                    text_parts.append(piece)
    return False


def parse_non_stream_response(raw: str, state: dict[str, Any]) -> str:
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise VideoError("api_response_invalid", f"API 返回的不是有效 JSON 或 SSE：{exc}") from exc
    if not isinstance(parsed, dict):
        raise VideoError("api_response_invalid", "API 返回的 JSON 顶层不是对象")
    if isinstance(parsed.get("usage"), dict):
        state["usage"] = parsed["usage"]
    state["requestId"] = parsed.get("id", "")
    state["responseModel"] = parsed.get("model", "")
    try:
        return content_piece(parsed["choices"][0]["message"]["content"]).strip()
    except (KeyError, IndexError, TypeError) as exc:
        raise VideoError("api_response_invalid", "API 返回中缺少回复内容") from exc


def call_video_api(settings: dict[str, Any], clip: Path, prompt: str) -> tuple[str, dict[str, Any]]:
    encoded = base64.b64encode(clip.read_bytes()).decode("ascii")
    if len(encoded) >= 10_000_000:
        raise VideoError(
            "clip_too_large",
            f"Base64 编码后有 {len(encoded)} 字节，超过百炼 10 MB 限制",
        )

    payload = {
        "model": settings["model"],
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {
                "role": "user",
                "content": [
                    {
                        "type": "video_url",
                        "video_url": {"url": f"data:video/mp4;base64,{encoded}"},
                        "fps": settings["fps"],
                    },
                    {"type": "text", "text": prompt},
                ],
            },
        ],
        "modalities": ["text"],
        "stream": True,
        "stream_options": {"include_usage": True},
        "temperature": settings["temperature"],
        "max_tokens": settings["max_output_tokens"],
    }

    request = urllib.request.Request(
        endpoint_from_base_url(settings["base_url"]),
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {settings['api_key']}",
            "Content-Type": "application/json",
            "Accept": "text/event-stream",
            "User-Agent": "suzu-lives-video-understanding/1.0",
        },
        method="POST",
    )

    text_parts: list[str] = []
    state: dict[str, Any] = {"requestId": "", "responseModel": "", "usage": {}}
    fallback_lines: list[str] = []
    try:
        with urllib.request.urlopen(request, timeout=settings["timeout_seconds"]) as response:
            for raw_line in response:
                line = raw_line.decode("utf-8", errors="replace")
                if line.lstrip().startswith("data:"):
                    if parse_stream_line(line, text_parts, state):
                        break
                elif line.strip():
                    fallback_lines.append(line)
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", errors="replace")
        try:
            parsed = json.loads(raw)
            message = parsed.get("error", {}).get("message") or parsed.get("message") or raw
        except json.JSONDecodeError:
            message = raw or str(exc)
        raise VideoApiError(exc.code, str(message).strip()) from exc
    except urllib.error.URLError as exc:
        raise VideoError("api_unreachable", f"连接视频理解 API 失败：{exc.reason}") from exc
    except TimeoutError as exc:
        raise VideoError("api_timeout", "视频理解 API 请求超时") from exc

    summary = "".join(text_parts).strip()
    if not summary and fallback_lines:
        summary = parse_non_stream_response("".join(fallback_lines), state)
    if not summary:
        raise VideoError("api_response_empty", "视频理解 API 返回了空文本")
    return summary, state


def usage_event(
    settings: dict[str, Any],
    response_model: str,
    api_state: dict[str, Any],
    duration: float,
    clip_bytes: int,
) -> dict[str, Any]:
    return {
        "provider": "阿里云百炼" if "aliyuncs.com" in settings["base_url"] else "OpenAI Compatible",
        "model": response_model,
        "source": "视频理解",
        "feature": "video-understanding",
        "requestId": api_state["requestId"],
        "usage": api_state["usage"],
        "metadata": {
            "durationSeconds": round(duration, 3),
            "fps": settings["fps"],
            "preparedVideoBytes": clip_bytes,
        },
    }


def print_json(data: dict[str, Any], stream: Any = sys.stdout) -> None:
    print(json.dumps(data, ensure_ascii=False, indent=2), file=stream)


def emit_event(value: dict[str, Any]) -> None:
    print(json.dumps(value, ensure_ascii=False), flush=True)


def emit_result(args: argparse.Namespace, result: dict[str, Any]) -> None:
    if args.event_stream:
        emit_event({"type": "result", "result": result})
    else:
        print_json(result)


def main() -> int:
    args = parse_args()
    try:
        data_root = Path(args.data_root).expanduser().resolve()
        config_path = resolve_config_path(data_root, args.config)
        settings = load_settings(config_path, require_api_key=not args.dry_run)
        ensure_command(settings["ffmpeg_path"], "ffmpeg")
        ensure_command(settings["ffprobe_path"], "ffprobe")

        source, source_label = source_for_tools(args.video)
        duration = probe_duration(source, settings["ffprobe_path"])
        question = (args.question or DEFAULT_QUESTION).strip() or DEFAULT_QUESTION
        prompt = build_prompt(question, duration)

        with tempfile.TemporaryDirectory(prefix="suzu-video-", dir=runtime_temp_dir(data_root)) as temp:
            clip = Path(temp) / "segment.mp4"
            clip_bytes, transcode = prepare_clip(source, clip, settings)
            clip_sha256 = sha256_file(clip)
            digest = make_cache_digest(clip_sha256, question, args.cache_key or "", settings)
            cache_dir = resolve_runtime_path(data_root, settings["cache_dir"])
            cache_path = cache_dir / f"{digest}.json"
            clip_path = ""

            if args.keep_clip:
                kept = retained_clip_path(data_root, digest)
                kept.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(clip, kept)
                clip_path = str(kept)

            base_result: dict[str, Any] = {
                "source": source_label,
                "model": settings["model"],
                "durationSeconds": round(duration, 3),
                "fps": settings["fps"],
                "preparedVideoBytes": clip_bytes,
                "clipSha256": clip_sha256,
                "cacheKey": digest,
                "keptClipPath": clip_path,
            }

            if args.dry_run:
                emit_result(args, {
                    "status": "dry-run",
                    **base_result,
                    "base64Bytes": 4 * ((clip_bytes + 2) // 3),
                    "transcode": transcode,
                    "cached": False,
                })
                return 0

            use_cache = settings["cache_enabled"] and not args.no_cache
            if use_cache:
                cached = read_cached(cache_path)
                if cached is not None:
                    if clip_path:
                        cached["keptClipPath"] = clip_path
                    emit_result(args, cached)
                    return 0

            summary, api_state = call_video_api(settings, clip, prompt)
            response_model = api_state["responseModel"] or settings["model"]
            event = usage_event(settings, response_model, api_state, duration, clip_bytes)
            if args.event_stream:
                emit_event({"type": "usage", "event": event})
            result = {
                "status": "ok",
                **base_result,
                "summary": summary,
                "cached": False,
                "usage": api_state["usage"],
                "requestId": api_state["requestId"],
                "responseModel": response_model,
            }
            if use_cache:
                write_json_atomic(cache_path, result)
            emit_result(args, result)
            return 0
    except VideoApiError as exc:
        print_json({"status": "error", "code": exc.code, "httpStatus": exc.status, "message": exc.message}, sys.stderr)
        return 5
    except VideoError as exc:
        print_json({"status": "error", "code": exc.code, "message": exc.message}, sys.stderr)
        return 4
    except KeyboardInterrupt:
        print_json({"status": "error", "code": "cancelled", "message": "操作已取消"}, sys.stderr)
        return 130
    except Exception as exc:
        print_json({"status": "error", "code": "unexpected_error", "message": str(exc)}, sys.stderr)
        return 10


if __name__ == "__main__":
    raise SystemExit(main())
