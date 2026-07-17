#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Claude Code MessageDisplay hook + cc-connect-aware background sender.

The first paragraph is returned immediately through MessageDisplay. Remaining
paragraphs are persisted locally and delivered by one detached worker. The
hook itself never waits for background delivery, so a new inbound message is
not blocked by the previous reply's send loop. A cc-connect
``message.received`` hook invokes this same file with ``--inbound``. While an
old reply is still draining, a changed Weixin context token opens the new
budget immediately; the later lifecycle hook confirms that same token without
opening the budget a second time.

This module intentionally has no third-party Python dependencies.
"""

from __future__ import annotations

import contextlib
import hashlib
import io
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time
from typing import Any, Iterator


SCRIPT_PATH = Path(__file__).resolve()
SCRIPT_DIR = SCRIPT_PATH.parent
CONFIG_PATH = Path(
    os.environ.get("WECHAT_SENDER_CONFIG", str(SCRIPT_DIR / "config.json"))
).expanduser()

DEFAULT_CONFIG: dict[str, Any] = {
    "totalBudget": 10,
    "reservedMessages": 2,
    "refreshMessage": "你咋一直不说话",
    "displayDelayMs": 5000,
    "sendIntervalMs": 120,
    "tokenPollMs": 300,
    "sendTimeoutSeconds": 20,
    "maxLogBytes": 1_048_576,
    "ccConnectProject": "",
    "peer": "",
    "contextTokensPath": "",
    "ccConnectCommand": "cc-connect",
}


def _load_config() -> dict[str, Any]:
    config = dict(DEFAULT_CONFIG)
    try:
        loaded = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
        if isinstance(loaded, dict):
            config.update(loaded)
    except FileNotFoundError:
        pass
    except (json.JSONDecodeError, OSError) as exc:
        # Logging is not ready yet. Keep the hook fail-safe and report later.
        config["_configError"] = str(exc)

    env_overrides = {
        "WECHAT_SENDER_TOTAL_BUDGET": "totalBudget",
        "WECHAT_SENDER_RESERVED_MESSAGES": "reservedMessages",
        "WECHAT_SENDER_REFRESH_MESSAGE": "refreshMessage",
        "WECHAT_SENDER_DISPLAY_DELAY_MS": "displayDelayMs",
        "WECHAT_SENDER_SEND_INTERVAL_MS": "sendIntervalMs",
        "WECHAT_SENDER_TOKEN_POLL_MS": "tokenPollMs",
        "WECHAT_SENDER_SEND_TIMEOUT_SECONDS": "sendTimeoutSeconds",
        "WECHAT_SENDER_MAX_LOG_BYTES": "maxLogBytes",
        "WECHAT_SENDER_PROJECT": "ccConnectProject",
        "WECHAT_SENDER_PEER": "peer",
        "WECHAT_SENDER_CONTEXT_TOKENS": "contextTokensPath",
        "WECHAT_SENDER_CC_CONNECT": "ccConnectCommand",
    }
    for env_name, key in env_overrides.items():
        if env_name in os.environ:
            config[key] = os.environ[env_name]
    return config


CONFIG = _load_config()


def _int_config(key: str, minimum: int, maximum: int | None = None) -> int:
    try:
        value = int(CONFIG.get(key, DEFAULT_CONFIG[key]))
    except (TypeError, ValueError):
        value = int(DEFAULT_CONFIG[key])
    value = max(minimum, value)
    return min(value, maximum) if maximum is not None else value


TOTAL_BUDGET = _int_config("totalBudget", 3)
RESERVED_MESSAGES = min(
    _int_config("reservedMessages", 1), TOTAL_BUDGET - 1
)
REFRESH_MESSAGE = str(CONFIG.get("refreshMessage") or DEFAULT_CONFIG["refreshMessage"])
DISPLAY_SETTLE_SECONDS = _int_config("displayDelayMs", 0) / 1000
SEND_INTERVAL_SECONDS = _int_config("sendIntervalMs", 0) / 1000
TOKEN_POLL_SECONDS = _int_config("tokenPollMs", 100) / 1000
SEND_TIMEOUT_SECONDS = _int_config("sendTimeoutSeconds", 1, 300)
MAX_LOG_BYTES = _int_config("maxLogBytes", 16_384)
WORKER_IDLE_GRACE_SECONDS = 1.0

runtime_override = os.environ.get("WECHAT_SENDER_RUNTIME_DIR", "").strip()
RUNTIME_DIR = (
    Path(runtime_override).expanduser()
    if runtime_override
    else SCRIPT_DIR / "runtime" / "message_sender"
)
STATE_PATH = RUNTIME_DIR / "state.json"
STATE_LOCK_PATH = RUNTIME_DIR / "state.lock"
WORKER_LOCK_PATH = RUNTIME_DIR / "worker.lock"
LOG_PATH = RUNTIME_DIR / "sender.log"


def _configure_stdio() -> None:
    os.environ.setdefault("PYTHONIOENCODING", "utf-8")
    for name in ("stdin", "stdout", "stderr"):
        stream = getattr(sys, name)
        try:
            wrapped = io.TextIOWrapper(
                stream.buffer,
                encoding="utf-8",
                errors="replace",
                line_buffering=True,
            )
            setattr(sys, name, wrapped)
        except (AttributeError, ValueError):
            pass


def _rotate_log_if_needed() -> None:
    try:
        if LOG_PATH.exists() and LOG_PATH.stat().st_size >= MAX_LOG_BYTES:
            old_path = LOG_PATH.with_suffix(".log.1")
            old_path.unlink(missing_ok=True)
            os.replace(LOG_PATH, old_path)
    except OSError:
        pass


def log(message: str) -> None:
    try:
        RUNTIME_DIR.mkdir(parents=True, exist_ok=True)
        _rotate_log_if_needed()
        stamp = time.strftime("%Y-%m-%d %H:%M:%S")
        with LOG_PATH.open("a", encoding="utf-8") as handle:
            handle.write(f"[{stamp}] {message}\n")
    except Exception:
        pass


class LockUnavailable(RuntimeError):
    pass


class FileLock:
    """Small cross-platform one-byte advisory file lock."""

    def __init__(self, path: Path, timeout: float = 2.0):
        self.path = path
        self.timeout = timeout
        self.handle: Any = None

    def __enter__(self) -> "FileLock":
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.handle = self.path.open("a+b")
        self.handle.seek(0, os.SEEK_END)
        if self.handle.tell() == 0:
            self.handle.write(b"\0")
            self.handle.flush()

        deadline = time.monotonic() + self.timeout
        while True:
            try:
                self.handle.seek(0)
                if os.name == "nt":
                    import msvcrt

                    msvcrt.locking(self.handle.fileno(), msvcrt.LK_NBLCK, 1)
                else:
                    import fcntl

                    fcntl.flock(self.handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                return self
            except (OSError, BlockingIOError):
                if time.monotonic() >= deadline:
                    self.handle.close()
                    self.handle = None
                    raise LockUnavailable(str(self.path))
                time.sleep(0.025)

    def __exit__(self, exc_type: Any, exc: Any, tb: Any) -> None:
        if self.handle is None:
            return
        try:
            self.handle.seek(0)
            if os.name == "nt":
                import msvcrt

                msvcrt.locking(self.handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl

                fcntl.flock(self.handle.fileno(), fcntl.LOCK_UN)
        finally:
            self.handle.close()
            self.handle = None


def default_state() -> dict[str, Any]:
    return {
        "version": 4,
        "peer": "",
        "tokenPath": "",
        "tokenHash": "",
        "budgetTokenHash": "",
        "refreshGeneration": 0,
        "lastInboundAt": 0.0,
        "lastTokenRefreshAt": 0.0,
        "lastRefreshSource": "",
        "used": 0,
        "waitingRefresh": False,
        "pausedError": "",
        "inflight": None,
        "queue": [],
        "nextSendNotBefore": 0.0,
        "updatedAt": time.time(),
    }


def _clean_inflight(value: Any) -> dict[str, Any] | None:
    if not isinstance(value, dict):
        return None
    kind = str(value.get("kind") or "")
    text = str(value.get("text") or "")
    token_hash_value = str(value.get("tokenHash") or "")
    try:
        generation = max(0, int(value.get("generation") or 0))
    except (TypeError, ValueError):
        generation = 0
    if kind not in {"segment", "reminder"} or not text:
        return None
    return {
        "kind": kind,
        "text": text,
        "tokenHash": token_hash_value,
        "generation": generation,
    }


def normalize_state(loaded: Any) -> dict[str, Any]:
    state = default_state()
    if isinstance(loaded, dict):
        state.update(loaded)
    state["version"] = 4
    queue = state.get("queue")
    if not isinstance(queue, list):
        queue = []
    state["queue"] = [str(item) for item in queue if str(item).strip()]
    state["used"] = max(0, int(state.get("used") or 0))
    state["refreshGeneration"] = max(
        0, int(state.get("refreshGeneration") or 0)
    )
    state["budgetTokenHash"] = str(state.get("budgetTokenHash") or "")
    state["lastInboundAt"] = float(state.get("lastInboundAt") or 0.0)
    state["lastTokenRefreshAt"] = float(
        state.get("lastTokenRefreshAt") or 0.0
    )
    state["lastRefreshSource"] = str(state.get("lastRefreshSource") or "")
    state["waitingRefresh"] = bool(state.get("waitingRefresh"))
    state["pausedError"] = str(state.get("pausedError") or "")
    state["inflight"] = _clean_inflight(state.get("inflight"))
    state["nextSendNotBefore"] = float(state.get("nextSendNotBefore") or 0.0)
    return state


def read_state() -> dict[str, Any]:
    try:
        loaded = json.loads(STATE_PATH.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        loaded = None
    return normalize_state(loaded)


def write_state(state: dict[str, Any]) -> None:
    RUNTIME_DIR.mkdir(parents=True, exist_ok=True)
    state["updatedAt"] = time.time()
    temp_path = STATE_PATH.with_name(f"state.{os.getpid()}.tmp")
    temp_path.write_text(
        json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    os.replace(temp_path, STATE_PATH)


@contextlib.contextmanager
def locked_state(timeout: float = 2.0) -> Iterator[dict[str, Any]]:
    with FileLock(STATE_LOCK_PATH, timeout=timeout):
        state = read_state()
        yield state
        write_state(state)


def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _normalized_peer(value: str) -> str:
    value = value.strip()
    if value.startswith("weixin:dm:"):
        return value[len("weixin:dm:") :]
    return value


def _token_candidates(state: dict[str, Any]) -> list[Path]:
    candidates: list[Path] = []
    configured = str(CONFIG.get("contextTokensPath") or "").strip()
    if configured:
        candidates.append(Path(configured).expanduser())

    saved = str(state.get("tokenPath") or "").strip()
    if saved:
        candidates.append(Path(saved).expanduser())

    data_dir = os.environ.get("CC_DATA_DIR", "").strip()
    roots = [Path(data_dir).expanduser()] if data_dir else [Path.home() / ".cc-connect"]
    for root in roots:
        weixin_dir = root / "weixin"
        if weixin_dir.exists():
            candidates.extend(weixin_dir.glob("*/*/context_tokens.json"))

    unique: list[Path] = []
    seen: set[str] = set()
    for item in candidates:
        try:
            key = str(item.resolve())
        except OSError:
            key = str(item)
        if key not in seen:
            seen.add(key)
            unique.append(item)
    return unique


def discover_token(state: dict[str, Any]) -> dict[str, str] | None:
    preferred_peer = _normalized_peer(
        str(CONFIG.get("peer") or "") or str(state.get("peer") or "")
    )

    entries: list[tuple[Path, str, str]] = []
    for path in _token_candidates(state):
        for attempt in range(3):
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
                if isinstance(data, dict):
                    for peer, token in data.items():
                        if isinstance(peer, str) and isinstance(token, str) and token:
                            entries.append((path, peer, token))
                break
            except FileNotFoundError:
                break
            except (json.JSONDecodeError, OSError):
                if attempt < 2:
                    time.sleep(0.01)

    if preferred_peer:
        for path, peer, token in entries:
            if peer == preferred_peer:
                return {
                    "path": str(path.resolve()),
                    "peer": peer,
                    "hash": token_hash(token),
                }

    unique_peers = {peer for _, peer, _ in entries}
    if len(unique_peers) == 1 and entries:
        path, peer, token = entries[0]
        return {
            "path": str(path.resolve()),
            "peer": peer,
            "hash": token_hash(token),
        }
    return None


def _open_budget_generation(
    state: dict[str, Any], *, token_hash_value: str, now: float, source: str
) -> None:
    """Atomically open one outgoing budget for one Weixin context token."""

    state["budgetTokenHash"] = token_hash_value
    state["refreshGeneration"] = int(state["refreshGeneration"]) + 1
    state["lastTokenRefreshAt"] = now
    state["lastRefreshSource"] = source
    state["used"] = 0
    state["waitingRefresh"] = False
    state["pausedError"] = ""
    state["nextSendNotBefore"] = 0.0


def sync_token(
    state: dict[str, Any], info: dict[str, str] | None, *, now: float | None = None
) -> bool:
    """Refresh token metadata and immediately open a changed token's budget.

    Weixin persists the new context token before a queued message necessarily
    reaches cc-connect's ``message.received`` lifecycle event. The active
    worker therefore treats an actual hash change as the earliest reliable
    budget boundary. The later lifecycle hook deduplicates against
    ``budgetTokenHash``.
    """

    if not info:
        return False
    state["peer"] = info["peer"]
    state["tokenPath"] = info["path"]
    old_hash = str(state.get("tokenHash") or "")
    changed = bool(old_hash) and old_hash != info["hash"]
    first_seen = not old_hash
    if changed or first_seen:
        state["tokenHash"] = info["hash"]
        if changed:
            _open_budget_generation(
                state,
                token_hash_value=info["hash"],
                now=time.time() if now is None else now,
                source="token-change",
            )
            log(
                "context token changed; opened budget "
                f"generation={state['refreshGeneration']}"
            )
    return changed


def _event_peer() -> str:
    user_id = _normalized_peer(os.environ.get("CC_HOOK_USER_ID", ""))
    if user_id:
        return user_id
    return _normalized_peer(os.environ.get("CC_HOOK_SESSION_KEY", ""))


def _inbound_event_matches(state: dict[str, Any], info: dict[str, str] | None) -> bool:
    platform = os.environ.get("CC_HOOK_PLATFORM", "").strip().lower()
    if platform != "weixin":
        log(f"ignored inbound hook for platform={platform or 'missing'}")
        return False

    configured_project = str(CONFIG.get("ccConnectProject") or "").strip()
    event_project = os.environ.get("CC_HOOK_PROJECT", "").strip()
    if configured_project and event_project != configured_project:
        log(f"ignored inbound hook for project={event_project or 'missing'}")
        return False

    event_peer = _event_peer()
    expected_peer = _normalized_peer(
        str(CONFIG.get("peer") or "")
        or str(state.get("peer") or "")
        or str((info or {}).get("peer") or "")
    )
    if expected_peer and event_peer != expected_peer:
        log(f"ignored inbound hook for peer={event_peer or 'missing'}")
        return False
    return bool(event_peer)


def mark_inbound_refresh(
    state: dict[str, Any], info: dict[str, str] | None, *, now: float
) -> bool:
    """Confirm a real inbound event, opening a budget only if still needed."""

    if not _inbound_event_matches(state, info):
        return False
    sync_token(state, info, now=now)
    state["lastInboundAt"] = now
    current_hash = str((info or {}).get("hash") or state.get("tokenHash") or "")
    if not current_hash or str(state.get("budgetTokenHash") or "") != current_hash:
        _open_budget_generation(
            state,
            token_hash_value=current_hash,
            now=now,
            source="message.received",
        )
    else:
        state["lastRefreshSource"] = "token-change+message.received"
    return True


def split_segments(text: str) -> list[str]:
    """Split on blank lines first; otherwise split on ordinary line breaks."""

    normalized = text.replace("\r\n", "\n").replace("\r", "\n")
    if re.search(r"\n[ \t]*\n", normalized):
        parts = re.split(r"\n[ \t]*\n+", normalized)
    else:
        parts = normalized.split("\n")
    return [part.strip() for part in parts if part.strip()]


def plan_hook_output(
    state: dict[str, Any], segments: list[str], *, is_no_reply: bool, now: float
) -> tuple[str, bool]:
    """Mutate state and return (display_content, should_start_worker).

    This function never returns an empty display string.
    """

    if is_no_reply:
        should_start = bool(state["queue"]) and not bool(state["waitingRefresh"])
        return "NO_REPLY", should_start and not bool(state["pausedError"])

    incoming = list(segments)
    if state["waitingRefresh"]:
        # A refresh reminder has already been displayed or atomically reserved
        # by the worker. Preserve the new reply without emitting a duplicate.
        state["queue"].extend(incoming)
        return "NO_REPLY", False

    remaining = max(0, TOTAL_BUDGET - int(state["used"]))
    if remaining <= RESERVED_MESSAGES:
        state["queue"].extend(incoming)
        state["used"] += 1
        state["waitingRefresh"] = True
        return REFRESH_MESSAGE, False

    # If a previous reply still has queued text, use MessageDisplay to drain
    # its next unsent paragraph first. New text joins the back of the queue.
    # This preserves content without ever emitting displayContent="".
    if state["queue"]:
        display = state["queue"].pop(0)
        state["queue"].extend(incoming)
    else:
        display = incoming.pop(0)
        state["queue"].extend(incoming)

    state["used"] += 1
    if state["queue"]:
        state["nextSendNotBefore"] = now + DISPLAY_SETTLE_SECONDS
    should_start = bool(state["queue"]) and not bool(state["pausedError"])
    return display, should_start


def emit_display(content: str) -> None:
    if not content:
        raise ValueError("displayContent must never be empty")
    print(
        json.dumps(
            {
                "hookSpecificOutput": {
                    "hookEventName": "MessageDisplay",
                    "displayContent": content,
                }
            },
            ensure_ascii=False,
        )
    )


def worker_command() -> list[str]:
    return [sys.executable, str(SCRIPT_PATH), "--worker"]


def start_worker() -> None:
    kwargs: dict[str, Any] = {
        "stdin": subprocess.DEVNULL,
        "stdout": subprocess.DEVNULL,
        "stderr": subprocess.DEVNULL,
        "cwd": str(SCRIPT_DIR),
        "close_fds": True,
    }
    if os.name == "nt":
        kwargs["creationflags"] = (
            getattr(subprocess, "CREATE_NO_WINDOW", 0)
            | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
            | getattr(subprocess, "DETACHED_PROCESS", 0)
        )
    try:
        subprocess.Popen(worker_command(), **kwargs)
    except Exception as exc:
        log(f"failed to start worker: {type(exc).__name__}: {exc}")


def send_target(peer: str) -> str:
    return peer if peer.startswith("weixin:") else f"weixin:dm:{peer}"


def _resolve_cc_connect_prefix() -> list[str] | None:
    configured = str(CONFIG.get("ccConnectCommand") or "cc-connect").strip()
    if not configured:
        return None

    candidate = Path(configured).expanduser()
    if candidate.exists():
        resolved = str(candidate.resolve())
    else:
        found = shutil.which(configured)
        if not found:
            return None
        resolved = found

    if os.name == "nt" and Path(resolved).suffix.lower() in {".cmd", ".bat"}:
        comspec = os.environ.get("COMSPEC", "cmd.exe")
        # npm installs cc-connect as a .cmd shim. Such files cannot be spawned
        # directly by CreateProcess (WinError 193). `call` also keeps a shim
        # path containing spaces intact when Python builds the command line.
        return [comspec, "/d", "/s", "/c", "call", resolved]
    return [resolved]


def send_message(peer: str, text: str) -> tuple[bool, str]:
    fake_log = os.environ.get("WECHAT_SENDER_FAKE_SEND_LOG", "").strip()
    if fake_log:
        try:
            with Path(fake_log).open("a", encoding="utf-8") as handle:
                handle.write(json.dumps({"peer": peer, "text": text}, ensure_ascii=False) + "\n")
            return True, "fake-send"
        except OSError as exc:
            return False, str(exc)

    prefix = _resolve_cc_connect_prefix()
    if not prefix:
        return False, "cc-connect command was not found"

    command = prefix + ["send", "--stdin", "-s", send_target(peer)]
    creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0) if os.name == "nt" else 0
    try:
        result = subprocess.run(
            command,
            input=text,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=SEND_TIMEOUT_SECONDS,
            creationflags=creationflags,
        )
    except Exception as exc:
        return False, f"{type(exc).__name__}: {exc}"
    details = (result.stderr or result.stdout or "").strip()
    return result.returncode == 0, details


def _is_token_error(details: str) -> bool:
    lowered = details.lower()
    return any(
        marker in lowered
        for marker in ("ret=-2", "expired context_token", "missing context_token")
    )


def handle_hook() -> int:
    raw = sys.stdin.read()
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError as exc:
        log(f"hook input parse failed: {exc}")
        return 0  # Fail open: let Claude Code render the original text.

    text = str(payload.get("delta") or "").strip()
    if not text:
        return 0
    if payload.get("final") is False:
        return 0

    is_no_reply = text == "NO_REPLY"
    segments = [] if is_no_reply else split_segments(text)
    if not is_no_reply and not segments:
        return 0

    try:
        with locked_state() as state:
            info = discover_token(state)
            if not info:
                log("context token or target peer could not be resolved; original text passed through")
                return 0
            sync_token(state, info)
            display, should_start_worker = plan_hook_output(
                state, segments, is_no_reply=is_no_reply, now=time.time()
            )
    except LockUnavailable:
        log("state lock timeout; original text passed through")
        return 0
    except Exception as exc:
        log(f"hook failed; original text passed through: {type(exc).__name__}: {exc}")
        return 0

    if should_start_worker:
        start_worker()
    emit_display(display)
    return 0


def handle_inbound_event() -> int:
    """Handle cc-connect's synchronous ``message.received`` lifecycle hook."""

    should_start_worker = False
    try:
        with locked_state() as state:
            info = discover_token(state)
            if not mark_inbound_refresh(state, info, now=time.time()):
                return 0
            should_start_worker = (
                bool(state["queue"])
                and not bool(state["waitingRefresh"])
                and not bool(state["pausedError"])
            )
            generation = int(state["refreshGeneration"])
            queue_count = len(state["queue"])
    except LockUnavailable:
        log("inbound hook could not acquire state lock")
        return 1
    except Exception as exc:
        log(f"inbound hook failed: {type(exc).__name__}: {exc}")
        return 1

    log(
        f"inbound message confirmed budget generation={generation}; "
        f"queue remaining={queue_count}"
    )
    if should_start_worker:
        start_worker()
    return 0


