from __future__ import annotations

import argparse
from contextlib import redirect_stdout
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
MODULE_PATH = ROOT / "scripts" / "abilities" / "computer-camera" / "capture_camera.py"
SPEC = importlib.util.spec_from_file_location("suzu_computer_camera", MODULE_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"无法加载 {MODULE_PATH}")
camera = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(camera)


class ComputerCameraTests(unittest.TestCase):
    def test_json_status_round_trip(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "status.json"
            camera.write_json(path, {"status": "captured", "ready": True})
            self.assertEqual(
                camera.read_json(path),
                {"status": "captured", "ready": True},
            )

    def test_launcher_returns_ready_without_opening_real_camera(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            output_dir = root / "output"
            runtime_dir = output_dir / "runtime"

            def fake_popen(command, **kwargs):
                output_path = Path(command[command.index("--output") + 1])
                status_path = Path(command[command.index("--status-file") + 1])
                output_path.parent.mkdir(parents=True, exist_ok=True)
                output_path.write_bytes(b"fake-jpeg")
                camera.write_json(
                    status_path,
                    {
                        "status": "captured",
                        "outputPath": str(output_path),
                        "cameraActive": True,
                    },
                )
                return object()

            args = argparse.Namespace(
                camera_index=0,
                active_seconds=10.0,
                warmup_seconds=0.8,
            )
            stream = io.StringIO()
            with (
                patch.object(camera, "OUTPUT_DIR", output_dir),
                patch.object(camera, "RUNTIME_DIR", runtime_dir),
                patch.object(camera.subprocess, "Popen", side_effect=fake_popen),
                redirect_stdout(stream),
            ):
                status = camera.launch_capture(args)

            result = json.loads(stream.getvalue())
            self.assertEqual(status, 0)
            self.assertEqual(result["status"], "captured")
            self.assertTrue(result["ready"])
            self.assertTrue(Path(result["outputPath"]).is_file())


if __name__ == "__main__":
    unittest.main()
