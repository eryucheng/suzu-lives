from __future__ import annotations

import argparse
import html
import imaplib
import json
import mimetypes
import os
import re
import select
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime
from email import policy
from email.header import decode_header, make_header
from email.parser import BytesParser
from email.utils import parseaddr, parsedate_to_datetime
from pathlib import Path
from typing import Any


SCRIPT_DIR = Path(__file__).resolve().parent
DEFAULT_CONFIG_PATH = SCRIPT_DIR / "feedback_config.json"
DEFAULT_STATE_PATH = SCRIPT_DIR / "feedback_state.json"
DEFAULT_INBOX_PATH = SCRIPT_DIR / "runtime" / "inbox"

DEFAULT_ALLOWED_IMAGE_TYPES = {
    "image/gif",
    "image/heic",
    "image/heif",
    "image/jpeg",
    "image/png",
    "image/webp",
}
DEFAULT_ALLOWED_IMAGE_EXTENSIONS = {
    ".gif",
    ".heic",
    ".heif",
    ".jpeg",
    ".jpg",
    ".png",
    ".webp",
}


def configure_console() -> None:
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure:
            reconfigure(encoding="utf-8", errors="replace")


def load_json(path: Path) -> dict[str, Any]:
    try:
        data = json.loads(path.read_text(encoding="utf-8-sig"))
    except FileNotFoundError as exc:
        raise RuntimeError(f"找不到配置文件：{path}") from exc
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"配置文件不是有效 JSON：{path}（{exc}）") from exc
    if not isinstance(data, dict):
        raise RuntimeError("配置文件根节点必须是 JSON 对象")
    return data


def require_text(value: Any, label: str) -> str:
    text = str(value or "").strip()
    if not text:
        raise RuntimeError(f"配置项 {label} 不能为空")
    return text


def validate_config(config: dict[str, Any]) -> None:
    mail = config.get("mail")
    webhook = config.get("webhook")
    routes = config.get("routes")
    if not isinstance(mail, dict):
        raise RuntimeError("缺少 mail 配置")
    if not isinstance(webhook, dict):
        raise RuntimeError("缺少 webhook 配置")
    if not isinstance(routes, list) or not routes:
        raise RuntimeError("routes 至少需要配置一条主题映射")

    require_text(mail.get("imapHost"), "mail.imapHost")
    require_text(mail.get("username"), "mail.username")
    require_text(mail.get("mailbox", "INBOX"), "mail.mailbox")
    allowed = mail.get("allowedSenders")
    if not isinstance(allowed, list) or not any(str(x).strip() for x in allowed):
        raise RuntimeError("mail.allowedSenders 至少需要填写一个允许的发件人")

    require_text(webhook.get("url"), "webhook.url")
    require_text(webhook.get("token"), "webhook.token")
    require_text(webhook.get("project"), "webhook.project")
    require_text(webhook.get("sessionKey"), "webhook.sessionKey")

    seen_subjects: set[str] = set()
    for index, route in enumerate(routes):
        if not isinstance(route, dict):
            raise RuntimeError(f"routes[{index}] 必须是对象")
        if route.get("enabled", True) is False:
            continue
        subject = require_text(route.get("subject"), f"routes[{index}].subject")
        require_text(route.get("promptTemplate"), f"routes[{index}].promptTemplate")
        if subject in seen_subjects:
            raise RuntimeError(f"主题映射重复：{subject}")
        seen_subjects.add(subject)


def get_mail_password(mail_config: dict[str, Any]) -> str:
    configured = str(mail_config.get("password") or "").strip()
    if configured:
        return configured
    env_name = str(mail_config.get("passwordEnv") or "").strip()
    if env_name:
        env_value = os.environ.get(env_name, "").strip()
        if env_value:
            return env_value
    raise RuntimeError("请在 feedback_config.json 的 mail.password 中填写邮箱客户端授权码")


def imap_quote(value: Any) -> str:
    text = str(value or "")
    text = text.encode("ascii", errors="replace").decode("ascii")
    return '"' + text.replace("\\", "\\\\").replace('"', '\\"') + '"'


