from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path


DEFAULT_ACTIVE_SECONDS = 10.0
DEFAULT_WARMUP_SECONDS = 0.8
LAUNCH_WAIT_SECONDS = 4.0

PROJECT_ROOT = Path(__file__).resolve().parents[3]
OUTPUT_DIR = PROJECT_ROOT / "output" / "computer-camera"
RUNTIME_DIR = OUTPUT_DIR / "runtime"


def write_json(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(f"{path.suffix}.{os.getpid()}.tmp")
    temporary.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    os.replace(temporary, path)


def read_json(path: Path) -> dict | None:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return None


def emit(payload: dict) -> None:
    print(json.dumps(payload, ensure_ascii=False, indent=2))


def start_notice() -> None:
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

    flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    try:
        subprocess.Popen(
            [
                "powershell.exe",
                "-NoProfile",
                "-WindowStyle",
                "Hidden",
                "-Command",
                script,
            ],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            creationflags=flags,
            close_fds=True,
        )
    except OSError:
        # 摄像头仍可工作；提示窗失败不应让拍照本身失败。
        pass


def save_frame(cv2, frame, output_path: Path) -> None:
    encoded, buffer = cv2.imencode(".jpg", frame)
    if not encoded:
        raise RuntimeError("无法把摄像头画面编码为 JPEG")
    output_path.parent.mkdir(parents=True, exist_ok=True)
    buffer.tofile(str(output_path))


def run_worker(args: argparse.Namespace) -> int:
    output_path = Path(args.output).resolve()
    status_path = Path(args.status_file).resolve()
    captured = False
    camera = None

    try:
        import cv2
    except ImportError:
        write_json(
            status_path,
            {
                "status": "error",
                "error": "缺少 opencv-python，请先运行 pip install opencv-python",
            },
        )
        return 1

    started_at = datetime.now().astimezone()

    try:
        camera = cv2.VideoCapture(args.camera_index)
        if not camera.isOpened():
            raise RuntimeError(f"无法打开摄像头 {args.camera_index}")

        start_notice()
        start = time.monotonic()
        deadline = start + args.active_seconds
        last_frame = None

        while time.monotonic() < deadline:
            ok, frame = camera.read()
            if ok:
                last_frame = frame
                if not captured and time.monotonic() - start >= args.warmup_seconds:
                    save_frame(cv2, frame, output_path)
                    captured = True
                    write_json(
                        status_path,
                        {
                            "status": "captured",
                            "outputPath": str(output_path),
                            "cameraActive": True,
                            "activeSeconds": args.active_seconds,
                            "startedAt": started_at.isoformat(),
                        },
                    )
            time.sleep(0.03)

        if not captured and last_frame is not None:
            save_frame(cv2, last_frame, output_path)
            captured = True

        if not captured:
            raise RuntimeError("摄像头已打开，但没有读取到有效画面")

    except Exception as error:
        write_json(
            status_path,
            {
                "status": "error",
                "error": str(error),
                "outputPath": str(output_path),
            },
        )
        return 1
    finally:
        if camera is not None:
            camera.release()

    write_json(
        status_path,
        {
            "status": "closed",
            "outputPath": str(output_path),
            "cameraActive": False,
            "activeSeconds": args.active_seconds,
            "startedAt": started_at.isoformat(),
            "closedAt": datetime.now().astimezone().isoformat(),
        },
    )
    return 0


def detached_process_kwargs() -> dict:
    if os.name == "nt":
        return {
            "creationflags": (
                getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
                | getattr(subprocess, "DETACHED_PROCESS", 0)
                | getattr(subprocess, "CREATE_NO_WINDOW", 0)
            ),
            "close_fds": True,
        }
    return {
        "start_new_session": True,
        "close_fds": True,
    }


def launch_capture(args: argparse.Namespace) -> int:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    RUNTIME_DIR.mkdir(parents=True, exist_ok=True)

    stamp = datetime.now().astimezone().strftime("%Y%m%d-%H%M%S-%f")[:-3]
    output_path = OUTPUT_DIR / f"capture-{stamp}.jpg"
    status_path = RUNTIME_DIR / f"capture-{stamp}.json"

    command = [
        sys.executable,
        str(Path(__file__).resolve()),
        "--worker",
        "--output",
        str(output_path),
        "--status-file",
        str(status_path),
        "--camera-index",
        str(args.camera_index),
        "--active-seconds",
        str(args.active_seconds),
        "--warmup-seconds",
        str(args.warmup_seconds),
    ]

    subprocess.Popen(
        command,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        **detached_process_kwargs(),
    )

    wait_deadline = time.monotonic() + LAUNCH_WAIT_SECONDS
    status = None
    while time.monotonic() < wait_deadline:
        status = read_json(status_path)
        if status and status.get("status") in {"captured", "closed", "error"}:
            break
        time.sleep(0.08)

    if status and status.get("status") == "error":
        emit(status)
        return 1

    ready = output_path.is_file()
    emit(
        {
            "status": "captured" if ready else "started",
            "ready": ready,
            "outputPath": str(output_path),
            "cameraActiveSeconds": args.active_seconds,
            "background": True,
            "noticeVisible": True,
            "note": (
                f"照片已经写好；摄像头将在后台满 {args.active_seconds:g} 秒后自动关闭，本机提示会一直保留到用户确认。"
                if ready
                else "后台摄像头已经启动，但照片尚未在等待时间内写好。"
            ),
        },
    )
    return 0 if ready else 2


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="拍摄电脑摄像头画面，在后台保持摄像头约 10 秒，并保留本机提示直到用户确认。",
    )
    parser.add_argument("--camera-index", type=int, default=0, help="摄像头编号，默认 0")
    parser.add_argument(
        "--active-seconds",
        type=float,
        default=DEFAULT_ACTIVE_SECONDS,
        help=argparse.SUPPRESS,
    )
    parser.add_argument(
        "--warmup-seconds",
        type=float,
        default=DEFAULT_WARMUP_SECONDS,
        help=argparse.SUPPRESS,
    )
    parser.add_argument("--worker", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--output", default="", help=argparse.SUPPRESS)
    parser.add_argument("--status-file", default="", help=argparse.SUPPRESS)
    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    if args.worker:
        if not args.output or not args.status_file:
            parser.error("--worker 需要 --output 和 --status-file")
        return run_worker(args)
    return launch_capture(args)


if __name__ == "__main__":
    raise SystemExit(main())
