from __future__ import annotations

import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
MODULE_PATH = ROOT / "scripts" / "abilities" / "image-vision" / "vision.py"
SPEC = importlib.util.spec_from_file_location("suzu_image_vision", MODULE_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"无法加载 {MODULE_PATH}")
vision = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(vision)


class ImageVisionTests(unittest.TestCase):
    def test_endpoint_accepts_base_and_v1_urls(self) -> None:
        self.assertEqual(
            vision.endpoint_from_base_url("https://example.com"),
            "https://example.com/v1/chat/completions",
        )
        self.assertEqual(
            vision.endpoint_from_base_url("https://example.com/v1"),
            "https://example.com/v1/chat/completions",
        )
        self.assertEqual(
            vision.endpoint_from_base_url("https://example.com/v1/chat/completions"),
            "https://example.com/v1/chat/completions",
        )

    def test_extract_text_supports_string_and_text_parts(self) -> None:
        self.assertEqual(
            vision.extract_text({"choices": [{"message": {"content": "  看到了  "}}]}),
            "看到了",
        )
        self.assertEqual(
            vision.extract_text(
                {
                    "choices": [
                        {
                            "message": {
                                "content": [
                                    {"type": "text", "text": "第一段"},
                                    {"type": "text", "text": "第二段"},
                                ]
                            }
                        }
                    ]
                }
            ),
            "第一段\n第二段",
        )

    def test_vision_environment_overrides_generic_provider(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            config = Path(directory) / "config.json"
            config.write_text(
                json.dumps(
                    {
                        "openai": {
                            "api_key": "config-key",
                            "base_url": "https://config.example/v1",
                            "model": "config-model",
                        },
                        "vision": {},
                    }
                ),
                encoding="utf-8",
            )
            with patch.dict(
                os.environ,
                {
                    "VISION_API_KEY": "env-key",
                    "VISION_BASE_URL": "https://env.example/v1",
                    "VISION_MODEL": "env-model",
                },
                clear=False,
            ):
                settings = vision.load_settings(config)
            self.assertEqual(settings["api_key"], "env-key")
            self.assertEqual(settings["base_url"], "https://env.example/v1")
            self.assertEqual(settings["model"], "env-model")

    def test_refusal_detection_is_bounded_to_known_markers(self) -> None:
        self.assertTrue(vision.looks_like_refusal("抱歉，我无法分析这张图片"))
        self.assertFalse(vision.looks_like_refusal("画面里有一张桌子"))


if __name__ == "__main__":
    unittest.main()