def _recover_interrupted_send(state: dict[str, Any]) -> None:
    inflight = _clean_inflight(state.get("inflight"))
    if not inflight:
        state["inflight"] = None
        return
    if inflight["kind"] == "segment":
        state["queue"].insert(0, inflight["text"])
    state["inflight"] = None
    if int(inflight.get("generation") or 0) == int(state["refreshGeneration"]):
        state["used"] = max(0, int(state["used"]) - 1)
    log("recovered one interrupted send")


def complete_send(
    state: dict[str, Any],
    action: dict[str, Any],
    *,
    ok: bool,
    details: str,
    latest_info: dict[str, str] | None,
) -> bool:
    """Commit one worker send and return whether an inbound refresh crossed it."""

    sync_token(state, latest_info)
    generation_changed = (
        int(state["refreshGeneration"]) != int(action["generation"])
    )

    # The action was reserved against its starting generation. When a real
    # inbound event resets the counter during the send, count a successful
    # completion once against the new generation too.
    if generation_changed and ok:
        state["used"] += 1

    if not ok and not generation_changed:
        state["used"] = max(0, int(state["used"]) - 1)

    if action["kind"] == "segment" and not ok:
        state["queue"].insert(0, action["text"])

    state["inflight"] = None
    if ok and action["kind"] == "reminder" and not generation_changed:
        state["waitingRefresh"] = True
    elif not ok and _is_token_error(details):
        state["waitingRefresh"] = True
    elif not ok:
        state["pausedError"] = details[:500] or "unknown send failure"
    return generation_changed


