"""Suzu Lives-owned persistent OpenCV camera worker.

The Node control plane starts this worker only after a verified one-time
authorization.  The worker preheats a single camera, keeps it open for the
session lifetime, accepts capture/close commands on stdin, and writes only the
explicit Suzu Lives data-root paths it receives. It never reads external state.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(temporary, path)


def emit(payload: dict[str, Any]) -> None:
    print(json.dumps(payload, ensure_ascii=False), flush=True)


def read_command() -> dict[str, Any] | None:
    line = sys.stdin.readline()
    if not line:
        return None
    try:
        value = json.loads(line)
    except json.JSONDecodeError:
        emit({"status": "error", "error": "命令不是有效 JSON"})
        return {}
    return value if isinstance(value, dict) else {}


def capture_frame(camera, output: Path, fallback_frame) -> tuple[bool, str]:
    ok, frame = camera.read()
    if not ok:
        frame = fallback_frame
    if frame is None:
        return False, "摄像头没有读取到有效画面"
    encoded, buffer = __import__("cv2").imencode(".jpg", frame)
    if not encoded:
        return False, "无法把摄像头画面编码为 JPEG"
    output.parent.mkdir(parents=True, exist_ok=True)
    buffer.tofile(str(output))
    return True, ""


def run_session(args: argparse.Namespace) -> int:
    status = Path(args.status_file).resolve()
    camera = None
    try:
        try:
            import cv2
        except ImportError:
            raise RuntimeError("缺少 opencv-python")
        write_json(status, {"status": "starting", "cameraIndex": args.camera_index, "startedAt": now_iso()})
        camera = cv2.VideoCapture(args.camera_index)
        if not camera.isOpened():
            raise RuntimeError(f"无法打开摄像头 {args.camera_index}")
        started = time.monotonic()
        deadline = started + args.warmup_seconds
        no_frame_deadline = started + max(10.0, args.warmup_seconds + 10.0)
        latest_frame = None
        while time.monotonic() < deadline or latest_frame is None:
            ok, frame = camera.read()
            if ok:
                latest_frame = frame
            if latest_frame is None and time.monotonic() >= no_frame_deadline:
                raise RuntimeError("摄像头预热期间没有读取到有效画面")
            if latest_frame is None:
                time.sleep(0.03)
            elif time.monotonic() < deadline:
                time.sleep(0.03)
        ready_at = now_iso()
        write_json(status, {"status": "ready", "cameraIndex": args.camera_index, "warmedAt": ready_at})
        emit({"status": "ready", "cameraIndex": args.camera_index, "warmedAt": ready_at})

        while True:
            command = read_command()
            if command is None:
                write_json(status, {"status": "closed", "cameraIndex": args.camera_index, "closedAt": now_iso(), "reason": "stdin-closed"})
                return 0
            if not command:
                continue
            command_id = str(command.get("id") or "")
            action = str(command.get("command") or "").strip().lower()
            if action == "capture":
                output_value = command.get("outputPath")
                if not isinstance(output_value, str) or not output_value.strip():
                    emit({"id": command_id, "status": "error", "error": "capture 缺少 outputPath"})
                    continue
                output = Path(output_value).resolve()
                try:
                    captured, error = capture_frame(camera, output, latest_frame)
                    if not captured:
                        raise RuntimeError(error)
                    write_json(status, {"status": "captured", "cameraIndex": args.camera_index, "outputPath": str(output), "capturedAt": now_iso()})
                    emit({"id": command_id, "status": "captured", "outputPath": str(output)})
                except Exception as error:
                    emit({"id": command_id, "status": "error", "error": str(error)})
                continue
            if action == "close":
                write_json(status, {"status": "closing", "cameraIndex": args.camera_index, "closeRequestedAt": now_iso()})
                if camera is not None:
                    camera.release()
                    camera = None
                closed_at = now_iso()
                write_json(status, {"status": "closed", "cameraIndex": args.camera_index, "closedAt": closed_at, "userConfirmedClose": True})
                emit({"id": command_id, "status": "closed", "closedAt": closed_at})
                return 0
            emit({"id": command_id, "status": "error", "error": "未知摄像头命令"})
    except Exception as error:
        write_json(status, {"status": "failed", "cameraIndex": args.camera_index, "failedAt": now_iso(), "error": str(error)})
        emit({"status": "error", "error": str(error)})
        return 1
    finally:
        if camera is not None:
            camera.release()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--session", action="store_true", required=True)
    parser.add_argument("--status-file", required=True)
    parser.add_argument("--camera-index", type=int, default=0)
    parser.add_argument("--warmup-seconds", type=float, default=0.8)
    args = parser.parse_args()
    if args.camera_index < 0 or args.camera_index > 32:
        parser.error("camera-index 必须在 0 到 32 之间")
    if args.warmup_seconds < 0 or args.warmup_seconds > 30:
        parser.error("warmup-seconds 必须在 0 到 30 之间")
    return run_session(args)


if __name__ == "__main__":
    raise SystemExit(main())
