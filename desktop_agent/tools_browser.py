"""
Browser automation via Playwright.

Runs a single persistent headed Chromium instance owned by this agent and used
for real desktop browser automation. It is separate from the app UI and is not
an embedded preview or a test-mode browser.

Capabilities: open/navigate, new/close tabs, search, click, type, fill forms,
back/forward, scroll. Lazy-initialized; robust to closed pages.
"""

from __future__ import annotations

import asyncio
import re
import threading
from typing import Any, Dict, List, Optional
from urllib.parse import quote_plus

from .registry import STATE, ToolError, register

# A dedicated event loop + thread runs all Playwright coroutines, because
# Playwright's sync API can deadlock under FastAPI's threadpool. We use the
# async API marshalled through a single loop.
_LOOP: Optional[asyncio.AbstractEventLoop] = None
_LOOP_THREAD: Optional[threading.Thread] = None
_LOOP_LOCK = threading.Lock()


def _get_loop() -> "asyncio.AbstractEventLoop":
    global _LOOP, _LOOP_THREAD
    with _LOOP_LOCK:
        if _LOOP is None or _LOOP.is_closed():
            _LOOP = asyncio.new_event_loop()
            _LOOP_THREAD = threading.Thread(target=_run_loop, daemon=True)
            _LOOP_THREAD.start()
        return _LOOP


def _run_loop() -> None:
    loop = _LOOP
    assert loop is not None
    asyncio.set_event_loop(loop)
    try:
        loop.run_forever()
    finally:
        try:
            loop.close()
        except Exception:
            pass


def _run(coro):
    """Submit a coroutine to the dedicated Playwright loop and block on it."""
    loop = _get_loop()
    future = asyncio.run_coroutine_threadsafe(coro, loop)
    return future.result(timeout=60)


def _page_is_usable(page: Any) -> bool:
    """Return True only for a non-closed page that still responds safely."""
    if page is None:
        return False
    try:
        if hasattr(page, "is_closed") and page.is_closed():
            return False
    except Exception:
        return False
    try:
        _ = page.url
        return True
    except Exception:
        return False


def _reset_stale_browser_state() -> None:
    """Clear cached Playwright state when the browser/page context has been closed."""
    try:
        if STATE.page is not None and not _page_is_usable(STATE.page):
            STATE.page = None
        if STATE.context is not None:
            try:
                _ = len(STATE.context.pages)
            except Exception:
                STATE.context = None
        if STATE.browser is not None:
            try:
                if not STATE.browser.is_connected():
                    STATE.browser = None
            except Exception:
                STATE.browser = None
        if STATE.playwright is not None:
            try:
                _ = STATE.playwright.chromium
            except Exception:
                STATE.playwright = None
    except Exception:
        pass

    if STATE.page is None:
        STATE.page = None
    if STATE.context is None:
        STATE.context = None
    if STATE.browser is None:
        STATE.browser = None
    if STATE.playwright is None:
        STATE.playwright = None


def _is_closed_browser_error(exc: BaseException | Exception) -> bool:
    message = str(exc).lower()
    return "target page, context or browser has been closed" in message or "browser has been closed" in message


async def _with_browser_recovery(action_name: str, action):
    """Retry a browser action once after resetting stale Playwright state."""
    page = await _page()
    try:
        return await action(page)
    except Exception as exc:  # noqa: BLE001
        if not _is_closed_browser_error(exc):
            raise
        STATE.reset_playwright()
        page = await _page()
        try:
            return await action(page)
        except Exception as retry_exc:  # noqa: BLE001
            raise ToolError(f"{action_name} failed after browser reset: {retry_exc}")


# --- Async Playwright lifecycle ---------------------------------------------


async def _ensure_browser_async() -> Any:
    _reset_stale_browser_state()

    if STATE.browser is not None:
        try:
            if not STATE.browser.is_connected():
                STATE.reset_playwright()
        except Exception:
            STATE.reset_playwright()

    if STATE.page is not None:
        try:
            if not _page_is_usable(STATE.page):
                STATE.reset_playwright()
                _reset_stale_browser_state()
                raise RuntimeError("stale page detected")
            return STATE.page
        except Exception:
            STATE.reset_playwright()
            _reset_stale_browser_state()

    if STATE.playwright is None:
        from playwright.async_api import async_playwright

        STATE.playwright = await async_playwright().start()

    if STATE.browser is None:
        STATE.browser = await STATE.playwright.chromium.launch(
            headless=False,
            args=["--start-maximized", "--no-sandbox"],
        )
        STATE.context = await STATE.browser.new_context(viewport=None)

    if STATE.context is None:
        STATE.context = await STATE.browser.new_context(viewport=None)

    pages = STATE.context.pages
    if pages:
        STATE.page = pages[-1]
    else:
        STATE.page = await STATE.context.new_page()
    return STATE.page


