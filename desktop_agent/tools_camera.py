"""
Camera capture tool for seeing objects outside the machine and processing them.

Exposes capture/analyze/ocr over the default webcam. On Windows the default
MSMF backend is exclusive and often returns MF_E_INVALIDREQUEST (-1072875772)
when the browser's getUserMedia already holds the device, or when the first
frame is read too early. This module therefore:

  * Tries multiple backends (DSHOW -> MSMF -> ANY) to find one that can open
    the device. DSHOW is tried first because it tolerates shared access better.
  * Warms up the sensor after open (sleep + discard frames) before the real read.
  * Accepts an optional `image_base64` arg so the frontend can pass a browser-
    captured JPEG and avoid touching the hardware at all when the preview is
    active — this completely bypasses the MSMF busy conflict.
"""

from __future__ import annotations

import base64
import os
import time
from typing import Any, Dict, Optional, Tuple

try:
    import cv2
except Exception:  # pragma: no cover
    cv2 = None

try:
    import numpy as np
except Exception:  # pragma: no cover
    np = None

from desktop_agent.registry import ToolError, register


def _find_tesseract_exe() -> Optional[str]:
    candidates = [
        r"C:\Program Files\Tesseract-OCR\tesseract.exe",
        r"C:\Program Files (x86)\Tesseract-OCR\tesseract.exe",
    ]
    for cand in candidates:
        if os.path.exists(cand):
            return cand
    return None


def _run_camera_ocr(frame) -> str:
    try:
        import pytesseract
    except ImportError:
        raise ToolError("OCR unavailable: the 'pytesseract' package is not installed.")

    exe = os.environ.get("TESSERACT_PATH") or _find_tesseract_exe()
    if exe:
        pytesseract.pytesseract.tesseract_cmd = exe

    try:
        return pytesseract.image_to_string(frame)
    except Exception as exc:
        raise ToolError("Camera OCR failed: " + str(exc))


def _frame_size(frame) -> Tuple[int, int]:
    if hasattr(frame, "shape") and len(frame.shape) >= 2:
        return int(frame.shape[1]), int(frame.shape[0])
    if isinstance(frame, (list, tuple)) and frame and isinstance(frame[0], (list, tuple)):
        return len(frame[0]), len(frame)
    return 0, 0


def _normalize_frame(frame):
    if np is not None and not hasattr(frame, "shape"):
        return np.asarray(frame, dtype=np.uint8)
    return frame


# ---------------------------------------------------------------------------
# Helpers to allow browser-supplied frames to bypass hardware capture entirely.
# ---------------------------------------------------------------------------

def _decode_base64_frame(b64: str):
    """Decode a base64 JPEG/PNG string into an OpenCV BGR frame.

    Accepts both raw base64 and data-URL (data:image/jpeg;base64,...).
    """
    if not b64 or not isinstance(b64, str):
        raise ToolError("Invalid image_base64: expected a non-empty base64 string.")
    # Strip data-URL prefix if present.
    if "," in b64 and b64.strip().startswith("data:"):
        b64 = b64.split(",", 1)[1]
    # Some frontends may include whitespace/newlines.
    b64 = b64.strip()
    # Padding fix.
    missing = len(b64) % 4
    if missing:
        b64 += "=" * (4 - missing)
    try:
        raw = base64.b64decode(b64)
    except Exception as exc:
        raise ToolError(f"Failed to decode image_base64: {exc}")
    if np is None or cv2 is None:
        raise ToolError("Cannot decode image_base64: OpenCV/numpy not available.")
    try:
        arr = np.frombuffer(raw, dtype=np.uint8)
        frame = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    except Exception as exc:
        raise ToolError(f"Failed to decode image_base64 to frame: {exc}")
    if frame is None:
        raise ToolError("Failed to decode image_base64: cv2.imdecode returned None (corrupt JPEG?).")
    w, h = _frame_size(frame)
    if w == 0 or h == 0:
        raise ToolError("Decoded image_base64 has zero dimensions.")
    return frame


def _frame_from_args(args: Dict[str, Any]):
    """Return a frame from args if image_base64/image_b64/frame_base64 supplied, else None."""
    for key in ("image_base64", "image_b64", "frame_base64", "frame", "image"):
        val = args.get(key)
        if isinstance(val, str) and len(val) > 100:
            # Heuristic: base64 JPEGs are long; avoid treating short strings as images.
            try:
                return _decode_base64_frame(val)
            except ToolError:
                # Re-raise with context.
                raise
            except Exception as exc:
                raise ToolError(f"Failed to use {key}: {exc}")
        # Also handle already-decoded dict with inline data?
    return None