def send_imap_client_id(
    connection: imaplib.IMAP4_SSL,
    mail_config: dict[str, Any],
) -> None:
    client_id = mail_config.get("clientId")
    if not isinstance(client_id, dict) or client_id.get("enabled", False) is not True:
        return

    values = {
        "name": require_text(client_id.get("name"), "mail.clientId.name"),
        "version": require_text(client_id.get("version"), "mail.clientId.version"),
        "vendor": require_text(client_id.get("vendor"), "mail.clientId.vendor"),
        "support-email": require_text(
            client_id.get("supportEmail"),
            "mail.clientId.supportEmail",
        ),
    }
    arguments = "(" + " ".join(
        f"{imap_quote(key)} {imap_quote(value)}" for key, value in values.items()
    ) + ")"

    imaplib.Commands.setdefault("ID", ("AUTH",))
    status, data = connection._simple_command("ID", arguments)
    if status != "OK":
        raise RuntimeError(f"邮箱服务器拒绝 IMAP ID：{data}")


def load_state(path: Path) -> dict[str, Any] | None:
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError) as exc:
        raise RuntimeError(f"状态文件损坏：{path}（{exc}）") from exc
    if not isinstance(data, dict):
        raise RuntimeError(f"状态文件格式错误：{path}")
    return data


