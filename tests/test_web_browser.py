import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
MODULE_DIR = ROOT / "scripts" / "abilities" / "web-browser"
sys.path.insert(0, str(MODULE_DIR))

import start_browser  # noqa: E402


class WebBrowserTests(unittest.TestCase):
    def test_profile_is_stored_beside_the_portable_module(self):
        self.assertEqual(start_browser.PROFILE_DIR.parent, MODULE_DIR / "runtime")
        self.assertEqual(start_browser.DEBUG_HOST, "127.0.0.1")

    def test_configured_chrome_path_has_priority(self):
        with TemporaryDirectory() as directory:
            chrome = Path(directory) / "chrome.exe"
            chrome.write_bytes(b"")
            with patch.dict(start_browser.os.environ, {"CHROME_PATH": str(chrome)}):
                self.assertEqual(start_browser.find_chrome(), chrome.resolve())

    def test_existing_debug_browser_is_reused(self):
        captured = []
        with patch.object(
            start_browser,
            "debug_info",
            return_value={"Browser": "Chrome/Test", "webSocketDebuggerUrl": "ws://local"},
        ), patch.object(start_browser, "output", side_effect=captured.append):
            self.assertEqual(start_browser.run(), 0)

        self.assertEqual(captured[0]["status"], "ready")


if __name__ == "__main__":
    unittest.main()
