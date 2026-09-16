"""
OS-level mouse and cursor control via pyautogui.

Complements Playwright browser automation (tools_browser) which only controls
the headed Chromium page. These tools move the real Windows cursor, click,
drag, and scroll at OS coordinates — needed when the user says "move cursor",
"click at 500 300", "double click", etc.

All handlers are synchronous and raise ToolError on failure so main.py maps
them to {ok: false, error}. Coordinates are in screen pixels (pyautogui
coordinate space, which already accounts for DPI virtualization when
PyAutoGUI handles it).
"""

from __future__ import annotations

from typing import Any, Dict

from desktop_agent.registry import ToolError, register


def _require_pyautogui():
    try:
        import pyautogui  # type: ignore

        # Disable the corner failsafe that raises FailSafeException when the
        # cursor hits (0,0) — the agent should never be blocked by it.
        try:
            pyautogui.FAILSAFE = False
        except Exception:
            pass
        return pyautogui
    except Exception as e:  # noqa: BLE001
        raise ToolError(f"pyautogui not available: {e}")


def _clamp(n, lo, hi):
    try:
        v = int(n)
    except Exception:
        raise ToolError(f"Coordinate must be an integer, got {n!r}")
    return max(lo, min(hi, v))


@register("getMousePosition")
def get_mouse_position(args: Dict[str, Any]) -> Dict[str, Any]:
    pg = _require_pyautogui()
    try:
        x, y = pg.position()
        w, h = pg.size()
        return {"result": f"Cursor at ({x}, {y}) screen {w}x{h}.", "x": x, "y": y, "width": w, "height": h}
    except Exception as e:  # noqa: BLE001
        raise ToolError(f"Could not get cursor position: {e}")


@register("moveMouse")
def move_mouse(args: Dict[str, Any]) -> Dict[str, Any]:
    if "x" not in args or "y" not in args:
        raise ToolError("Parameters 'x' and 'y' (screen pixels) are required.")
    pg = _require_pyautogui()
    w, h = pg.size()
    x = _clamp(args["x"], 0, w - 1)
    y = _clamp(args["y"], 0, h - 1)
    duration = float(args.get("duration", 0.2))
    duration = max(0.0, min(5.0, duration))
    try:
        pg.moveTo(x, y, duration=duration)
        # Verify
        nx, ny = pg.position()
        return {"result": f"Moved cursor to ({x}, {y}) now at ({nx}, {ny}).", "x": nx, "y": ny}
    except Exception as e:  # noqa: BLE001
        raise ToolError(f"moveMouse failed: {e}")


@register("clickMouse")
def click_mouse(args: Dict[str, Any]) -> Dict[str, Any]:
    pg = _require_pyautogui()
    # Optional move first
    w, h = pg.size()
    x_raw = args.get("x")
    y_raw = args.get("y")
    button = (args.get("button") or "left").strip().lower()
    if button not in ("left", "right", "middle"):
        raise ToolError("Parameter 'button' must be left, right, or middle.")
    clicks = int(args.get("clicks", 1))
    clicks = max(1, min(3, clicks))
    interval = float(args.get("interval", 0.1))
    try:
        if x_raw is not None and y_raw is not None:
            x = _clamp(x_raw, 0, w - 1)
            y = _clamp(y_raw, 0, h - 1)
            pg.click(x=x, y=y, clicks=clicks, interval=interval, button=button)
            nx, ny = pg.position()
            return {"result": f"Clicked {button} {clicks}x at ({x}, {y}) now at ({nx}, {ny}).", "x": nx, "y": ny}
        else:
            # Click at current position
            x, y = pg.position()
            pg.click(clicks=clicks, interval=interval, button=button)
            return {"result": f"Clicked {button} {clicks}x at current position ({x}, {y}).", "x": x, "y": y}
    except Exception as e:  # noqa: BLE001
        raise ToolError(f"clickMouse failed: {e}")


@register("doubleClickMouse")
def double_click_mouse(args: Dict[str, Any]) -> Dict[str, Any]:
    # Sugar over clickMouse with 2 clicks
    nxt = dict(args)
    nxt["clicks"] = 2
    return click_mouse(nxt)