def plan_worker_action(state: dict[str, Any]) -> dict[str, Any]:
    """Reserve exactly one queued segment or one refresh reminder."""

    remaining = max(0, TOTAL_BUDGET - int(state["used"]))
    peer = str(state.get("peer") or "")
    current_hash = str(state.get("tokenHash") or "")
    current_generation = int(state["refreshGeneration"])
    if remaining <= RESERVED_MESSAGES:
        action: dict[str, Any] = {
            "kind": "reminder",
            "text": REFRESH_MESSAGE,
            "peer": peer,
            "tokenHash": current_hash,
            "generation": current_generation,
        }
        # Claim the one allowed reminder before releasing the state lock. A
        # concurrent MessageDisplay hook will queue its text and return
        # NO_REPLY instead of producing the same reminder again.
        state["waitingRefresh"] = True
    else:
        action = {
            "kind": "segment",
            "text": state["queue"].pop(0),
            "peer": peer,
            "tokenHash": current_hash,
            "generation": current_generation,
        }
    state["used"] += 1
    state["inflight"] = {
        "kind": action["kind"],
        "text": action["text"],
        "tokenHash": action["tokenHash"],
        "generation": action["generation"],
    }
    state["nextSendNotBefore"] = 0.0
    return action


def worker_main() -> int:
    try:
        leader = FileLock(WORKER_LOCK_PATH, timeout=0.0)
        leader.__enter__()
    except LockUnavailable:
        return 0

    try:
        try:
            with locked_state() as state:
                _recover_interrupted_send(state)
        except Exception as exc:
            log(f"worker recovery failed: {type(exc).__name__}: {exc}")
            return 1

        idle_since: float | None = None
        while True:
            action: dict[str, Any] | None = None
            wait_for = TOKEN_POLL_SECONDS
            try:
                with locked_state() as state:
                    info = discover_token(state)
                    sync_token(state, info)

                    if state["pausedError"]:
                        return 2
                    if state["waitingRefresh"]:
                        # The next real message.received event will clear this
                        # state and start a fresh worker. Do not leave a process
                        # polling forever while the user is away.
                        return 0
                    elif state["queue"]:
                        idle_since = None
                        not_before = float(state.get("nextSendNotBefore") or 0.0)
                        if time.time() < not_before:
                            wait_for = min(TOKEN_POLL_SECONDS, not_before - time.time())
                        else:
                            action = plan_worker_action(state)
                    else:
                        if idle_since is None:
                            idle_since = time.monotonic()
                        elif time.monotonic() - idle_since >= WORKER_IDLE_GRACE_SECONDS:
                            return 0
            except LockUnavailable:
                time.sleep(0.05)
                continue
            except Exception as exc:
                log(f"worker state error: {type(exc).__name__}: {exc}")
                return 1

            if action is None:
                time.sleep(max(0.01, wait_for))
                continue

            ok, details = send_message(action["peer"], action["text"])
            try:
                with locked_state() as state:
                    latest_info = discover_token(state)
                    complete_send(
                        state,
                        action,
                        ok=ok,
                        details=details,
                        latest_info=latest_info,
                    )
            except Exception as exc:
                log(f"worker completion error: {type(exc).__name__}: {exc}")
                return 1

            if ok:
                log(f"sent {action['kind']}; queue remaining={len(read_state()['queue'])}")
                time.sleep(SEND_INTERVAL_SECONDS)
            else:
                log(f"send {action['kind']} paused after failure: {details[:300]}")
                # Never spin on a broken command or platform. The queue remains
                # durable and is retried after an inbound refresh or explicit resume.
                return 2
    finally:
        leader.__exit__(None, None, None)