# ---------------------------------------------------------------------------
# Robust camera open + read
# ---------------------------------------------------------------------------

def _camera_available() -> bool:
    if cv2 is None:
        return False
    # Lightweight check: try DSHOW then MSMF. Don't hold device long.
    backends = []
    if hasattr(cv2, "CAP_DSHOW"):
        backends.append(cv2.CAP_DSHOW)
    if hasattr(cv2, "CAP_MSMF"):
        backends.append(cv2.CAP_MSMF)
    backends.append(cv2.CAP_ANY)
    for backend in backends:
        cap = None
        try:
            cap = cv2.VideoCapture(0, backend) if backend != cv2.CAP_ANY else cv2.VideoCapture(0)
            if cap is not None and cap.isOpened():
                return True
        except Exception:
            pass
        finally:
            try:
                if cap is not None:
                    cap.release()
            except Exception:
                pass
    return False


def _open_camera(cam_id: int):
    """Open camera with backend fallback and warmup. Returns opened VideoCapture.

    Raises ToolError with a descriptive message if the device cannot be opened.
    This handles the common Windows case where MSMF returns
    -1072875772 (MF_E_INVALIDREQUEST) because the browser getUserMedia already
    holds the device exclusively.
    """
    if cv2 is None:
        raise ToolError("Camera support is unavailable because OpenCV is not installed.")

    backends = []
    # DSHOW first: more tolerant of shared access on Windows.
    if hasattr(cv2, "CAP_DSHOW"):
        backends.append(("DSHOW", cv2.CAP_DSHOW))
    if hasattr(cv2, "CAP_MSMF"):
        backends.append(("MSMF", cv2.CAP_MSMF))
    backends.append(("ANY", cv2.CAP_ANY))

    last_error = None
    for name, backend in backends:
        cap = None
        try:
            if backend == cv2.CAP_ANY:
                cap = cv2.VideoCapture(cam_id)
            else:
                cap = cv2.VideoCapture(cam_id, backend)

            if cap is None or not cap.isOpened():
                last_error = f"backend {name} could not open device {cam_id}"
                if cap is not None:
                    try:
                        cap.release()
                    except Exception:
                        pass
                continue

            # Warmup: give the sensor time and discard unstable initial frames.
            # MSMF in particular needs ~300-500ms before first valid frame.
            try:
                # Request a reasonable resolution to avoid driver renegotiation stalls.
                # Don't force if it fails — just best-effort.
                cap.set(cv2.CAP_PROP_FRAME_WIDTH, 1280)
                cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 720)
            except Exception:
                pass

            time.sleep(0.40)

            # Discard up to 8 initial reads (some may be empty).
            for _ in range(8):
                try:
                    cap.read()
                except Exception:
                    pass
                time.sleep(0.06)

            # Verify at least one more read would succeed without consuming too much.
            # We don't consume the "good" frame here; _read_camera_frame will read it.
            # But probe with grab() to ensure pipeline is alive.
            ok_probe = True
            try:
                # grab is cheaper and tests pipeline liveness; if it raises, treat as failure.
                if hasattr(cap, "grab"):
                    cap.grab()
            except Exception as exc:
                ok_probe = False
                last_error = f"backend {name} grab probe failed: {exc}"

            if not ok_probe:
                try:
                    cap.release()
                except Exception:
                    pass
                continue

            return cap

        except Exception as exc:
            last_error = f"backend {name} exception: {exc}"
            if cap is not None:
                try:
                    cap.release()
                except Exception:
                    pass
            continue

    # All backends failed.
    hint = ""
    # Common case: browser preview is holding the device exclusively.
    if last_error and ("could not open" in last_error.lower() or "grab" in last_error.lower()):
        hint = (
            " The camera may be in use by the browser preview (getUserMedia holds "
            "an exclusive lock on Windows). Try closing the browser camera preview or "
            "pass image_base64 from the frontend instead of opening the device."
        )
    raise ToolError(
        f"Could not open camera device {cam_id}. Tried backends {[n for n,_ in backends]}."
        f" Last error: {last_error or 'unknown'}.{hint}"
    )


