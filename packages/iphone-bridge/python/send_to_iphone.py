from __future__ import annotations

import argparse
import json
import os
import smtplib
import sys
from email.header import Header
from email.mime.text import MIMEText
from pathlib import Path
from typing import Any


def load_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8-sig"))
    except FileNotFoundError as exc:
        raise RuntimeError(f"找不到 iPhone 固定配置文件：{path}") from exc
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"iPhone 固定配置文件不是有效 JSON：{path}") from exc
    if not isinstance(value, dict):
        raise RuntimeError("iPhone 固定配置文件根节点必须是对象")
    return value


def required(value: Any, label: str) -> str:
    text = str(value or "").strip()
    if not text:
        raise RuntimeError(f"缺少 iPhone 发信配置：{label}")
    return text


def password(value: dict[str, Any], mail: dict[str, Any]) -> str:
    for container in (value, mail):
        direct = str(container.get("password") or "").strip()
        if direct:
            return direct
        env_name = str(container.get("passwordEnv") or "").strip()
        if env_name and os.environ.get(env_name, "").strip():
            return os.environ[env_name].strip()
    return os.environ.get("SUZU_EMAIL_PASSWORD", "").strip()


def outbound_settings(config: dict[str, Any]) -> tuple[str, int, str, str, str]:
    mail = config.get("mail") if isinstance(config.get("mail"), dict) else {}
    outbound = config.get("outbound") if isinstance(config.get("outbound"), dict) else {}
    host = str(outbound.get("smtpHost") or mail.get("smtpHost") or "smtp.163.com").strip()
    port = int(outbound.get("smtpPort") or mail.get("smtpPort") or 465)
    sender = str(outbound.get("sender") or mail.get("username") or os.environ.get("SUZU_IPHONE_SENDER", "")).strip()
    recipient = str(outbound.get("recipient") or os.environ.get("SUZU_IPHONE_RECEIVER", "")).strip()
    return required(host, "smtpHost"), port, required(sender, "sender"), required(recipient, "recipient"), required(password(outbound, mail), "password 或 passwordEnv")


def main() -> int:
    parser = argparse.ArgumentParser(description="通过已配置的 iPhone 邮件自动化发送请求")
    parser.add_argument("subject")
    parser.add_argument("content")
    parser.add_argument("--config", type=Path, required=True, help="Suzu Lives 统一 iPhone 配置")
    args = parser.parse_args()
    config = load_json(args.config.expanduser().resolve())
    host, port, sender, recipient, secret = outbound_settings(config)
    message = MIMEText(args.content, "plain", "utf-8")
    message["Subject"] = Header(args.subject, "utf-8")
    message["From"] = sender
    message["To"] = recipient
    with smtplib.SMTP_SSL(host, port, timeout=30) as server:
        server.login(sender, secret)
        server.sendmail(sender, [recipient], message.as_string())
    print("已发送")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except RuntimeError as error:
        print(f"IPHONE_ERROR: {error}", file=sys.stderr)
        raise SystemExit(1)
