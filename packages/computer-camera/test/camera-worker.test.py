import argparse
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path


WORKER = Path(__file__).resolve().parents[1] / "worker" / "camera-worker.py"
SPEC = importlib.util.spec_from_file_location("suzu_computer_camera_worker", WORKER)
worker = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(worker)


class Clock:
    def __init__(self):
        self.value = 0.0

    def __call__(self):
        value = self.value
        self.value += 0.04
        return value


class Bytes:
    def tofile(self, output):
        Path(output).write_bytes(b"fixture-jpeg")


class Camera:
    def __init__(self, opened=True, frames=None):
        self.opened = opened
        self.frames = list(frames or [])
        self.released = False

    def isOpened(self):
        return self.opened

    def read(self):
        return self.frames.pop(0) if self.frames else (False, None)

    def release(self):
        self.released = True


class Cv2:
    def __init__(self, camera):
        self.camera = camera

    def VideoCapture(self, _index):
        return self.camera

    def imencode(self, _format, _frame):
        return True, Bytes()


def arguments(directory):
    return argparse.Namespace(output=str(directory / "capture.jpg"), status_file=str(directory / "status.json"), camera_index=1, active_seconds=0.12, warmup_seconds=0.0)


class CameraWorkerTests(unittest.TestCase):
    def test_captures_then_closes_and_releases_fake_camera(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            camera = Camera(frames=[(True, object())])
            result = worker.run_worker(arguments(directory), cv2_loader=lambda: Cv2(camera), clock=Clock(), sleep=lambda _seconds: None, timestamp=lambda: "2026-07-31T00:00:00+00:00", notice=lambda: None)
            self.assertEqual(result, 0)
            self.assertTrue((directory / "capture.jpg").is_file())
            self.assertTrue(camera.released)
            state = json.loads((directory / "status.json").read_text(encoding="utf-8"))
            self.assertEqual(state["status"], "closed")
            self.assertFalse(state["cameraActive"])

    def test_opencv_missing_open_failure_and_read_failure_write_stable_json_errors(self):
        cases = [
            (lambda: (_ for _ in ()).throw(ImportError()), "缺少 opencv-python"),
            (lambda: Cv2(Camera(opened=False)), "无法打开摄像头 1"),
            (lambda: Cv2(Camera(frames=[])), "没有读取到有效画面"),
        ]
        for loader, expected in cases:
            with self.subTest(expected=expected), tempfile.TemporaryDirectory() as temporary:
                directory = Path(temporary)
                result = worker.run_worker(arguments(directory), cv2_loader=loader, clock=Clock(), sleep=lambda _seconds: None, notice=lambda: None)
                self.assertEqual(result, 1)
                state = json.loads((directory / "status.json").read_text(encoding="utf-8"))
                self.assertEqual(state["status"], "error")
                self.assertIn(expected, state["error"])


if __name__ == "__main__":
    unittest.main()