def _read_camera_frame(cap, attempts: int = 12):
    """Read a valid frame from an already-opened capture.

    Retries with increasing backoff. Handles the MSMF -1072875772 transient where
    first reads return ok=False/null.
    """
    last_error = None
    for idx in range(attempts):
        try:
            ok, frame = cap.read()
            if ok and frame is not None:
                frame = _normalize_frame(frame)
                if frame is not None:
                    width, height = _frame_size(frame)
                    if width > 0 and height > 0:
                        return frame
                    last_error = f"Camera returned zero-size frame ({width}x{height})."
                else:
                    last_error = "Camera returned None after normalize."
            else:
                # Map OpenCV's silent failure to a diagnosable message.
                last_error = "Camera captured no frame."
                # In MSMF failure mode the internal error is MF_E_INVALIDREQUEST (-1072875772)
                # which surfaces as ok=False without exception. Try grab() to flush pipeline.
                if hasattr(cap, "grab"):
                    try:
                        cap.grab()
                    except Exception:
                        pass
        except Exception as exc:
            # Include the underlying numeric error if present.
            last_error = str(exc) or "Camera captured no frame."
        # Progressive backoff: 0.18s, then 0.25s, up to ~0.3s
        sleep_s = 0.18 if idx < 2 else 0.25 if idx < 6 else 0.32
        try:
            time.sleep(sleep_s)
        except Exception:
            pass
    # If we get here every attempt failed.
    raise ToolError(
        last_error or "Camera captured no frame."
        + " (MSMF error -1072875772 often means the device is busy or needs more warmup; "
        + "close any browser camera preview or pass image_base64)."
    )


# ---------------------------------------------------------------------------
# Shared helpers for encoding
# ---------------------------------------------------------------------------

def _encode_jpeg(frame, max_dim: int = 1280):
    """Resize if needed and JPEG-encode, returning (b64, width, height)."""
    width, height = _frame_size(frame)
    if width == 0 or height == 0:
        raise ToolError("Camera returned an unusable frame.")

    scale = min(1.0, max_dim / float(max(width, height))) if max_dim and max(width, height) > 0 else 1.0
    if scale < 1.0:
        try:
            frame = cv2.resize(frame, (max(1, int(width * scale)), max(1, int(height * scale))))
            width, height = _frame_size(frame)
        except Exception:
            pass
    try:
        is_success, buffer = cv2.imencode(".jpg", frame, [int(cv2.IMWRITE_JPEG_QUALITY), 70])
        if not is_success:
            raise ToolError("Failed to encode camera frame.")
        encoded = base64.b64encode(buffer).decode("ascii")
        return encoded, int(width), int(height), frame
    except ToolError:
        raise
    except Exception as exc:
        raise ToolError(f"Failed to encode camera frame: {exc}")


@register("captureCameraFrame")
def capture_camera_frame(args: Dict[str, Any]) -> Dict[str, Any]:
    """Capture a still frame from the default camera and return compact image data.

    If `image_base64` (or aliases) is supplied, the provided browser-captured frame
    is used directly instead of opening the hardware — this avoids the Windows
    MSMF exclusive-lock conflict when the preview is active.
    """
    if cv2 is None:
        raise ToolError("Camera support is unavailable because OpenCV is not installed.")

    cam_id = int(args.get("camera_id", 0))
    include_image = bool(args.get("include_image", True))
    max_dim = int(args.get("max_dim", 1280))

    # Fast path: browser already captured a frame.
    frame_from_browser = None
    try:
        frame_from_browser = _frame_from_args(args)
    except ToolError:
        raise
    except Exception as exc:
        raise ToolError(f"Failed to decode supplied image_base64: {exc}")

    if frame_from_browser is not None:
        frame = frame_from_browser
        width, height = _frame_size(frame)
        if include_image and width and height:
            encoded, width, height, _ = _encode_jpeg(frame, max_dim)
            return {
                "result": f"Captured camera frame from browser image (device {cam_id} bypassed).",
                "camera_id": cam_id,
                "width": int(width),
                "height": int(height),
                "image_base64": encoded,
                "image_mime": "image/jpeg",
            }
        return {
            "result": f"Captured camera frame from browser image (device {cam_id} bypassed).",
            "camera_id": cam_id,
            "width": int(width),
            "height": int(height),
        }

    cap = _open_camera(cam_id)
    try:
        frame = _read_camera_frame(cap)
        width, height = _frame_size(frame)

        if include_image and width and height:
            encoded, width, height, _ = _encode_jpeg(frame, max_dim)
            return {
                "result": f"Captured camera frame from device {cam_id}.",
                "camera_id": cam_id,
                "width": int(width),
                "height": int(height),
                "image_base64": encoded,
                "image_mime": "image/jpeg",
            }

        return {
            "result": f"Captured camera frame from device {cam_id}.",
            "camera_id": cam_id,
            "width": int(width),
            "height": int(height),
        }
    finally:
        try:
            cap.release()
        except Exception:
            pass


