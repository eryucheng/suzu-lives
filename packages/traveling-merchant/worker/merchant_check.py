#!/usr/bin/env python3

import argparse
import html
import json
import re
import sys
import time
import urllib.request
from datetime import datetime, timedelta, timezone
from html.parser import HTMLParser
from pathlib import Path


if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")


DEFAULT_CONFIG_PATH = Path(__file__).resolve().parent.parent / "resources" / "config.example.json"
CHINA_TIME = timezone(timedelta(hours=8))


class RuntimePaths:
    def __init__(self, root, config_path):
        self.root = root
        self.config_path = config_path
        self.runtime_dir = root / "automation" / "traveling-merchant" / "runtime"
        self.state_path = self.runtime_dir / "state.json"


class MerchantItemParser(HTMLParser):
    """Only collect names from the real current-inventory nodes."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.items = []
        self._capture_depth = 0
        self._buffer = []

    def handle_starttag(self, tag, attrs):
        if self._capture_depth:
            self._capture_depth += 1
            return
        attributes = dict(attrs)
        classes = set(str(attributes.get("class", "")).split())
        if "shop_name" in classes:
            self._capture_depth = 1
            self._buffer = []

    def handle_data(self, data):
        if self._capture_depth:
            self._buffer.append(data)

    def handle_endtag(self, tag):
        if not self._capture_depth:
            return
        self._capture_depth -= 1
        if self._capture_depth == 0:
            value = " ".join("".join(self._buffer).split())
            if value and value not in self.items:
                self.items.append(value)
            self._buffer = []


def path_within(root, candidate):
    try:
        candidate.relative_to(root)
        return True
    except ValueError:
        return False


def runtime_paths(args):
    raw_root = str(args.data_root or "").strip()
    if not raw_root:
        raise RuntimeError("缺少 Suzu Lives 软件数据目录")
    root = Path(raw_root).expanduser().resolve()
    requested_config = str(args.config or "").strip()
    if requested_config:
        config_path = Path(requested_config).expanduser()
        if not config_path.is_absolute():
            config_path = root / config_path
        config_path = config_path.resolve()
        if not path_within(root, config_path):
            raise RuntimeError("远行商人配置必须位于 Suzu Lives 软件数据目录内")
    else:
        local_config = root / "automation" / "traveling-merchant" / "config.json"
        config_path = local_config if local_config.exists() else DEFAULT_CONFIG_PATH
    if not config_path.is_file():
        raise RuntimeError(f"缺少配置文件：{config_path}")
    return RuntimePaths(root, config_path)


def load_json(path, fallback=None):
    try:
        return json.loads(path.read_text(encoding="utf-8-sig"))
    except FileNotFoundError:
        if fallback is not None:
            return fallback
        raise RuntimeError(f"缺少配置文件：{path}")
    except json.JSONDecodeError as error:
        raise RuntimeError(f"{path.name} 不是有效 JSON：{error}") from error


def bounded_int(value, fallback, minimum, maximum, label):
    try:
        number = int(value)
    except (TypeError, ValueError):
        number = fallback
    if not minimum <= number <= maximum:
        raise RuntimeError(f"{label} 必须是 {minimum} 到 {maximum} 的整数")
    return number


def load_config(paths):
    config = load_json(paths.config_path)
    url = str(config.get("url", "")).strip()
    wanted = [str(item).strip() for item in config.get("wantedItems", []) if str(item).strip()]
    if not url.startswith("https://"):
        raise RuntimeError("config.json 的 url 必须是 https 地址")
    if not wanted:
        raise RuntimeError("config.json 至少要填写一个 wantedItems")
    return {
        "url": url,
        "wantedItems": list(dict.fromkeys(wanted)),
        "notificationTemplate": str(config.get("notificationTemplate", "远行商人这轮有：{items}，快去买")),
        "notificationTestMessage": str(config.get("notificationTestMessage", "【测试】远行商人监控投递内容")),
        "requestTimeoutSeconds": bounded_int(config.get("requestTimeoutSeconds", 15), 15, 3, 120, "requestTimeoutSeconds"),
        "maxAttempts": bounded_int(config.get("maxAttempts", 3), 3, 1, 10, "maxAttempts"),
        "retryDelaySeconds": bounded_int(config.get("retryDelaySeconds", 20), 20, 0, 300, "retryDelaySeconds"),
    }


def current_slot(now):
    hour = now.astimezone(CHINA_TIME).hour
    for start in (8, 12, 16, 20):
        if start <= hour < start + 4:
            return f"{start}-{start + 4}"
    return ""


def parse_page(page):
    parser = MerchantItemParser()
    parser.feed(page)
    parser.close()
    decoded = html.unescape(page)
    slot_match = re.search(r"(8|12|16|20)\s*-\s*(12|16|20|24)点(?:在售|售卖)商品", decoded)
    return {
        "items": parser.items,
        "slot": f"{slot_match.group(1)}-{slot_match.group(2)}" if slot_match else "",
    }


def fetch_page(url, timeout_seconds):
    separator = "&" if "?" in url else "?"
    request_url = f"{url}{separator}_ts={int(time.time())}"
    request = urllib.request.Request(
        request_url,
        headers={
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36",
            "Accept": "text/html,application/xhtml+xml",
            "Accept-Language": "zh-CN,zh;q=0.9",
            "Cache-Control": "no-cache",
        },
    )
    with urllib.request.urlopen(request, timeout=timeout_seconds) as response:
        body = response.read(2 * 1024 * 1024 + 1)
        if len(body) > 2 * 1024 * 1024:
            raise RuntimeError("网页响应超过 2 MB，已拒绝解析")
        charset = response.headers.get_content_charset() or "utf-8"
        return body.decode(charset, errors="replace")


def inspect_live_page(config, expected_slot):
    last_error = None
    for attempt in range(1, config["maxAttempts"] + 1):
        try:
            parsed = parse_page(fetch_page(config["url"], config["requestTimeoutSeconds"]))
            if not parsed["slot"]:
                raise RuntimeError("网页里没有找到当前售卖时间段")
            if expected_slot and parsed["slot"] != expected_slot:
                raise RuntimeError(f"网页仍是 {parsed['slot']} 时段，当前应为 {expected_slot} 时段")
            if not parsed["items"]:
                raise RuntimeError("网页里没有找到任何 .shop_name 商品节点")
            return parsed, attempt
        except Exception as error:
            last_error = error
            if attempt < config["maxAttempts"] and config["retryDelaySeconds"]:
                time.sleep(config["retryDelaySeconds"])
    raise RuntimeError(f"连续 {config['maxAttempts']} 次读取失败：{last_error}")


def write_state(paths, value):
    paths.runtime_dir.mkdir(parents=True, exist_ok=True)
    temporary = paths.state_path.with_suffix(".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(paths.state_path)


def load_state(paths):
    value = load_json(paths.state_path, {})
    return value if isinstance(value, dict) else {}


def output(value):
    print(json.dumps(value, ensure_ascii=False, indent=2))


def run(args, paths):
    config = load_config(paths)
    now = datetime.now(CHINA_TIME)

    if args.test_notification:
        result = {
            "status": "test-notification-ready",
            "message": config["notificationTestMessage"],
            "deliveryReady": True,
            "checkedAt": now.isoformat(),
        }
        write_state(paths, {**load_state(paths), "lastCheck": result})
        output(result)
        return 0

    expected_slot = current_slot(now)
    if not expected_slot and not args.force and not args.fixture:
        output({
            "status": "outside-selling-hours",
            "checkedAt": now.isoformat(),
            "message": "每天 00:00-08:00 没有远行商人",
        })
        return 0

    if args.fixture:
        page = Path(args.fixture).read_text(encoding="utf-8")
        parsed = parse_page(page)
        attempts = 0
    else:
        parsed, attempts = inspect_live_page(config, expected_slot)

    found = [item for item in config["wantedItems"] if item in parsed["items"]]
    slot = parsed["slot"] or expected_slot or "unknown"
    state = load_state(paths)
    result = {
        "status": "match" if found else "no-match",
        "checkedAt": now.isoformat(),
        "slot": slot,
        "items": parsed["items"],
        "wantedItems": config["wantedItems"],
        "foundItems": found,
        "attempts": attempts,
        "deliveryReady": False,
    }

    if found and not args.dry_run:
        message = config["notificationTemplate"].format(items="、".join(found), slot=slot)
        result["message"] = message
        result["deliveryReady"] = True

    if not args.dry_run:
        state["lastCheck"] = result
        write_state(paths, state)
    output(result)
    return 0


def build_parser():
    parser = argparse.ArgumentParser(description="洛克王国远行商人目标商品监控")
    parser.add_argument("--data-root", required=True, help="Suzu Lives 软件数据目录")
    parser.add_argument("--config", help="软件数据目录内的监控配置")
    parser.add_argument("--dry-run", action="store_true", help="抓取并显示结果，但不准备投递、不写状态")
    parser.add_argument("--force", action="store_true", help="在 00:00-08:00 也强制检查页面")
    parser.add_argument("--fixture", help="读取本地 HTML，仅用于检查解析逻辑")
    parser.add_argument("--test-notification", action="store_true", help="只生成一条测试投递内容，不请求页面")
    return parser


def main(argv=None):
    args = build_parser().parse_args(argv)
    paths = None
    try:
        paths = runtime_paths(args)
        return run(args, paths)
    except Exception as error:
        now = datetime.now(CHINA_TIME)
        result = {
            "status": "error",
            "checkedAt": now.isoformat(),
            "error": str(error),
            "deliveryReady": False,
        }
        if paths is not None and not args.dry_run and not args.fixture and not args.test_notification:
            try:
                state = load_state(paths)
                raw_config = load_json(paths.config_path, {})
                slot = current_slot(now) or "outside-selling-hours"
                if raw_config.get("notifyOnError", True):
                    template = str(raw_config.get("errorNotificationTemplate", "远行商人监控这轮检查失败了：{error}"))
                    result["message"] = template.format(error=str(error), slot=slot)
                    result["deliveryReady"] = True
                state["lastCheck"] = result
                write_state(paths, state)
            except Exception as state_error:
                result["stateError"] = str(state_error)
                try:
                    state = load_state(paths)
                    state["lastCheck"] = result
                    write_state(paths, state)
                except Exception:
                    pass
        output(result)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
