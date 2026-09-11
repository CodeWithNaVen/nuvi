import unittest
from unittest.mock import AsyncMock, patch

import desktop_agent.tools_browser as browser_tools
from desktop_agent.registry import STATE
from desktop_agent.tools_browser import (
    _candidate_click_selectors,
    _label_match_variants,
    _reset_stale_browser_state,
    extract_action_plan,
    find_best_result_match,
    resolve_search_url,
)


class BrowserTaskHelpersTests(unittest.TestCase):
    def test_resolve_youtube_search_url(self):
        self.assertEqual(
            resolve_search_url("youtube", "Believer Imagine Dragons"),
            "https://www.youtube.com/results?search_query=Believer+Imagine+Dragons",
        )

    def test_extract_action_plan_for_search_and_play(self):
        plan = extract_action_plan("Open YouTube, search for Believer by Imagine Dragons, click the video, and play it.")
        self.assertEqual(plan["engine"], "youtube")
        self.assertEqual(plan["query"], "Believer by Imagine Dragons")
        self.assertIn("click", plan["intent"].lower())
        self.assertIn("play", plan["intent"].lower())

    def test_result_match_prefers_exact_title_match(self):
        results = [
            {"title": "Imagine Dragons - Believer (Official Music Video)", "href": "https://www.youtube.com/watch?v=1"},
            {"title": "Believer - Imagine Dragons Lyrics", "href": "https://www.youtube.com/watch?v=2"},
        ]
        match = find_best_result_match(results, "Believer Imagine Dragons")
        self.assertEqual(match["href"], "https://www.youtube.com/watch?v=1")

    def test_whatsapp_login_flow_candidates(self):
        plan = extract_action_plan("Open WhatsApp and search for Nabin Shah")
        self.assertEqual(plan["engine"], "whatsapp")
        self.assertEqual(plan["query"], "Nabin Shah")

    def test_reset_stale_browser_state_when_page_is_closed(self):
        class ClosedPage:
            def is_closed(self):
                return True

            @property
            def url(self):
                return "about:blank"

        STATE.page = ClosedPage()
        STATE.context = object()
        STATE.browser = object()
        STATE.playwright = object()

        _reset_stale_browser_state()

        self.assertIsNone(STATE.page)
        self.assertIsNone(STATE.context)
        self.assertIsNone(STATE.browser)
        self.assertIsNone(STATE.playwright)

    def test_search_button_label_variants_cover_dom_labels(self):
        selectors = _candidate_click_selectors("#search-icon-legacy")
        self.assertIn("#search-icon-legacy", selectors)
        self.assertIn("search-icon-legacy", selectors)

        variants = _label_match_variants("Search button")
        self.assertIn("Search", variants)
        self.assertIn("Search button", variants)

    def test_browser_task_retries_after_closed_page(self):
        closed_page = AsyncMock()
        closed_page.goto.side_effect = RuntimeError("Target page, context or browser has been closed")
        closed_page.url = "about:blank"

        fresh_page = AsyncMock()
        fresh_page.goto.return_value = None
        fresh_page.url = "https://www.youtube.com"

        with patch.object(browser_tools, "_page", new=AsyncMock(side_effect=[closed_page, fresh_page])):
            result = browser_tools._run(browser_tools.browser_task({"task": "Open YouTube"}))

        self.assertEqual(result["url"], "https://www.youtube.com")


if __name__ == "__main__":
    unittest.main()
