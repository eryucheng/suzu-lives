from __future__ import annotations

import argparse
import smtplib
import sys
from email.message import EmailMessage
from pathlib import Path
from typing import Any

from receive_from_iphone import (
    DEFAULT_CONFIG_PATH,
    configure_console,
    get_mail_password,
    load_json,
    require_text,
)


def send_command(config: dict[str, Any], subject: str, content: str) -> None:
    mail = config.get("mail")
    if not isinstance(mail, dict):
        raise RuntimeError("缺少 mail 配置")

    host = require_text(mail.get("smtpHost"), "mail.smtpHost")
    port = int(mail.get("smtpPort", 465))
    username = require_text(mail.get("username"), "mail.username")
    password = get_mail_password(mail)
    recipient = require_text(
        mail.get("commandRecipient") or username,
        "mail.commandRecipient",
    )

    message = EmailMessage()
    message["From"] = username
    message["To"] = recipient
    message["Subject"] = subject
    message.set_content(content, charset="utf-8")

    try:
        with smtplib.SMTP_SSL(host, port, timeout=30) as server:
            server.login(username, password)
            server.send_message(message)
    except (OSError, smtplib.SMTPException) as exc:
        raise RuntimeError(f"发送邮件失败：{exc}") from exc

    print(f"已发送：主题={subject}，内容={content or '<空>'}")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="通过邮件请求 iPhone 快捷指令执行操作")
    parser.add_argument("subject", help="邮件主题，例如：闹钟、查岗")
    parser.add_argument("content", nargs="?", default="", help="邮件正文，可留空")
    parser.add_argument(
        "--config",
        type=Path,
        default=DEFAULT_CONFIG_PATH,
        help="配置文件路径",
    )
    return parser.parse_args()


def main() -> int:
    configure_console()
    args = parse_args()
    config = load_json(args.config.expanduser().resolve())
    subject = require_text(args.subject, "subject")
    send_command(config, subject, args.content)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except RuntimeError as exc:
        configure_console()
        print(f"错误：{exc}", file=sys.stderr)
        raise SystemExit(1)
