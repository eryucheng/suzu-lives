from __future__ import annotations

import importlib.util
import os
from pathlib import Path
import tempfile
import unittest


TEST_RUNTIME = tempfile.mkdtemp(prefix="wechat-sender-tests-")
os.environ["WECHAT_SENDER_RUNTIME_DIR"] = TEST_RUNTIME

MODULE_PATH = (
    Path(__file__).parents[1]
    / "scripts"
    / "hooks"
    / "wechat-splitter"
    / "md_send.py"
)
if not MODULE_PATH.exists():
    MODULE_PATH = Path(__file__).parent / "微信分条" / "md_send.py"
SPEC = importlib.util.spec_from_file_location("wechat_message_sender", MODULE_PATH)
assert SPEC and SPEC.loader
sender = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(sender)


class SplitSegmentsTests(unittest.TestCase):
    def test_blank_lines_take_priority(self):
        self.assertEqual(
            sender.split_segments("第一段第一行\n第一段第二行\n\n第二段"),
            ["第一段第一行\n第一段第二行", "第二段"],
        )

    def test_single_newlines_are_fallback(self):
        self.assertEqual(
            sender.split_segments("第一段\n第二段\n第三段"),
            ["第一段", "第二段", "第三段"],
        )

    def test_literal_backslash_n_is_not_rewritten(self):
        self.assertEqual(sender.split_segments(r"代码里的\n不应被拆开"), [r"代码里的\n不应被拆开"])


class HookPlanningTests(unittest.TestCase):
    def test_first_segment_is_displayed_and_rest_is_queued(self):
        state = sender.default_state()
        display, start = sender.plan_hook_output(
            state, ["一", "二", "三"], is_no_reply=False, now=100.0
        )
        self.assertEqual(display, "一")
        self.assertEqual(state["queue"], ["二", "三"])
        self.assertTrue(start)

    def test_existing_queue_is_drained_before_new_reply(self):
        state = sender.default_state()
        state["queue"] = ["旧二", "旧三"]
        display, start = sender.plan_hook_output(
            state, ["新一", "新二"], is_no_reply=False, now=100.0
        )
        self.assertEqual(display, "旧二")
        self.assertEqual(state["queue"], ["旧三", "新一", "新二"])
        self.assertTrue(start)

    def test_low_budget_displays_refresh_without_losing_content(self):
        state = sender.default_state()
        state["used"] = sender.TOTAL_BUDGET - sender.RESERVED_MESSAGES
        display, start = sender.plan_hook_output(
            state, ["还没发的内容"], is_no_reply=False, now=100.0
        )
        self.assertEqual(display, sender.REFRESH_MESSAGE)
        self.assertEqual(state["queue"], ["还没发的内容"])
        self.assertTrue(state["waitingRefresh"])
        self.assertFalse(start)

    def test_no_reply_is_never_converted_to_empty_display(self):
        state = sender.default_state()
        display, _ = sender.plan_hook_output(
            state, [], is_no_reply=True, now=100.0
        )
        self.assertEqual(display, "NO_REPLY")

    def test_existing_refresh_reminder_queues_new_reply_without_duplicate(self):
        state = sender.default_state()
        state.update(
            {
                "queue": ["旧回复"],
                "used": sender.TOTAL_BUDGET - 1,
                "waitingRefresh": True,
            }
        )
        display, start = sender.plan_hook_output(
            state, ["针对插话的新回复"], is_no_reply=False, now=100.0
        )
        self.assertEqual(display, "NO_REPLY")
        self.assertEqual(state["queue"], ["旧回复", "针对插话的新回复"])
        self.assertFalse(start)

    def test_empty_display_is_rejected(self):
        with self.assertRaises(ValueError):
            sender.emit_display("")


