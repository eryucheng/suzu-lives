#!/usr/bin/env python3

import argparse
import json
import os
import subprocess
import sys
import time
import urllib.request
from pathlib import Path


if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")


HERE = Path(__file__).resolve().parent
RUNTIME_DIR = HERE / "runtime"
PROFILE_DIR = RUNTIME_DIR / "chrome-profile"
DEBUG_HOST = "127.0.0.1"
DEBUG_PORT = 9222
VERSION_URL = f"http://{DEBUG_HOST}:{DEBUG_PORT}/json/version"


def output(value):
    print(json.dumps(value, ensure_ascii=False, indent=2))


def chrome_candidates():
    configured = os.environ.get("CHROME_PATH", "").strip()
    if configured:
        yield Path(configured)

    locations = (
        (os.environ.get("PROGRAMFILES", ""), "Google/Chrome/Application/chrome.exe"),
        (os.environ.get("PROGRAMFILES(X86)", ""), "Google/Chrome/Application/chrome.exe"),
        (os.environ.get("LOCALAPPDATA", ""), "Google/Chrome/Application/chrome.exe"),
    )
    for base, suffix in locations:
        if base:
            yield Path(base) / suffix


def find_chrome():
    for candidate in chrome_candidates():
        if candidate.is_file():
            return candidate.resolve()
    raise RuntimeError(
        "没有找到 Google Chrome。请安装 Chrome，或设置环境变量 CHROME_PATH 指向 chrome.exe"
    )


def debug_info(timeout=0.8):
    try:
        with urllib.request.urlopen(VERSION_URL, timeout=timeout) as response:
            value = json.loads(response.read().decode("utf-8"))
        if not value.get("webSocketDebuggerUrl"):
            return None
        return value
    except Exception:
        return None


def start_chrome(chrome_path):
    PROFILE_DIR.mkdir(parents=True, exist_ok=True)
    command = [
        str(chrome_path),
        f"--remote-debugging-port={DEBUG_PORT}",
        f"--remote-debugging-address={DEBUG_HOST}",
        f"--user-data-dir={PROFILE_DIR}",
        "--no-first-run",
        "--no-default-browser-check",
        "--new-window",
        "about:blank",
    ]
    kwargs = {
        "stdin": subprocess.DEVNULL,
        "stdout": subprocess.DEVNULL,
        "stderr": subprocess.DEVNULL,
        "close_fds": True,
    }
    if os.name == "nt":
        kwargs["creationflags"] = (
            subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.DETACHED_PROCESS
        )
    subprocess.Popen(command, **kwargs)


def run(check_only=False):
    current = debug_info()
    if current:
        output({
            "status": "ready",
            "browser": current.get("Browser"),
            "endpoint": f"http://{DEBUG_HOST}:{DEBUG_PORT}",
            "profilePath": str(PROFILE_DIR),
        })
        return 0

    if check_only:
        output({
            "status": "not-running",
            "endpoint": f"http://{DEBUG_HOST}:{DEBUG_PORT}",
        })
        return 1

    chrome_path = find_chrome()
    start_chrome(chrome_path)
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        time.sleep(0.25)
        current = debug_info()
        if current:
            output({
                "status": "started",
                "browser": current.get("Browser"),
                "endpoint": f"http://{DEBUG_HOST}:{DEBUG_PORT}",
                "chromePath": str(chrome_path),
                "profilePath": str(PROFILE_DIR),
                "message": "第一次使用时，请在这个Chrome窗口中手动登录所需网站",
            })
            return 0
    raise RuntimeError(
        f"Chrome 已启动，但 {VERSION_URL} 在15秒内没有响应；请检查9222端口是否被占用"
    )


def main():
    parser = argparse.ArgumentParser(description="启动或检查Agent专用Chrome")
    parser.add_argument("--check", action="store_true", help="只检查，不启动Chrome")
    args = parser.parse_args()
    try:
        return run(args.check)
    except Exception as error:
        output({"status": "error", "error": str(error)})
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
