import unittest
from unittest.mock import patch

import numpy as np

from desktop_agent import registry


class CameraToolTests(unittest.TestCase):
    def test_capture_camera_frame_does_not_fail_with_mocked_camera(self):
        class FakeCapture:
            def __init__(self):
                self.calls = []

            def isOpened(self):
                return True

            def set(self, *args, **kwargs):
                return True

            def read(self):
                return True, np.array([[255, 0, 0], [0, 255, 0]], dtype=np.uint8)

            def release(self):
                pass

        with patch("desktop_agent.tools_camera.cv2.VideoCapture", return_value=FakeCapture()):
            result = registry.TOOLS["captureCameraFrame"]({"include_image": True})

        self.assertIn("image_base64", result)
        self.assertIn("result", result)

    def test_analyze_camera_frame_returns_scene_summary(self):
        class FakeCapture:
            def __init__(self):
                self.calls = []

            def isOpened(self):
                return True

            def read(self):
                return True, np.array([
                    [[10, 20, 30], [30, 40, 50]],
                    [[200, 50, 60], [50, 200, 70]],
                ], dtype=np.uint8)

            def release(self):
                pass

        with patch("desktop_agent.tools_camera.cv2.VideoCapture", return_value=FakeCapture()):
            result = registry.TOOLS["analyzeCameraFrame"]({"include_image": True})

        self.assertIn("result", result)
        self.assertIn("scene_summary", result)
        self.assertIn("objects_detected", result)

    def test_read_camera_text_returns_ocr_text_from_live_frame(self):
        class FakeCapture:
            def __init__(self):
                self.calls = []

            def isOpened(self):
                return True

            def read(self):
                return True, np.zeros((20, 20, 3), dtype=np.uint8)

            def release(self):
                pass

        with patch("desktop_agent.tools_camera.cv2.VideoCapture", return_value=FakeCapture()):
            with patch("desktop_agent.tools_camera._run_camera_ocr", return_value="HELLO WORLD"):
                result = registry.TOOLS["readCameraText"]({"max_chars": 50})

        self.assertIn("text", result)
        self.assertEqual("HELLO WORLD", result["text"])

    def test_camera_retry_handles_empty_initial_reads(self):
        class FakeCapture:
            def __init__(self):
                self.attempts = 0

            def isOpened(self):
                return True

            def read(self):
                self.attempts += 1
                if self.attempts < 3:
                    return False, None
                return True, np.zeros((40, 40, 3), dtype=np.uint8)

            def release(self):
                pass

        with patch("desktop_agent.tools_camera.cv2.VideoCapture", return_value=FakeCapture()):
            with patch("desktop_agent.tools_camera._run_camera_ocr", return_value="HELLO WORLD"):
                result = registry.TOOLS["readCameraText"]({"max_chars": 50})

        self.assertEqual("HELLO WORLD", result["text"])


if __name__ == "__main__":
    unittest.main()