@register("dragMouse")
def drag_mouse(args: Dict[str, Any]) -> Dict[str, Any]:
    if "x" not in args or "y" not in args:
        raise ToolError("Parameters 'x' and 'y' (target) are required.")
    pg = _require_pyautogui()
    w, h = pg.size()
    x = _clamp(args["x"], 0, w - 1)
    y = _clamp(args["y"], 0, h - 1)
    duration = float(args.get("duration", 0.4))
    duration = max(0.0, min(5.0, duration))
    button = (args.get("button") or "left").lower()
    try:
        start_x, start_y = pg.position()
        pg.dragTo(x, y, duration=duration, button=button)
        nx, ny = pg.position()
        return {"result": f"Dragged {button} from ({start_x}, {start_y}) to ({x}, {y}) now at ({nx}, {ny}).", "x": nx, "y": ny}
    except Exception as e:  # noqa: BLE001
        raise ToolError(f"dragMouse failed: {e}")


@register("scrollMouse")
def scroll_mouse(args: Dict[str, Any]) -> Dict[str, Any]:
    pg = _require_pyautogui()
    amount = int(args.get("amount", 300))
    # pyautogui.scroll positive = up, negative = down on Windows
    # Normalize direction param for LLM ergonomics
    direction = (args.get("direction") or "down").lower()
    clicks = amount // 100
    if clicks == 0:
        clicks = 1 if amount > 0 else -1
    else:
        clicks = clicks if direction == "up" else -abs(clicks)
        if direction == "down" and clicks > 0:
            clicks = -clicks
        if direction == "up" and clicks < 0:
            clicks = -clicks
    try:
        # If x,y provided, move first then scroll
        if args.get("x") is not None and args.get("y") is not None:
            w, h = pg.size()
            x = _clamp(args["x"], 0, w - 1)
            y = _clamp(args["y"], 0, h - 1)
            pg.moveTo(x, y, duration=0.1)
        pg.scroll(clicks * 120)  # 120 is one notch on Windows
        return {"result": f"Scrolled {direction} {abs(amount)}px ({clicks} notches)."}
    except Exception as e:  # noqa: BLE001
        raise ToolError(f"scrollMouse failed: {e}")


