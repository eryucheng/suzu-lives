import json
import sys
import unittest
from email.message import EmailMessage
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
MODULE_DIR = ROOT / "scripts" / "abilities" / "connect_iphone"
sys.path.insert(0, str(MODULE_DIR))

import receive_from_iphone  # noqa: E402
import send_to_iphone  # noqa: E402


class FakeSmtp:
    instance = None

    def __init__(self, host, port, timeout):
        self.host = host
        self.port = port
        self.timeout = timeout
        self.login_args = None
        self.message = None
        type(self).instance = self

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, traceback):
        return False

    def login(self, username, password):
        self.login_args = (username, password)

    def send_message(self, message):
        self.message = message


class FakeWebhookResponse:
    status = 202

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, traceback):
        return False

    def read(self):
        return b""


class ConnectIphoneTests(unittest.TestCase):
    def setUp(self):
        self.config = json.loads(
            (MODULE_DIR / "feedback_config.example.json").read_text(encoding="utf-8")
        )

    def test_example_feedback_route_passes_content_through(self):
        receive_from_iphone.validate_config(self.config)
        self.assertEqual(receive_from_iphone.webhook_delivery_delay(self.config), 10)
        template = receive_from_iphone.route_map(self.config)["反馈"]
        prompt = receive_from_iphone.render_prompt(
            template,
            {
                "content": "他现在在上海科技馆",
                "subject": "反馈",
                "from": "iphone@example.com",
                "receivedAt": "2026-07-18T12:00:00+08:00",
            },
        )
        self.assertEqual(prompt, "他现在在上海科技馆")

    def test_sender_uses_shared_mail_config_without_network(self):
        self.config["mail"]["password"] = "test-password"
        with patch.object(send_to_iphone.smtplib, "SMTP_SSL", FakeSmtp):
            send_to_iphone.send_command(self.config, "查岗", "")

        smtp = FakeSmtp.instance
        self.assertIsNotNone(smtp)
        self.assertEqual(smtp.host, "smtp.163.com")
        self.assertEqual(smtp.login_args, ("your-email@163.com", "test-password"))
        self.assertEqual(smtp.message["Subject"], "查岗")

    def test_webhook_sends_only_prompt_without_context_payload(self):
        captured = {}

        def fake_urlopen(request, timeout):
            captured["body"] = json.loads(request.data.decode("utf-8"))
            captured["timeout"] = timeout
            return FakeWebhookResponse()

        with patch.object(receive_from_iphone.urllib.request, "urlopen", fake_urlopen):
            receive_from_iphone.post_webhook(self.config, "诚也现在在QQ")

        self.assertEqual(captured["body"]["prompt"], "诚也现在在QQ")
        self.assertNotIn("payload", captured["body"])
        self.assertEqual(captured["timeout"], 20)

    def test_image_attachment_is_saved_to_private_runtime_directory(self):
        message = EmailMessage()
        message.set_content("手机截图")
        message.add_attachment(
            b"\x89PNG\r\n\x1a\nfixture",
            maintype="image",
            subtype="png",
            filename="../screen.png",
        )

        with TemporaryDirectory() as directory:
            self.config["imageAttachments"] = {
                "directory": directory,
                "maxBytesPerImage": 1024,
                "maxImagesPerMessage": 2,
                "allowedTypes": ["image/png"],
            }
            paths, warnings = receive_from_iphone.extract_image_attachments(
                message,
                123,
                self.config,
            )

            self.assertEqual(warnings, [])
            self.assertEqual(len(paths), 1)
            self.assertTrue(paths[0].is_file())
            self.assertEqual(paths[0].parent.name, "123")
            self.assertTrue(paths[0].name.endswith("-screen.png"))
            prompt = receive_from_iphone.image_prompt(paths, warnings)
            self.assertIn(str(paths[0]), prompt)
            self.assertIn("识图能力", prompt)


if __name__ == "__main__":
    unittest.main()