async def _page() -> Any:
    return await _ensure_browser_async()


def _normalize_url(raw: str) -> str:
    url = raw.strip()
    if not url:
        raise ToolError("Empty URL.")
    if "://" not in url:
        url = "https://" + url
    return url


# --- Handlers ---------------------------------------------------------------


@register("desktopBrowserOpen")
async def browser_open(args: Dict[str, Any]) -> Dict[str, Any]:
    url = _normalize_url(args.get("url") or "https://www.google.com")
    page = await _page()
    try:
        await page.goto(url, wait_until="domcontentloaded", timeout=20000)
    except Exception as e:  # noqa: BLE001
        raise ToolError(f"Could not open {url}: {e}")
    return {"result": f"Opened {url} in the automation browser.", "url": page.url}


@register("desktopBrowserNavigate")
async def browser_navigate(args: Dict[str, Any]) -> Dict[str, Any]:
    # Alias of desktopBrowserOpen, retained for clarity.
    return await browser_open(args)


@register("desktopBrowserOpenTab")
async def browser_open_tab(args: Dict[str, Any]) -> Dict[str, Any]:
    url = _normalize_url(args.get("url") or "about:blank")
    await _ensure_browser_async()
    ctx = STATE.context
    page = await ctx.new_page()
    STATE.page = page  # make it active
    if url != "about:blank":
        try:
            await page.goto(url, wait_until="domcontentloaded", timeout=20000)
        except Exception as e:  # noqa: BLE001
            raise ToolError(f"Opened tab but navigation failed: {e}")
    return {"result": f"New tab opened at {url}.", "url": url}


@register("desktopBrowserCloseTab")
async def browser_close_tab(args: Dict[str, Any]) -> Dict[str, Any]:
    page = await _page()
    try:
        await page.close()
    except Exception:
        pass
    pages = STATE.context.pages if STATE.context else []
    STATE.page = pages[-1] if pages else None
    if STATE.page is None:
        return {"result": "Closed the last tab; browser now empty."}
    return {"result": f"Closed tab. Active tab now: {STATE.page.url}"}


@register("desktopBrowserSearch")
async def browser_search(args: Dict[str, Any]) -> Dict[str, Any]:
    query = args.get("query") or args.get("q")
    engine = (args.get("engine") or "google").strip().lower()
    if not query:
        raise ToolError("Parameter 'query' is required.")
    q = quote_plus(str(query))
    url = {
        "google": f"https://www.google.com/search?q={q}",
        "youtube": f"https://www.youtube.com/results?search_query={q}",
        "github": f"https://github.com/search?q={q}",
        "duckduckgo": f"https://duckduckgo.com/?q={q}",
        "bing": f"https://www.bing.com/search?q={q}",
    }.get(engine)
    if not url:
        raise ToolError(f"Unsupported engine '{engine}'.")
    page = await _page()
    try:
        await page.goto(url, wait_until="domcontentloaded", timeout=20000)
    except Exception as e:  # noqa: BLE001
        raise ToolError(f"Search navigation failed: {e}")
    return {"result": f"Searched {engine} for '{query}'.", "url": page.url}