@register("analyzeCameraFrame")
def analyze_camera_frame(args: Dict[str, Any]) -> Dict[str, Any]:
    """Capture a live frame and summarize the scene: object count and rough scene type.

    Accepts optional `image_base64` to bypass hardware capture when the frontend
    already holds the camera stream.
    """
    if cv2 is None:
        raise ToolError("Camera support is unavailable because OpenCV is not installed.")

    cam_id = int(args.get("camera_id", 0))
    include_image = bool(args.get("include_image", True))
    max_dim = int(args.get("max_dim", 1280))

    frame_from_browser = None
    try:
        frame_from_browser = _frame_from_args(args)
    except ToolError:
        raise

    cap = None
    if frame_from_browser is not None:
        frame = frame_from_browser
    else:
        cap = _open_camera(cam_id)
        try:
            frame = _read_camera_frame(cap)
        except Exception:
            try:
                cap.release()
            except Exception:
                pass
            cap = None
            raise

    try:
        width, height = _frame_size(frame)
        if width == 0 or height == 0:
            raise ToolError("Camera returned an unusable frame.")

        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY) if len(frame.shape) == 3 else frame
        blurred = cv2.GaussianBlur(gray, (5, 5), 0)
        _, thresh = cv2.threshold(blurred, 127, 255, cv2.THRESH_BINARY)
        contours, _ = cv2.findContours(thresh, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

        large_contours = [cnt for cnt in contours if cv2.contourArea(cnt) > max(20.0, 0.01 * width * height)]
        object_count = len(large_contours)
        brightness = float(gray.mean())
        if brightness > 180:
            scene_type = "bright scene"
        elif brightness < 60:
            scene_type = "dark scene"
        else:
            scene_type = "balanced scene"

        if object_count == 0:
            scene_summary = "No obvious foreground objects detected; the scene looks mostly empty or uniform."
        elif object_count == 1:
            scene_summary = "One dominant object region was detected, suggesting a single primary subject in view."
        else:
            scene_summary = f"{object_count} significant object regions were detected, suggesting multiple visible subjects or surfaces."

        payload: Dict[str, Any] = {
            "result": "Camera frame analyzed.",
            "camera_id": cam_id,
            "scene_type": scene_type,
            "scene_summary": scene_summary,
            "objects_detected": object_count,
            "brightness": round(brightness, 2),
            "width": int(width),
            "height": int(height),
        }

        if include_image:
            try:
                encoded, w2, h2, _ = _encode_jpeg(frame, max_dim)
                payload["image_base64"] = encoded
                payload["image_mime"] = "image/jpeg"
                # Use the resized dimensions if encoding resized.
                payload["width"] = int(w2)
                payload["height"] = int(h2)
            except Exception:
                pass

        return payload
    finally:
        if cap is not None:
            try:
                cap.release()
            except Exception:
                pass


@register("readCameraText")
def read_camera_text(args: Dict[str, Any]) -> Dict[str, Any]:
    """Capture a camera frame and OCR visible text in the scene.

    Accepts optional `image_base64` to bypass hardware capture.
    """
    if cv2 is None:
        raise ToolError("Camera support is unavailable because OpenCV is not installed.")

    cam_id = int(args.get("camera_id", 0))
    max_chars = int(args.get("max_chars", 1500))
    include_image = bool(args.get("include_image", True))
    max_dim = int(args.get("max_dim", 1280))

    frame_from_browser = None
    try:
        frame_from_browser = _frame_from_args(args)
    except ToolError:
        raise

    cap = None
    if frame_from_browser is not None:
        frame = frame_from_browser
    else:
        cap = _open_camera(cam_id)
        try:
            frame = _read_camera_frame(cap)
        except Exception:
            try:
                cap.release()
            except Exception:
                pass
            cap = None
            raise

    try:
        text = _run_camera_ocr(frame)
        cleaned = "\n".join(line.strip() for line in text.splitlines() if line.strip())
        if len(cleaned) > max_chars:
            cleaned = cleaned[:max_chars] + "…"

        payload: Dict[str, Any] = {
            "result": "Camera text read via OCR.",
            "camera_id": cam_id,
            "text": cleaned or "(no readable text)",
            "width": int(_frame_size(frame)[0]),
            "height": int(_frame_size(frame)[1]),
        }

        if include_image:
            try:
                encoded, w2, h2, _ = _encode_jpeg(frame, max_dim)
                payload["image_base64"] = encoded
                payload["image_mime"] = "image/jpeg"
                payload["width"] = int(w2)
                payload["height"] = int(h2)
            except Exception:
                pass

        return payload
    finally:
        if cap is not None:
            try:
                cap.release()
            except Exception:
                pass


__all__ = ["capture_camera_frame", "analyze_camera_frame", "read_camera_text", "_camera_available", "_run_camera_ocr"]
