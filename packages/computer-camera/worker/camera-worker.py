#!/usr/bin/env python3
"""Software-owned, detached one-shot OpenCV computer-camera worker.

The package launcher supplies software-data-root output and status paths. This
worker never reads a contact project, external configuration, or external service.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path
from typing import Any, Callable


def now_iso() -> str:
    return datetime.now().astimezone().isoformat()


def write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(f"{path.suffix}.{os.getpid()}.tmp")
    temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(temporary, path)


def start_notice() -> None:
    """Keep the local warning visible until the person confirms it."""
    if os.name != "nt":
        return
    script = """
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$form = New-Object System.Windows.Forms.Form
$form.Text = '警告'
$form.TopMost = $true
$form.Width = 340
$form.Height = 155
$form.StartPosition = 'CenterScreen'
$form.FormBorderStyle = 'FixedDialog'
$form.ControlBox = $false
$form.MaximizeBox = $false
$form.MinimizeBox = $false
$label = New-Object System.Windows.Forms.Label
$label.AutoSize = $false
$label.Width = 300
$label.Height = 45
$label.Left = 12
$label.Top = 18
$label.TextAlign = 'MiddleCenter'
$label.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 11)
$label.Text = '警告：摄像头已开启'
$form.Controls.Add($label)
$button = New-Object System.Windows.Forms.Button
$button.Text = '确定'
$button.Width = 90
$button.Height = 30
$button.Left = 116
$button.Top = 72
$button.DialogResult = [System.Windows.Forms.DialogResult]::OK
$form.Controls.Add($button)
$form.AcceptButton = $button
$form.Add_Shown({ $form.Activate() })
[void]$form.ShowDialog()
"""
    try:
        subprocess.Popen(["powershell.exe", "-NoProfile", "-WindowStyle", "Hidden", "-Command", script], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0), close_fds=True)
    except OSError:
        # A notice failure must not conceal an otherwise available real camera.
        pass


def load_cv2():
    import cv2
    return cv2


def save_frame(cv2, frame, output_path: Path) -> None:
    encoded, buffer = cv2.imencode(".jpg", frame)
    if not encoded:
        raise RuntimeError("无法把摄像头画面编码为 JPEG")
    output_path.parent.mkdir(parents=True, exist_ok=True)
    buffer.tofile(str(output_path))


def run_worker(
    args: argparse.Namespace,
    *,
    cv2_loader: Callable[[], Any] = load_cv2,
    clock: Callable[[], float] = time.monotonic,
    sleep: Callable[[float], None] = time.sleep,
    timestamp: Callable[[], str] = now_iso,
    notice: Callable[[], None] = start_notice,
) -> int:
    output_path = Path(args.output).resolve()
    status_path = Path(args.status_file).resolve()
    captured = False
    camera = None
    try:
        try:
            cv2 = cv2_loader()
        except ImportError:
            write_json(status_path, {"status": "error", "error": "缺少 opencv-python，请先运行 pip install opencv-python"})
            return 1
        started_at = timestamp()
        camera = cv2.VideoCapture(args.camera_index)
        if not camera.isOpened():
            raise RuntimeError(f"无法打开摄像头 {args.camera_index}")
        notice()
        started = clock()
        deadline = started + args.active_seconds
        last_frame = None
        while clock() < deadline:
            ok, frame = camera.read()
            if ok:
                last_frame = frame
                if not captured and clock() - started >= args.warmup_seconds:
                    save_frame(cv2, frame, output_path)
                    captured = True
                    write_json(status_path, {"status": "captured", "outputPath": str(output_path), "cameraActive": True, "activeSeconds": args.active_seconds, "startedAt": started_at})
            sleep(0.03)
        if not captured and last_frame is not None:
            save_frame(cv2, last_frame, output_path)
            captured = True
        if not captured:
            raise RuntimeError("摄像头已打开，但没有读取到有效画面")
    except Exception as error:
        write_json(status_path, {"status": "error", "error": str(error), "outputPath": str(output_path)})
        return 1
    finally:
        if camera is not None:
            camera.release()
    write_json(status_path, {"status": "closed", "outputPath": str(output_path), "cameraActive": False, "activeSeconds": args.active_seconds, "startedAt": started_at, "closedAt": timestamp()})
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="后台拍摄电脑摄像头画面并自动释放摄像头。")
    parser.add_argument("--worker", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--output", default="", help=argparse.SUPPRESS)
    parser.add_argument("--status-file", default="", help=argparse.SUPPRESS)
    parser.add_argument("--camera-index", type=int, default=0)
    parser.add_argument("--active-seconds", type=float, default=10.0, help=argparse.SUPPRESS)
    parser.add_argument("--warmup-seconds", type=float, default=0.8, help=argparse.SUPPRESS)
    args = parser.parse_args()
    if not args.worker or not args.output or not args.status_file:
        parser.error("--worker 需要 --output 和 --status-file")
    return run_worker(args)


if __name__ == "__main__":
    raise SystemExit(main())