async def _ocr_click_text(page: Any, text: str) -> bool:
    """Find visible text in a browser screenshot and click its OCR box center."""
    target = (text or "").strip()
    if not target:
        return False

    try:
        import os
        import tempfile

        from PIL import Image
        import pytesseract
    except Exception:
        return False

    try:
        with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as tmp:
            temp_path = tmp.name
        await page.screenshot(path=temp_path, type="png")
        image = Image.open(temp_path)
        try:
            data = pytesseract.image_to_data(image, output_type=pytesseract.Output.DICT)
        finally:
            try:
                os.unlink(temp_path)
            except Exception:
                pass

        target_lower = target.lower()
        best = None
        best_score = -1
        for i, word in enumerate(data.get("text", [])):
            cleaned = str(word).strip()
            if not cleaned:
                continue
            cleaned_lower = cleaned.lower()
            if target_lower in cleaned_lower or cleaned_lower in target_lower:
                score = 100 - abs(len(cleaned_lower) - len(target_lower))
                if score > best_score:
                    x = int(data["left"][i])
                    y = int(data["top"][i])
                    w = int(data["width"][i])
                    h = int(data["height"][i])
                    best = (x + w // 2, y + h // 2)
                    best_score = score

        if best is None:
            return False

        x, y = best
        await page.mouse.click(x, y)
        return True
    except Exception:
        return False


def _candidate_click_selectors(selector: Optional[str]) -> List[str]:
    """Expand a bare selector into likely CSS variants used by real pages."""
    raw = (selector or "").strip()
    if not raw:
        return []

    candidates: List[str] = []
    seen = set()

    for value in [raw, raw.lstrip("#."), raw.replace("#", "").replace(".", "")]:
        if value and value not in seen:
            candidates.append(value)
            seen.add(value)

    if not any(ch in raw for ch in ["#", ".", "[", " ", ":", ">", "~", ",", "("]):
        for candidate in [
            f"#{raw}",
            f".{raw}",
            f"*[id='{raw}']",
            f"*[data-testid='{raw}']",
            f"[id='{raw}']",
            f"[class*='{raw}' i]",
            f"button[aria-label*='{raw}' i]",
            f"[aria-label*='{raw}' i]",
            f"[data-testid*='{raw}' i]",
        ]:
            if candidate not in seen:
                candidates.append(candidate)
                seen.add(candidate)

    if raw.lower().endswith("button"):
        short = raw[:-6].strip("#.")
        for candidate in [f"button[aria-label*='{short}' i]", f"[aria-label*='{short}' i]", f"#search-icon-legacy", f"#search-button", f"#search-icon"]:
            if candidate not in seen:
                candidates.append(candidate)
                seen.add(candidate)

    return candidates


def _label_match_variants(label: str) -> List[str]:
    """Generate likely readable names for a UI element, including shortened forms."""
    raw = re.sub(r"[_-]+", " ", (label or "").strip())
    if not raw:
        return []

    variants: List[str] = []
    seen = set()
    for value in [
        raw,
        raw.replace(" button", "").strip(),
        raw.replace(" btn", "").strip(),
        raw.replace(" icon", "").strip(),
        raw.replace(" search", "").strip(),
        raw.replace(" button", "").strip() + " button",
        raw.replace(" icon", "").strip() + " icon",
    ]:
        if value and value not in seen:
            variants.append(value)
            seen.add(value)

    if "search" in raw.lower():
        for value in ["Search", "search", "Search button", "Search Button", "Search icon", "Search Icon"]:
            if value not in seen:
                variants.append(value)
                seen.add(value)

    return variants


async def _click_with_fallback(page: Any, selector: Optional[str] = None, text: Optional[str] = None, description: Optional[str] = None) -> None:
    """Click by selector or text using a few Playwright fallbacks."""
    attempts: List[tuple[str, Any]] = []

    for candidate in _candidate_click_selectors(selector):
        attempts.append(("selector", lambda candidate=candidate: page.locator(candidate).first.click(timeout=5000, force=True)))

    label = (text or description or "").strip()
    if label:
        variants = _label_match_variants(label)
        for variant in variants:
            attempts.extend(
                [
                    ("role_button", lambda variant=variant: page.get_by_role("button", name=re.compile(re.escape(variant), re.IGNORECASE)).first.click(timeout=5000, force=True)),
                    ("text_exact_false", lambda variant=variant: page.get_by_text(variant, exact=False).first.click(timeout=5000, force=True)),
                    ("locator_has_text", lambda variant=variant: page.locator(f"button:has-text(\"{variant}\")").first.click(timeout=5000, force=True)),
                    ("role_has_text", lambda variant=variant: page.locator(f"[role=\"button\"]:has-text(\"{variant}\")").first.click(timeout=5000, force=True)),
                    ("aria_label", lambda variant=variant: page.locator(f"[aria-label*=\"{variant}\" i]", has_text=variant).first.click(timeout=5000, force=True)),
                ]
            )

    if not attempts:
        raise ToolError("Provide 'selector' or 'text' to click.")

    last_error: Exception | None = None
    for _, fn in attempts:
        try:
            await fn()
            return
        except Exception as exc:  # noqa: BLE001
            last_error = exc
            continue

    if text:
        try:
            if await _ocr_click_text(page, str(text)):
                return
        except Exception:
            pass

    if last_error is not None:
        raise ToolError(f"Click failed: {last_error}")
    raise ToolError("Click failed: no valid target found.")


@register("desktopBrowserClick")
async def browser_click(args: Dict[str, Any]) -> Dict[str, Any]:
    selector = args.get("selector")
    text = args.get("text") or args.get("description")
    description = args.get("description")

    async def _do_click(page: Any) -> Dict[str, Any]:
        try:
            await _click_with_fallback(page, selector=selector, text=text, description=description)
            return {"result": f"Clicked {selector or text or description}."}
        except Exception as e:  # noqa: BLE001
            raise ToolError(f"Click failed: {e}")

    return await _with_browser_recovery("Click", _do_click)


@register("desktopBrowserType")
async def browser_type(args: Dict[str, Any]) -> Dict[str, Any]:
    text = args.get("text")
    selector = args.get("selector")
    clear_first = bool(args.get("clear", True))
    if not text:
        raise ToolError("Parameter 'text' is required.")

    async def _do_type(page: Any) -> Dict[str, Any]:
        try:
            if selector:
                await page.fill(selector, str(text), timeout=5000)
            else:
                if clear_first:
                    await page.keyboard.press("Control+A")
                    await page.keyboard.press("Delete")
                await page.keyboard.type(str(text))
            return {"result": f"Typed {len(str(text))} characters."}
        except Exception as e:  # noqa: BLE001
            raise ToolError(f"Type failed: {e}")

    return await _with_browser_recovery("Type", _do_type)


@register("desktopBrowserFillForm")
async def browser_fill_form(args: Dict[str, Any]) -> Dict[str, Any]:
    """Fill multiple fields. fields = { selector: value, ... }"""
    fields = args.get("fields")
    submit = args.get("submit")  # optional selector to click after filling
    if not isinstance(fields, dict) or not fields:
        raise ToolError("Parameter 'fields' (object of selector->value) is required.")

    async def _do_fill(page: Any) -> Dict[str, Any]:
        filled = 0
        try:
            for sel, val in fields.items():
                await page.fill(str(sel), str(val), timeout=5000)
                filled += 1
            if submit:
                await page.click(str(submit), timeout=5000)
        except Exception as e:  # noqa: BLE001
            raise ToolError(f"Form fill failed after {filled} field(s): {e}")
        extra = " and submitted." if submit else "."
        return {"result": f"Filled {filled} field(s){extra}"}

    return await _with_browser_recovery("Form fill", _do_fill)


@register("desktopBrowserGoBack")
async def browser_go_back(args: Dict[str, Any]) -> Dict[str, Any]:
    async def _do_back(page: Any) -> Dict[str, Any]:
        try:
            await page.go_back(timeout=15000)
            return {"result": f"Went back. Now on {page.url}."}
        except Exception as e:  # noqa: BLE001
            raise ToolError(f"Back failed: {e}")

    return await _with_browser_recovery("Back", _do_back)


@register("desktopBrowserGoForward")
async def browser_go_forward(args: Dict[str, Any]) -> Dict[str, Any]:
    async def _do_forward(page: Any) -> Dict[str, Any]:
        try:
            await page.go_forward(timeout=15000)
            return {"result": f"Went forward. Now on {page.url}."}
        except Exception as e:  # noqa: BLE001
            raise ToolError(f"Forward failed: {e}")

    return await _with_browser_recovery("Forward", _do_forward)


@register("desktopBrowserScroll")
async def browser_scroll(args: Dict[str, Any]) -> Dict[str, Any]:
    direction = (args.get("direction") or "down").lower()
    amount = int(args.get("amount", 500))
    delta = amount if direction != "up" else -amount

    async def _do_scroll(page: Any) -> Dict[str, Any]:
        try:
            await page.mouse.wheel(0, delta)
            return {"result": f"Scrolled {direction} {amount}px."}
        except Exception as e:  # noqa: BLE001
            raise ToolError(f"Scroll failed: {e}")

    return await _with_browser_recovery("Scroll", _do_scroll)


def resolve_search_url(engine: str, query: str) -> str:
    """Return the navigable search URL for the target engine."""
    engine_key = (engine or "google").strip().lower()
    safe_query = str(query or "").strip()
    if not safe_query:
        raise ToolError("Search query is required.")
    q = quote_plus(safe_query)
    engine_map = {
        "google": f"https://www.google.com/search?q={q}",
        "youtube": f"https://www.youtube.com/results?search_query={q}",
        "github": f"https://github.com/search?q={q}&type=repositories",
        "duckduckgo": f"https://duckduckgo.com/?q={q}",
        "bing": f"https://www.bing.com/search?q={q}",
        "whatsapp": "https://web.whatsapp.com/",
    }
    if engine_key not in engine_map:
        raise ToolError(f"Unsupported search engine '{engine_key}'.")
    return engine_map[engine_key]


def extract_action_plan(task_text: str) -> Dict[str, Any]:
    """Parse a natural-language task into a browser action plan."""
    text = str(task_text or "").strip()
    if not text:
        raise ToolError("A browser task is required.")

    lower = text.lower()
    if "whatsapp" in lower:
        engine = "whatsapp"
    elif "youtube" in lower or "video" in lower or "song" in lower or "music" in lower:
        engine = "youtube"
    elif "github" in lower:
        engine = "github"
    else:
        engine = "google"

    intent = "open"
    if any(k in lower for k in ["scroll up", "scroll down", "scroll"]):
        intent = "scroll"
    elif any(k in lower for k in ["send", "type", "message", "chat", "whatsapp"]):
        intent = "message"
    elif "click" in lower and any(k in lower for k in ["play", "watch", "open video"]):
        intent = "click_play"
    elif "click" in lower:
        intent = "click"
    elif any(k in lower for k in ["play", "watch", "open video", "click video"]):
        intent = "play"
    elif any(k in lower for k in ["search for", "search ", "find ", "look for", "look up"]):
        intent = "search"

    query = None
    if "search" in lower or "find" in lower or "look for" in lower or "look up" in lower:
        match = re.search(
            r"(?:search(?:es|ing)?(?: for)?|find|look for|look up)\s+(?:the\s+)?(.+?)(?:\s+(?:and\s+then|then|after|so|for|to|click|open|watch|play|send|type)|$)",
            text,
            re.IGNORECASE,
        )
        if match:
            query = _clean_query(match.group(1))
    elif "song named" in lower or "video named" in lower or "user named" in lower or "contact named" in lower:
        match = re.search(r"(?:song|video|user|contact)\s+(?:named|called|for)\s+['\"]?([^'\".]+)", text, re.IGNORECASE)
        if match:
            query = _clean_query(match.group(1))
    elif "message" in lower:
        match = re.search(r"message\s+(?:saying|to|for)?\s*['\"]?(.+?)(?:\s*(?:and\s*send|and\s*click|$))", text, re.IGNORECASE)
        if match:
            query = _clean_query(match.group(1))

    direction = None
    if "scroll up" in lower:
        direction = "up"
    elif "scroll down" in lower:
        direction = "down"

    return {
        "engine": engine,
        "intent": intent,
        "query": query,
        "direction": direction,
        "raw": text,
    }


def find_best_result_match(results: List[Dict[str, Any]], query: str) -> Optional[Dict[str, Any]]:
    """Pick the most likely result from a search page using title similarity."""
    query_text = _normalize_text(query)
    if not query_text:
        return None
    query_tokens = {token for token in re.split(r"[^a-z0-9]+", query_text.lower()) if token}
    best = None
    best_score = -1

    for result in results:
        title = _normalize_text(result.get("title") or result.get("text") or result.get("label") or "")
        href = result.get("href") or result.get("url") or ""
        if not title:
            continue
        title_lower = title.lower()
        title_tokens = {token for token in re.split(r"[^a-z0-9]+", title_lower) if token}
        overlap = len(query_tokens & title_tokens)
        exact_bonus = 3 if query_text.lower() in title_lower else 0
        prefix_bonus = 2 if title_lower.startswith(query_text.lower()) else 0
        score = overlap * 2 + exact_bonus + prefix_bonus
        if href and ("youtube.com/watch" in href.lower() or "youtu.be" in href.lower()):
            score += 1
        if score > best_score:
            best_score = score
            best = {"title": title, "href": href}
    return best


def _normalize_text(raw: Any) -> str:
    if raw is None:
        return ""
    text = str(raw).strip()
    return re.sub(r"\s+", " ", text)


def _clean_query(raw: Optional[str]) -> Optional[str]:
    if raw is None:
        return None
    text = str(raw).strip().strip('"\'')
    text = re.sub(r"[\.,;!?]+$", "", text)
    return text.strip() or None


async def _collect_search_results(page: Any) -> List[Dict[str, Any]]:
    candidates: List[Dict[str, Any]] = []

    selectors = [
        "a[href*='/watch']",
        "a[href*='youtu.be']",
        "ytd-video-renderer a",
        "a#video-title",
        "h3 a",
    ]

    for selector in selectors:
        try:
            items = await page.locator(selector).all()
        except Exception:
            continue

        for item in items[:30]:
            try:
                title = await item.text_content()
                href = await item.get_attribute("href")
            except Exception:
                continue
            title_text = _normalize_text(title)
            if not title_text:
                continue
            href_text = href or ""
            if href_text.startswith("/"):
                href_text = f"https://www.youtube.com{href_text}"
            candidates.append({"title": title_text, "href": href_text})

    unique: List[Dict[str, Any]] = []
    seen = set()
    for item in candidates:
        key = (item.get("title") or "", item.get("href") or "")
        if key in seen:
            continue
        unique.append(item)
        seen.add(key)
    return unique[:20]


async def _handle_whatsapp_login_flow(page: Any) -> bool:
    """Handle WhatsApp approval/consent screens before real chat interaction."""
    for label in ["Continue", "Agree", "Next", "Log in", "OK"]:
        try:
            btn = page.get_by_role("button", name=re.compile(label, re.IGNORECASE))
            if await btn.count():
                await btn.first.click(timeout=5000)
                await page.wait_for_timeout(1000)
                return True
        except Exception:
            pass

        try:
            text_btn = page.locator(f"button:has-text(\"{label}\")")
            if await text_btn.count():
                await text_btn.first.click(timeout=5000)
                await page.wait_for_timeout(1000)
                return True
        except Exception:
            pass
    return False


@register("desktopBrowserTask")
async def browser_task(args: Dict[str, Any]) -> Dict[str, Any]:
    """Perform a multi-step browser task such as open/search/scroll/click/play."""
    task_text = str(args.get("task") or args.get("prompt") or "").strip()
    if not task_text:
        raise ToolError("Parameter 'task' is required.")

    plan = extract_action_plan(task_text)
    engine = plan["engine"]
    query = plan.get("query")

    async def _do_task(page: Any) -> Dict[str, Any]:
        if plan["intent"] == "scroll":
            direction = plan.get("direction") or (args.get("direction") or "down")
            amount = int(args.get("amount", args.get("pixels", 500)))
            return await browser_scroll({"direction": direction, "amount": amount})

        if engine == "whatsapp" and plan["intent"] in {"open", "message", "click", "click_play"}:
            await page.goto("https://web.whatsapp.com/", wait_until="domcontentloaded", timeout=20000)
            await _handle_whatsapp_login_flow(page)

            if query:
                search_box = page.locator("input[placeholder*='Search' i], input[aria-label*='Search' i], input[placeholder*='Search a contact' i]")
                if await search_box.count():
                    await search_box.first.fill(query)
                    await page.wait_for_timeout(700)
                    try:
                        candidates = page.locator("span[title], div[title]")
                        if await candidates.count():
                            await candidates.filter(has_text=query).first.click(timeout=5000)
                    except Exception:
                        pass

            if "send" in task_text.lower() or "message" in task_text.lower():
                message = args.get("message") or re.search(r"(?:message|send|type)\s+(?:that|this|a?\s*)?['\"]?(.+?)(?:\s*(?:on|to|in|and\s+send|$))", task_text, re.I)
                if isinstance(message, re.Match):
                    message = message.group(1).strip().strip('"\'')
                else:
                    message = str(args.get("message") or "").strip()
                if message:
                    boxes = page.locator('div[contenteditable="true"][data-tab="10"], div[contenteditable="true"][role="textbox"], div[contenteditable="true"]')
                    if await boxes.count():
                        await boxes.first.fill(message)
                        await page.keyboard.press("Enter")
                        return {"result": f"WhatsApp message sent to {query or 'selected contact'}: {message}", "url": page.url}
            return {"result": f"WhatsApp is open and ready for {query or 'your next action'}.", "url": page.url}

        if plan["intent"] in {"open", "search", "play", "click", "click_play"}:
            if engine == "youtube" and (not query or plan["intent"] == "open"):
                await page.goto("https://www.youtube.com", wait_until="domcontentloaded", timeout=20000)
                return {"result": "YouTube is open and ready.", "url": page.url}

            if query:
                search_url = resolve_search_url(engine, query)
                await page.goto(search_url, wait_until="domcontentloaded", timeout=20000)

                if engine == "youtube":
                    results = await _collect_search_results(page)
                    best_match = find_best_result_match(results, query)
                    if best_match:
                        if best_match.get("href"):
                            target_url = best_match["href"]
                            if target_url.startswith("/"):
                                target_url = f"https://www.youtube.com{target_url}"
                            await page.goto(target_url, wait_until="domcontentloaded", timeout=20000)
                            return {"result": f"Opened the best YouTube match for '{query}': {best_match.get('title')}", "url": page.url}
                        title = best_match.get("title") or query
                        try:
                            await _click_with_fallback(page, text=title)
                        except Exception:
                            pass
                        return {"result": f"Clicked the YouTube result matching '{query}'.", "url": page.url}
                    return {"result": f"Loaded YouTube results for '{query}'.", "url": page.url}

                if engine == "google":
                    return {"result": f"Searched Google for '{query}'.", "url": page.url}

                if engine in {"github", "duckduckgo", "bing"}:
                    return {"result": f"Searched {engine} for '{query}'.", "url": page.url}

        return {"result": f"Desktop browser task processed: {task_text}", "url": page.url}

    return await _with_browser_recovery("Browser task", _do_task)


# Wrap the async handlers so FastAPI's sync threadpool path can call them.
# Each @register'd async function above is replaced by a sync wrapper below.
def _sync_wrap(async_fn):
    def wrapper(args: Dict[str, Any]) -> Dict[str, Any]:
        return _run(async_fn(args))

    wrapper.__name__ = async_fn.__name__
    wrapper.__doc__ = async_fn.__doc__
    return wrapper


# Re-register the async handlers as synchronous wrappers so the registry
# dispatcher (which is sync) can call them uniformly.
from .registry import TOOLS  # noqa: E402

for _name in [
    "desktopBrowserOpen",
    "desktopBrowserNavigate",
    "desktopBrowserOpenTab",
    "desktopBrowserCloseTab",
    "desktopBrowserSearch",
    "desktopBrowserClick",
    "desktopBrowserType",
    "desktopBrowserFillForm",
    "desktopBrowserGoBack",
    "desktopBrowserGoForward",
    "desktopBrowserScroll",
    "desktopBrowserTask",
]:
    _orig = TOOLS[_name]
    if asyncio.iscoroutinefunction(_orig):
        TOOLS[_name] = _sync_wrap(_orig)


def shutdown_browser() -> None:
    """Cleanly stop the Playwright browser (called on app shutdown)."""
    if STATE.browser is None:
        return

    async def _stop():
        try:
            if STATE.browser:
                await STATE.browser.close()
        except Exception:
            pass
        try:
            if STATE.playwright:
                await STATE.playwright.stop()
        except Exception:
            pass
        STATE.reset_playwright()

    try:
        _run(_stop())
    except Exception:
        STATE.reset_playwright()


__all__ = [
    "browser_open",
    "browser_navigate",
    "browser_open_tab",
    "browser_close_tab",
    "browser_search",
    "browser_click",
    "browser_type",
    "browser_fill_form",
    "browser_go_back",
    "browser_go_forward",
    "browser_scroll",
    "browser_task",
    "shutdown_browser",
    "extract_action_plan",
    "find_best_result_match",
    "resolve_search_url",
]