def save_state(path: Path, last_uid: int) -> None:
    data = {
        "lastUid": last_uid,
        "updatedAt": datetime.now().astimezone().isoformat(timespec="seconds"),
    }
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(
        json.dumps(data, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    os.replace(temporary, path)


def connect_mail(config: dict[str, Any]) -> imaplib.IMAP4_SSL:
    mail = config["mail"]
    host = require_text(mail.get("imapHost"), "mail.imapHost")
    port = int(mail.get("imapPort", 993))
    username = require_text(mail.get("username"), "mail.username")
    password = get_mail_password(mail)
    mailbox = require_text(mail.get("mailbox", "INBOX"), "mail.mailbox")

    connection = imaplib.IMAP4_SSL(host, port, timeout=30)
    connection.login(username, password)
    send_imap_client_id(connection, mail)
    refresh_capabilities(connection)
    status, _ = connection.select(mailbox, readonly=True)
    if status != "OK":
        connection.logout()
        raise RuntimeError(f"无法打开邮箱目录：{mailbox}")
    return connection


def latest_uid(connection: imaplib.IMAP4_SSL) -> int:
    status, data = connection.uid("search", None, "ALL")
    if status != "OK" or not data or not data[0]:
        return 0
    values = [int(value) for value in data[0].split() if value.isdigit()]
    return max(values, default=0)


def search_after(connection: imaplib.IMAP4_SSL, last_uid: int) -> list[int]:
    status, data = connection.uid("search", None, "UID", f"{last_uid + 1}:*")
    if status != "OK" or not data or not data[0]:
        return []
    return sorted(
        int(value)
        for value in data[0].split()
        if value.isdigit() and int(value) > last_uid
    )


def fetch_message(connection: imaplib.IMAP4_SSL, uid: int):
    status, data = connection.uid("fetch", str(uid), "(BODY.PEEK[])")
    if status != "OK":
        raise RuntimeError(f"读取邮件失败，UID={uid}")
    for item in data or []:
        if isinstance(item, tuple) and len(item) >= 2 and isinstance(item[1], bytes):
            return BytesParser(policy=policy.default).parsebytes(item[1])
    raise RuntimeError(f"邮件内容为空，UID={uid}")


def decode_subject(value: Any) -> str:
    if not value:
        return ""
    try:
        return str(make_header(decode_header(str(value)))).strip()
    except (LookupError, UnicodeError):
        return str(value).strip()


def html_to_text(value: str) -> str:
    value = re.sub(r"(?is)<(script|style).*?>.*?</\1>", "", value)
    value = re.sub(r"(?i)<br\s*/?>", "\n", value)
    value = re.sub(r"(?i)</p\s*>", "\n", value)
    value = re.sub(r"(?s)<[^>]+>", "", value)
    return html.unescape(value)


def extract_body(message) -> str:
    plain_parts: list[str] = []
    html_parts: list[str] = []
    parts = message.walk() if message.is_multipart() else [message]
    for part in parts:
        if part.is_multipart():
            continue
        disposition = str(part.get_content_disposition() or "").lower()
        if disposition == "attachment":
            continue
        content_type = part.get_content_type().lower()
        if content_type not in {"text/plain", "text/html"}:
            continue
        try:
            content = part.get_content()
        except (LookupError, UnicodeError):
            raw = part.get_payload(decode=True) or b""
            content = raw.decode(part.get_content_charset() or "utf-8", errors="replace")
        if not isinstance(content, str):
            continue
        if content_type == "text/plain":
            plain_parts.append(content)
        else:
            html_parts.append(content)

    value = "\n".join(plain_parts).strip()
    if not value and html_parts:
        value = html_to_text("\n".join(html_parts)).strip()
    value = value.replace("\r\n", "\n").replace("\r", "\n")
    value = re.sub(r"\n{3,}", "\n\n", value)
    return value.strip()


def decode_filename(value: Any) -> str:
    if not value:
        return ""
    try:
        return str(make_header(decode_header(str(value)))).strip()
    except (LookupError, UnicodeError):
        return str(value).strip()


def safe_filename(value: str, fallback: str) -> str:
    name = Path(value.replace("\\", "/")).name.strip() if value else ""
    name = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", name)
    name = name.rstrip(". ")
    return name or fallback


def image_settings(config: dict[str, Any]) -> tuple[Path, int, int, set[str]]:
    raw = config.get("imageAttachments", {})
    if raw is None:
        raw = {}
    if not isinstance(raw, dict):
        raise RuntimeError("配置项 imageAttachments 必须是对象")

    configured_dir = str(raw.get("directory") or "").strip()
    inbox_path = Path(configured_dir).expanduser() if configured_dir else DEFAULT_INBOX_PATH
    if not inbox_path.is_absolute():
        inbox_path = SCRIPT_DIR / inbox_path
    inbox_path = inbox_path.resolve()

    try:
        max_bytes = int(raw.get("maxBytesPerImage", 20 * 1024 * 1024))
        max_images = int(raw.get("maxImagesPerMessage", 5))
    except (TypeError, ValueError) as exc:
        raise RuntimeError("图片附件大小和数量限制必须是整数") from exc
    if max_bytes <= 0 or max_images <= 0:
        raise RuntimeError("图片附件大小和数量限制必须大于 0")

    configured_types = raw.get("allowedTypes")
    if configured_types is None:
        allowed_types = set(DEFAULT_ALLOWED_IMAGE_TYPES)
    elif isinstance(configured_types, list):
        allowed_types = {
            str(value).strip().lower()
            for value in configured_types
            if str(value).strip()
        }
        if not allowed_types:
            raise RuntimeError("imageAttachments.allowedTypes 不能为空列表")
    else:
        raise RuntimeError("imageAttachments.allowedTypes 必须是数组")

    return inbox_path, max_bytes, max_images, allowed_types


def inferred_extension(content_type: str) -> str:
    if content_type == "image/jpeg":
        return ".jpg"
    value = mimetypes.guess_extension(content_type, strict=False) or ""
    return value if value in DEFAULT_ALLOWED_IMAGE_EXTENSIONS else ".img"


def extract_image_attachments(
    message,
    uid: int,
    config: dict[str, Any],
) -> tuple[list[Path], list[str]]:
    inbox_path, max_bytes, max_images, allowed_types = image_settings(config)
    saved: list[Path] = []
    warnings: list[str] = []
    parts = message.walk() if message.is_multipart() else [message]

    for part_index, part in enumerate(parts, start=1):
        if part.is_multipart():
            continue

        content_type = part.get_content_type().lower()
        original_name = decode_filename(part.get_filename())
        extension = Path(original_name).suffix.lower()
        is_image = content_type in allowed_types or (
            content_type == "application/octet-stream"
            and extension in DEFAULT_ALLOWED_IMAGE_EXTENSIONS
        )
        if not is_image:
            continue

        if len(saved) >= max_images:
            warnings.append(f"图片附件超过 {max_images} 张，其余图片未保存")
            break

        raw = part.get_payload(decode=True) or b""
        if not raw:
            warnings.append(f"第 {part_index} 个图片附件内容为空")
            continue
        if len(raw) > max_bytes:
            warnings.append(
                f"图片附件“{original_name or part_index}”超过 "
                f"{max_bytes // (1024 * 1024)} MB，未保存"
            )
            continue

        fallback = f"image-{part_index}{inferred_extension(content_type)}"
        filename = safe_filename(original_name, fallback)
        message_dir = inbox_path / str(uid)
        message_dir.mkdir(parents=True, exist_ok=True)

        # MIME part 序号让文件名保持唯一，同时保证同一 UID 重试时覆盖原文件，
        # 不会因为 Webhook 暂时失败而产生越来越多的图片副本。
        target = message_dir / f"{part_index:02d}-{filename}"
        temporary = target.with_suffix(target.suffix + ".tmp")
        temporary.write_bytes(raw)
        os.replace(temporary, target)
        saved.append(target.resolve())

    return saved, warnings


def image_prompt(image_paths: list[Path], warnings: list[str]) -> str:
    lines: list[str] = []
    if image_paths:
        lines.append(f"手机通过邮件返回了 {len(image_paths)} 张图片：")
        lines.extend(f"- {path}" for path in image_paths)
        lines.append("请使用你的识图能力查看图片后，再结合当前对话正常回应。")
    if warnings:
        lines.append("附件处理提示：")
        lines.extend(f"- {warning}" for warning in warnings)
    return "\n".join(lines).strip()


def received_time(message) -> str:
    raw = message.get("Date")
    if raw:
        try:
            value = parsedate_to_datetime(str(raw))
            if value.tzinfo is not None:
                value = value.astimezone()
            return value.isoformat(timespec="seconds")
        except (TypeError, ValueError, OverflowError):
            pass
    return datetime.now().astimezone().isoformat(timespec="seconds")


def route_map(config: dict[str, Any]) -> dict[str, str]:
    result: dict[str, str] = {}
    for route in config["routes"]:
        if route.get("enabled", True) is False:
            continue
        result[str(route["subject"]).strip()] = str(route["promptTemplate"])
    return result


def render_prompt(template: str, values: dict[str, str]) -> str:
    result = template
    for key, value in values.items():
        result = result.replace("{{" + key + "}}", value)
    unresolved = sorted(set(re.findall(r"{{([A-Za-z][A-Za-z0-9_]*)}}", result)))
    if unresolved:
        raise RuntimeError("提示词模板包含未知变量：" + ", ".join(unresolved))
    return result.strip()


def post_webhook(config: dict[str, Any], prompt: str) -> None:
    webhook = config["webhook"]
    body = {
        "event": "iphone-email-feedback",
        "project": require_text(webhook.get("project"), "webhook.project"),
        "session_key": require_text(webhook.get("sessionKey"), "webhook.sessionKey"),
        "prompt": prompt,
        "silent": bool(webhook.get("silent", True)),
    }
    request = urllib.request.Request(
        require_text(webhook.get("url"), "webhook.url"),
        data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
        headers={
            "Authorization": "Bearer " + require_text(webhook.get("token"), "webhook.token"),
            "Content-Type": "application/json; charset=utf-8",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            status = int(getattr(response, "status", 200))
            response.read()
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"Webhook 返回 HTTP {exc.code}：{detail}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"无法连接 Webhook：{exc.reason}") from exc
    if not 200 <= status < 300:
        raise RuntimeError(f"Webhook 返回异常状态：HTTP {status}")


def webhook_delivery_delay(config: dict[str, Any]) -> float:
    raw = config["webhook"].get("deliveryDelaySeconds", 0)
    try:
        value = float(raw)
    except (TypeError, ValueError) as exc:
        raise RuntimeError("配置项 webhook.deliveryDelaySeconds 必须是数字") from exc
    if value < 0:
        raise RuntimeError("配置项 webhook.deliveryDelaySeconds 不能小于 0")
    return value


def sender_allowed(config: dict[str, Any], sender: str) -> bool:
    allowed = {
        str(value).strip().lower()
        for value in config["mail"].get("allowedSenders", [])
        if str(value).strip()
    }
    return sender.strip().lower() in allowed


def capability_names(connection: imaplib.IMAP4_SSL) -> set[str]:
    return {
        value.decode("ascii", errors="ignore").upper()
        if isinstance(value, bytes)
        else str(value).upper()
        for value in connection.capabilities
    }


def refresh_capabilities(connection: imaplib.IMAP4_SSL) -> None:
    status, data = connection.capability()
    if status != "OK" or not data:
        raise RuntimeError(f"无法读取邮箱服务器能力：{data}")
    connection.capabilities = tuple(
        token
        for line in data
        if isinstance(line, bytes)
        for token in line.upper().split()
    )


def supports_idle(connection: imaplib.IMAP4_SSL) -> bool:
    return "IDLE" in capability_names(connection)


def idle_until_event(connection: imaplib.IMAP4_SSL, timeout: int) -> bool:
    """Wait in IMAP IDLE mode. Return True when the server reports activity."""
    tag = connection._new_tag()
    connection.send(tag + b" IDLE\r\n")
    continuation = connection._get_response()
    if continuation is not None:
        raise RuntimeError(f"邮箱服务器拒绝进入 IDLE：{continuation!r}")

    ready, _, _ = select.select([connection.sock], [], [], timeout)
    has_event = bool(ready)
    if has_event:
        connection._get_response()

    connection.send(b"DONE\r\n")
    status, data = connection._command_complete("IDLE", tag)
    if status != "OK":
        raise RuntimeError(f"邮箱服务器异常结束 IDLE：{data}")
    return has_event


def process_new_messages(
    connection: imaplib.IMAP4_SSL,
    config: dict[str, Any],
    state_path: Path,
    last_uid: int,
) -> int:
    routes = route_map(config)
    max_chars = max(1, int(config.get("maxContentChars", 2000)))
    delivery_delay = webhook_delivery_delay(config)

    for uid in search_after(connection, last_uid):
        try:
            message = fetch_message(connection, uid)
            subject = decode_subject(message.get("Subject"))
            sender = parseaddr(str(message.get("From") or ""))[1].strip().lower()

            if not sender_allowed(config, sender):
                print(f"忽略 UID={uid}：发件人不在允许列表中")
                last_uid = uid
                save_state(state_path, last_uid)
                continue

            template = routes.get(subject)
            if template is None:
                print(f"忽略 UID={uid}：没有配置主题“{subject}”")
                last_uid = uid
                save_state(state_path, last_uid)
                continue

            content = extract_body(message)
            image_paths, image_warnings = extract_image_attachments(message, uid, config)
            if not content and not image_paths and not image_warnings:
                print(f"忽略 UID={uid}：正文和受支持的图片附件均为空")
                last_uid = uid
                save_state(state_path, last_uid)
                continue
            if len(content) > max_chars:
                content = content[:max_chars] + "……"

            timestamp = received_time(message)
            prompt = render_prompt(
                template,
                {
                    "content": content,
                    "subject": subject,
                    "from": sender,
                    "receivedAt": timestamp,
                    "imageCount": str(len(image_paths)),
                    "imagePaths": "\n".join(str(path) for path in image_paths),
                    "attachments": image_prompt(image_paths, image_warnings),
                },
            )
            attachments_prompt = image_prompt(image_paths, image_warnings)
            if attachments_prompt and "{{attachments}}" not in template:
                prompt = "\n\n".join(value for value in (prompt, attachments_prompt) if value)
            if delivery_delay > 0:
                print(
                    f"UID={uid}：等待 {delivery_delay:g} 秒后投递，"
                    "避免撞上 Agent 当前处理轮"
                )
                time.sleep(delivery_delay)
            post_webhook(config, prompt)
            print(f"已投递 UID={uid}：{prompt}")
            last_uid = uid
            save_state(state_path, last_uid)
        except Exception as exc:
            print(f"处理 UID={uid} 失败，将在下次重试：{exc}", file=sys.stderr)
            break

    return last_uid


def initialize_state(connection: imaplib.IMAP4_SSL, state_path: Path) -> int:
    value = latest_uid(connection)
    save_state(state_path, value)
    print(f"已建立邮件基线 UID={value}，旧邮件不会发送给 Agent")
    return value


def preview(config: dict[str, Any], subject: str, content: str) -> int:
    template = route_map(config).get(subject.strip())
    if template is None:
        print(f"没有配置主题“{subject}”", file=sys.stderr)
        return 2
    prompt = render_prompt(
        template,
        {
            "content": content,
            "subject": subject.strip(),
            "from": "preview@example.com",
            "receivedAt": datetime.now().astimezone().isoformat(timespec="seconds"),
            "imageCount": "0",
            "imagePaths": "",
            "attachments": "",
        },
    )
    print(prompt)
    return 0


def run_once(config: dict[str, Any], state_path: Path) -> None:
    connection = connect_mail(config)
    try:
        state = load_state(state_path)
        if state is None:
            initialize_state(connection, state_path)
            return
        last_uid = int(state.get("lastUid", 0))
        process_new_messages(connection, config, state_path, last_uid)
    finally:
        try:
            connection.logout()
        except Exception:
            pass


def watch(config: dict[str, Any], state_path: Path) -> None:
    idle_refresh = max(60, int(config.get("idleRefreshSeconds", 1500)))
    fallback_poll = max(10, int(config.get("fallbackPollSeconds", 60)))
    reconnect_delay = max(1, int(config.get("reconnectDelaySeconds", 5)))
    print("正在监听手机反馈邮件。按 Ctrl+C 停止。")
    state = load_state(state_path)
    last_uid = int(state.get("lastUid", 0)) if state is not None else None
    connection: imaplib.IMAP4_SSL | None = None
    while True:
        try:
            if connection is None:
                connection = connect_mail(config)
                if last_uid is None:
                    last_uid = initialize_state(connection, state_path)
                if supports_idle(connection):
                    print("邮箱已连接，正在使用 IMAP IDLE 等待新邮件")
                else:
                    capabilities = ", ".join(sorted(capability_names(connection)))
                    print(
                        f"邮箱服务器未提供 IDLE，改为每 {fallback_poll} 秒检查一次。"
                        f"服务器能力：{capabilities}",
                        file=sys.stderr,
                    )

            last_uid = process_new_messages(
                connection,
                config,
                state_path,
                int(last_uid),
            )

            if supports_idle(connection):
                idle_until_event(connection, idle_refresh)
            else:
                time.sleep(fallback_poll)
                status, _ = connection.noop()
                if status != "OK":
                    raise RuntimeError("邮箱连接已失效")
        except Exception as exc:
            print(
                f"邮箱连接异常：{exc}；{reconnect_delay} 秒后重连",
                file=sys.stderr,
            )
            if connection is not None:
                try:
                    connection.logout()
                except Exception:
                    pass
                connection = None
            time.sleep(reconnect_delay)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="读取手机反馈邮件并通过 cc-connect Webhook 送给 Agent")
    parser.add_argument("--config", type=Path, default=DEFAULT_CONFIG_PATH, help="配置文件路径")
    parser.add_argument("--state", type=Path, default=DEFAULT_STATE_PATH, help="状态文件路径")
    parser.add_argument("--once", action="store_true", help="只检查一次后退出")
    parser.add_argument("--reset", action="store_true", help="重新以当前最新邮件建立基线，不处理旧邮件")
    parser.add_argument("--preview", nargs=2, metavar=("SUBJECT", "CONTENT"), help="只预览主题映射结果")
    return parser.parse_args()


def main() -> int:
    configure_console()
    args = parse_args()
    config_path = args.config.expanduser().resolve()
    state_path = args.state.expanduser().resolve()
    config = load_json(config_path)
    validate_config(config)

    if args.preview:
        return preview(config, args.preview[0], args.preview[1])

    get_mail_password(config["mail"])

    if args.reset:
        connection = connect_mail(config)
        try:
            initialize_state(connection, state_path)
        finally:
            try:
                connection.logout()
            except Exception:
                pass
        return 0

    if args.once:
        run_once(config, state_path)
        return 0

    try:
        watch(config, state_path)
    except KeyboardInterrupt:
        print("\n已停止监听")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except RuntimeError as exc:
        configure_console()
        print(f"错误：{exc}", file=sys.stderr)
        raise SystemExit(1)