@register("clickText")
def click_text(args: Dict[str, Any]) -> Dict[str, Any]:
    """
    Find visible text on screen via OCR and click its center.

    Use when user says "click on chat named xyz in inbox", "open chat xyz",
    or any text target that requires vision. More reliable than guessing
    coordinates via screen share frames.
    """
    target = (args.get("text") or args.get("query") or "").strip()
    if not target:
        raise ToolError("Parameter 'text' (visible label to click) is required.")
    button = (args.get("button") or "left").lower()
    if button not in ("left", "right", "middle"):
        button = "left"
    clicks = int(args.get("clicks", 1))

    # Capture full screen
    try:
        from PIL import Image  # noqa: F401
    except Exception as e:  # noqa: BLE001
        raise ToolError(f"Pillow not available: {e}")

    try:
        # Reuse screenshot logic; prefer pyautogui screenshot for coordinate alignment
        pg = _require_pyautogui()
        try:
            # pyautogui screenshot uses same virtual coords as moveTo/click
            img = pg.screenshot()
        except Exception:
            # Fallback to ImageGrab
            from PIL import ImageGrab

            img = ImageGrab.grab(all_screens=True)
    except Exception as e:  # noqa: BLE001
        raise ToolError(f"Screen capture failed: {e}")

    # OCR with bounding boxes
    try:
        import pytesseract  # type: ignore
        import os

        exe = os.environ.get("TESSERACT_PATH")
        if exe and os.path.exists(exe):
            pytesseract.pytesseract.tesseract_cmd = exe
        else:
            # Try common paths
            for cand in [r"C:\Program Files\Tesseract-OCR\tesseract.exe", r"C:\Program Files (x86)\Tesseract-OCR\tesseract.exe"]:
                if os.path.exists(cand):
                    pytesseract.pytesseract.tesseract_cmd = cand
                    break
        data = pytesseract.image_to_data(img, output_type=pytesseract.Output.DICT)
    except ImportError:
        raise ToolError("pytesseract not installed. Install Tesseract OCR engine.")
    except Exception as e:  # noqa: BLE001
        raise ToolError(f"OCR failed: {e}. Is Tesseract installed?")

    n = len(data.get("text", []))
    target_low = target.lower()
    target_tokens = [t for t in target_low.split() if t]

    def _norm(s: str) -> str:
        return s.strip().lower()

    # Build word list with boxes, filter low confidence and empty
    words = []
    for i in range(n):
        txt = (data["text"][i] or "").strip()
        conf = int(data["conf"][i]) if str(data["conf"][i]).lstrip("-").isdigit() else -1
        if not txt or conf < 30:
            continue
        words.append({
            "text": txt,
            "left": int(data["left"][i]),
            "top": int(data["top"][i]),
            "width": int(data["width"][i]),
            "height": int(data["height"][i]),
            "conf": conf,
        })

    if not words:
        raise ToolError(f"OCR found no readable text (looked for '{target}'). Try takeScreenshot with include_image or ensure screen is visible.")

    # 1) Try exact phrase window (for multi-word like "xyz chat")
    best = None
    if len(target_tokens) > 1:
        for i in range(len(words) - len(target_tokens) + 1):
            window = words[i:i+len(target_tokens)]
            window_txt = " ".join(_norm(w["text"]) for w in window)
            if _norm(target) in window_txt or window_txt in _norm(target):
                # Combine boxes
                left = min(w["left"] for w in window)
                top = min(w["top"] for w in window)
                right = max(w["left"]+w["width"] for w in window)
                bottom = max(w["top"]+w["height"] for w in window)
                best = {"left": left, "top": top, "width": right-left, "height": bottom-top, "text": window_txt}
                break
            # Token-wise partial match
            if all(t in _norm(window_txt) for t in target_tokens):
                left = min(w["left"] for w in window)
                top = min(w["top"] for w in window)
                right = max(w["left"]+w["width"] for w in window)
                bottom = max(w["top"]+w["height"] for w in window)
                best = {"left": left, "top": top, "width": right-left, "height": bottom-top, "text": window_txt}
                break

    # 2) Single token exact or substring match (prefer higher confidence)
    if best is None:
        candidates = []
        for w in words:
            wt = _norm(w["text"])
            if target_low == wt or target_low in wt or wt in target_low:
                candidates.append(w)
        if candidates:
            # Pick highest confidence
            candidates.sort(key=lambda x: x["conf"], reverse=True)
            best = candidates[0]
        else:
            # 3) Fuzzy: any word contains any token
            for w in words:
                wt = _norm(w["text"])
                if any(t in wt or wt in t for t in target_tokens):
                    best = w
                    break

    if best is None:
        # Debug aid: list nearby words
        sample = ", ".join(w["text"] for w in words[:20])
        raise ToolError(f"Text '{target}' not found on screen. Visible sample: {sample}... Use takeScreenshot or scrollMouse to bring it into view.")

    cx = best["left"] + best["width"] // 2
    cy = best["top"] + best["height"] // 2

    pg = _require_pyautogui()
    try:
        pg.moveTo(cx, cy, duration=0.15)
        pg.click(x=cx, y=cy, clicks=clicks, button=button)
        nx, ny = pg.position()
        return {"result": f"Clicked '{target}' at ({cx}, {cy}) matched '{best['text']}' now at ({nx}, {ny}).", "x": cx, "y": cy, "matched": best["text"]}
    except Exception as e:  # noqa: BLE001
        raise ToolError(f"clickText failed at ({cx}, {cy}): {e}")


# Alias for older clients that send "scroll" instead of "scrollMouse"
@register("scroll")
def scroll_alias(args: Dict[str, Any]) -> Dict[str, Any]:
    return scroll_mouse(args)


__all__ = [
    "get_mouse_position",
    "move_mouse",
    "click_mouse",
    "double_click_mouse",
    "drag_mouse",
    "scroll_mouse",
    "click_text",
    "scroll_alias",
]