class StateAndWorkerTests(unittest.TestCase):
    def setUp(self):
        for path in Path(TEST_RUNTIME).glob("*"):
            if path.is_file():
                path.unlink()

    def test_old_boolean_inflight_is_migrated(self):
        state = sender.normalize_state({"inflight": True, "queue": ["保留"]})
        self.assertIsNone(state["inflight"])
        self.assertEqual(state["queue"], ["保留"])

    def test_real_inbound_event_resets_budget_even_when_token_is_unchanged(self):
        state = sender.default_state()
        state.update(
            {
                "peer": "peer",
                "tokenHash": "same-hash",
                "used": 8,
                "waitingRefresh": True,
                "pausedError": "old error",
                "refreshGeneration": 4,
            }
        )
        info = {"path": "token.json", "peer": "peer", "hash": "same-hash"}
        old_env = {
            key: os.environ.get(key)
            for key in (
                "CC_HOOK_PLATFORM",
                "CC_HOOK_PROJECT",
                "CC_HOOK_SESSION_KEY",
                "CC_HOOK_USER_ID",
            )
        }
        try:
            os.environ["CC_HOOK_PLATFORM"] = "weixin"
            os.environ["CC_HOOK_SESSION_KEY"] = "weixin:dm:peer"
            os.environ["CC_HOOK_USER_ID"] = "peer"
            self.assertTrue(sender.mark_inbound_refresh(state, info, now=123.0))
        finally:
            for key, value in old_env.items():
                if value is None:
                    os.environ.pop(key, None)
                else:
                    os.environ[key] = value

        self.assertEqual(state["refreshGeneration"], 5)
        self.assertEqual(state["used"], 0)
        self.assertFalse(state["waitingRefresh"])
        self.assertEqual(state["pausedError"], "")
        self.assertEqual(state["lastInboundAt"], 123.0)

    def test_non_weixin_event_does_not_reset_budget(self):
        state = sender.default_state()
        state.update({"peer": "peer", "used": 7, "refreshGeneration": 2})
        previous = os.environ.get("CC_HOOK_PLATFORM")
        try:
            os.environ["CC_HOOK_PLATFORM"] = "telegram"
            self.assertFalse(sender.mark_inbound_refresh(state, None, now=123.0))
        finally:
            if previous is None:
                os.environ.pop("CC_HOOK_PLATFORM", None)
            else:
                os.environ["CC_HOOK_PLATFORM"] = previous
        self.assertEqual(state["used"], 7)
        self.assertEqual(state["refreshGeneration"], 2)

    def test_token_change_opens_budget_before_lifecycle_hook(self):
        state = sender.default_state()
        state.update(
            {
                "peer": "peer",
                "tokenHash": "old-token",
                "budgetTokenHash": "old-token",
                "used": 4,
                "waitingRefresh": True,
                "refreshGeneration": 7,
            }
        )
        changed = sender.sync_token(
            state,
            {"path": "token.json", "peer": "peer", "hash": "new-token"},
            now=120.0,
        )
        self.assertTrue(changed)
        self.assertEqual(state["refreshGeneration"], 8)
        self.assertEqual(state["budgetTokenHash"], "new-token")
        self.assertEqual(state["used"], 0)
        self.assertFalse(state["waitingRefresh"])
        self.assertEqual(state["lastRefreshSource"], "token-change")

    def test_late_lifecycle_hook_does_not_reset_same_token_twice(self):
        state = sender.default_state()
        state.update(
            {
                "peer": "peer",
                "tokenHash": "new-token",
                "budgetTokenHash": "new-token",
                "used": 8,
                "waitingRefresh": True,
                "refreshGeneration": 8,
            }
        )
        info = {"path": "token.json", "peer": "peer", "hash": "new-token"}
        previous_platform = os.environ.get("CC_HOOK_PLATFORM")
        previous_user = os.environ.get("CC_HOOK_USER_ID")
        try:
            os.environ["CC_HOOK_PLATFORM"] = "weixin"
            os.environ["CC_HOOK_USER_ID"] = "peer"
            self.assertTrue(sender.mark_inbound_refresh(state, info, now=130.0))
        finally:
            if previous_platform is None:
                os.environ.pop("CC_HOOK_PLATFORM", None)
            else:
                os.environ["CC_HOOK_PLATFORM"] = previous_platform
            if previous_user is None:
                os.environ.pop("CC_HOOK_USER_ID", None)
            else:
                os.environ["CC_HOOK_USER_ID"] = previous_user

        self.assertEqual(state["refreshGeneration"], 8)
        self.assertEqual(state["used"], 8)
        self.assertTrue(state["waitingRefresh"])
        self.assertEqual(state["lastInboundAt"], 130.0)
        self.assertEqual(
            state["lastRefreshSource"], "token-change+message.received"
        )

    def test_worker_claims_refresh_reminder_before_releasing_state(self):
        state = sender.default_state()
        state.update(
            {
                "peer": "peer",
                "queue": ["等待中的新回复"],
                "used": sender.TOTAL_BUDGET - sender.RESERVED_MESSAGES,
            }
        )
        action = sender.plan_worker_action(state)
        self.assertEqual(action["kind"], "reminder")
        self.assertTrue(state["waitingRefresh"])

        display, start = sender.plan_hook_output(
            state, ["又一条新回复"], is_no_reply=False, now=140.0
        )
        self.assertEqual(display, "NO_REPLY")
        self.assertFalse(start)
        self.assertEqual(
            state["queue"], ["等待中的新回复", "又一条新回复"]
        )

    def test_real_interjection_timeline_uses_one_budget_and_one_reminder(self):
        state = sender.default_state()
        state.update(
            {
                "peer": "peer",
                "tokenHash": "before-interjection",
                "budgetTokenHash": "before-interjection",
                "refreshGeneration": 2,
                "used": 4,
                "queue": [str(number) for number in range(5, 13)],
            }
        )

        sender.sync_token(
            state,
            {"path": "token.json", "peer": "peer", "hash": "after-interjection"},
            now=200.0,
        )
        sent_before_agent_reply = [
            sender.plan_worker_action(state)["text"] for _ in range(4)
        ]
        self.assertEqual(sent_before_agent_reply, ["5", "6", "7", "8"])

        previous_platform = os.environ.get("CC_HOOK_PLATFORM")
        previous_user = os.environ.get("CC_HOOK_USER_ID")
        try:
            os.environ["CC_HOOK_PLATFORM"] = "weixin"
            os.environ["CC_HOOK_USER_ID"] = "peer"
            sender.mark_inbound_refresh(
                state,
                {
                    "path": "token.json",
                    "peer": "peer",
                    "hash": "after-interjection",
                },
                now=201.0,
            )
        finally:
            if previous_platform is None:
                os.environ.pop("CC_HOOK_PLATFORM", None)
            else:
                os.environ["CC_HOOK_PLATFORM"] = previous_platform
            if previous_user is None:
                os.environ.pop("CC_HOOK_USER_ID", None)
            else:
                os.environ["CC_HOOK_USER_ID"] = previous_user

        self.assertEqual(state["used"], 4)
        display, start = sender.plan_hook_output(
            state, ["针对插话的新回复"], is_no_reply=False, now=202.0
        )
        self.assertEqual(display, "9")
        self.assertTrue(start)

        sent_after_display = [
            sender.plan_worker_action(state)["text"] for _ in range(3)
        ]
        self.assertEqual(sent_after_display, ["10", "11", "12"])
        reminder = sender.plan_worker_action(state)
        self.assertEqual(reminder["kind"], "reminder")
        self.assertEqual(reminder["text"], sender.REFRESH_MESSAGE)
        self.assertTrue(state["waitingRefresh"])
        self.assertEqual(state["queue"], ["针对插话的新回复"])

    def test_inflight_send_crossing_refresh_counts_against_new_generation(self):
        state = sender.default_state()
        state.update({"used": 0, "refreshGeneration": 3, "inflight": {}})
        action = {
            "kind": "segment",
            "text": "跨轮发送",
            "peer": "peer",
            "tokenHash": "hash",
            "generation": 2,
        }
        crossed = sender.complete_send(
            state, action, ok=True, details="", latest_info=None
        )
        self.assertTrue(crossed)
        self.assertEqual(state["used"], 1)
        self.assertIsNone(state["inflight"])

    def test_interruption_finishes_old_reply_before_new_reply_and_then_prompts(self):
        state = sender.default_state()
        state.update(
            {
                "peer": "peer",
                "queue": [str(number) for number in range(5, 13)],
                "used": 4,
            }
        )
        previous_platform = os.environ.get("CC_HOOK_PLATFORM")
        previous_user = os.environ.get("CC_HOOK_USER_ID")
        try:
            os.environ["CC_HOOK_PLATFORM"] = "weixin"
            os.environ["CC_HOOK_USER_ID"] = "peer"
            self.assertTrue(sender.mark_inbound_refresh(state, None, now=123.0))
        finally:
            if previous_platform is None:
                os.environ.pop("CC_HOOK_PLATFORM", None)
            else:
                os.environ["CC_HOOK_PLATFORM"] = previous_platform
            if previous_user is None:
                os.environ.pop("CC_HOOK_USER_ID", None)
            else:
                os.environ["CC_HOOK_USER_ID"] = previous_user

        display, start = sender.plan_hook_output(
            state, ["对插话的新回复"], is_no_reply=False, now=124.0
        )
        self.assertEqual(display, "5")
        self.assertTrue(start)

        sent = []
        for _ in range(7):
            action = sender.plan_worker_action(state)
            sent.append(action["text"])
        self.assertEqual(sent, [str(number) for number in range(6, 13)])
        self.assertEqual(state["queue"], ["对插话的新回复"])

        reminder = sender.plan_worker_action(state)
        self.assertEqual(reminder["kind"], "reminder")
        self.assertEqual(reminder["text"], sender.REFRESH_MESSAGE)
        self.assertEqual(state["queue"], ["对插话的新回复"])

    def test_interrupted_segment_is_requeued(self):
        state = sender.default_state()
        state["used"] = 1
        state["inflight"] = {"kind": "segment", "text": "未完成", "tokenHash": "h"}
        sender._recover_interrupted_send(state)
        self.assertEqual(state["queue"], ["未完成"])
        self.assertEqual(state["used"], 0)
        self.assertIsNone(state["inflight"])

    def test_generic_failure_pauses_after_one_attempt(self):
        state = sender.default_state()
        state.update({"peer": "peer", "tokenHash": "hash", "queue": ["不能丢"]})
        sender.write_state(state)

        old_discover = sender.discover_token
        old_send = sender.send_message
        attempts = []
        try:
            sender.discover_token = lambda _state: {
                "path": "token.json",
                "peer": "peer",
                "hash": "hash",
            }
            sender.send_message = lambda peer, text: (
                attempts.append((peer, text)) or (False, "command unavailable")
            )
            result = sender.worker_main()
        finally:
            sender.discover_token = old_discover
            sender.send_message = old_send

        final_state = sender.read_state()
        self.assertEqual(result, 2)
        self.assertEqual(attempts, [("peer", "不能丢")])
        self.assertEqual(final_state["queue"], ["不能丢"])
        self.assertTrue(final_state["pausedError"])


@unittest.skipUnless(os.name == "nt", "Windows command shim behavior")
class WindowsCommandTests(unittest.TestCase):
    def test_cmd_shim_can_be_invoked_without_winerror_193(self):
        with tempfile.TemporaryDirectory(prefix="cc-connect shim ") as directory:
            shim = Path(directory) / "cc-connect.cmd"
            shim.write_text(
                "@echo off\r\n"
                "if not \"%1\"==\"send\" exit /b 9\r\n"
                "if not \"%2\"==\"--stdin\" exit /b 8\r\n"
                "more > nul\r\n"
                "exit /b 0\r\n",
                encoding="utf-8",
            )
            old_command = sender.CONFIG["ccConnectCommand"]
            try:
                sender.CONFIG["ccConnectCommand"] = str(shim)
                ok, details = sender.send_message("peer", "正文里有 & 也不应被命令行解释")
            finally:
                sender.CONFIG["ccConnectCommand"] = old_command
            self.assertTrue(ok, details)


if __name__ == "__main__":
    unittest.main()