def resume_worker() -> int:
    try:
        with locked_state() as state:
            state["pausedError"] = ""
            state["waitingRefresh"] = False
            should_start = bool(state["queue"])
    except Exception as exc:
        print(f"无法恢复发送队列：{exc}", file=sys.stderr)
        return 1
    if should_start:
        start_worker()
    print("发送队列已恢复。" if should_start else "发送队列为空。")
    return 0


def print_status() -> int:
    state = read_state()
    report = {
        "queueCount": len(state["queue"]),
        "used": state["used"],
        "refreshGeneration": state["refreshGeneration"],
        "lastInboundAt": state["lastInboundAt"],
        "lastTokenRefreshAt": state["lastTokenRefreshAt"],
        "lastRefreshSource": state["lastRefreshSource"],
        "totalBudget": TOTAL_BUDGET,
        "reservedMessages": RESERVED_MESSAGES,
        "waitingRefresh": state["waitingRefresh"],
        "paused": bool(state["pausedError"]),
        "inflight": bool(state["inflight"]),
        "hasPeer": bool(state["peer"]),
        "hasTokenPath": bool(state["tokenPath"]),
    }
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0


def check_setup() -> int:
    state = read_state()
    token_info = discover_token(state)
    command = _resolve_cc_connect_prefix()
    report = {
        "configPath": str(CONFIG_PATH),
        "configExists": CONFIG_PATH.exists(),
        "configError": str(CONFIG.get("_configError") or ""),
        "ccConnectFound": bool(command),
        "contextTokenFound": bool(token_info),
        "peerResolved": bool(token_info and token_info.get("peer")),
        "inboundHookObserved": bool(state["lastInboundAt"]),
        "runtimeDir": str(RUNTIME_DIR),
    }
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report["ccConnectFound"] and report["contextTokenFound"] else 1


def main() -> int:
    _configure_stdio()
    RUNTIME_DIR.mkdir(parents=True, exist_ok=True)
    if CONFIG.get("_configError"):
        log(f"config load failed; defaults used: {CONFIG['_configError']}")
    if len(sys.argv) > 1:
        if sys.argv[1] == "--worker":
            return worker_main()
        if sys.argv[1] == "--inbound":
            return handle_inbound_event()
        if sys.argv[1] == "--resume":
            return resume_worker()
        if sys.argv[1] == "--status":
            return print_status()
        if sys.argv[1] == "--check":
            return check_setup()
    return handle_hook()


if __name__ == "__main__":
    raise SystemExit(main())
