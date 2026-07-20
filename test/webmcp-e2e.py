"""Real-Chrome WebMCP/CDP smoke test.

Serve the repository root, set WEBMCP_BASE_URL if it is not
http://127.0.0.1:8765, and run with Python Playwright installed.
"""

from __future__ import annotations

import os
import time

from playwright.sync_api import sync_playwright


CHROME_PATH = os.environ.get(
    "WEBMCP_CHROME_PATH",
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
)
BASE_URL = os.environ.get("WEBMCP_BASE_URL", "http://127.0.0.1:8765")
FIXTURE_URL = f"{BASE_URL.rstrip('/')}/test/fixtures/webmcp-page.html"
FEATURE_FLAGS = "WebMCPTesting,DevToolsWebMCPSupport"


def wait_for_event(page, events: list[dict], predicate, label: str) -> dict:
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        for event in events:
            if predicate(event):
                return event
        page.wait_for_timeout(25)
    raise AssertionError(f"Timed out waiting for {label}; received: {events!r}")


def main() -> None:
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(
            headless=True,
            executable_path=CHROME_PATH,
            args=[f"--enable-features={FEATURE_FLAGS}"],
        )
        try:
            context = browser.new_context()
            page = context.new_page()
            page_errors: list[str] = []
            page.on("pageerror", lambda error: page_errors.append(str(error)))
            page.goto(FIXTURE_URL, wait_until="networkidle")
            page.wait_for_function("window.webMCPFixture?.ready === true")
            assert page.locator("#status").inner_text() == "ready"

            cdp = context.new_cdp_session(page)
            added: list[dict] = []
            removed: list[dict] = []
            responses: list[dict] = []
            cdp.on("WebMCP.toolsAdded", lambda event: added.extend(event.get("tools", [])))
            cdp.on("WebMCP.toolsRemoved", lambda event: removed.extend(event.get("tools", [])))
            cdp.on("WebMCP.toolResponded", lambda event: responses.append(event))
            cdp.send("WebMCP.enable")

            wait_for_event(
                page,
                added,
                lambda tool: tool.get("name") == "lookup_inventory",
                "lookup_inventory discovery",
            )
            inventory = next(tool for tool in added if tool.get("name") == "lookup_inventory")
            assert inventory["inputSchema"]["required"] == ["sku"]
            assert inventory["frameId"]
            assert any(tool.get("name") == "fail_predictably" for tool in added)

            invocation = cdp.send(
                "WebMCP.invokeTool",
                {
                    "frameId": inventory["frameId"],
                    "toolName": inventory["name"],
                    "input": {"sku": "SKU-42"},
                },
            )
            invocation_id = invocation["invocationId"]
            completed = wait_for_event(
                page,
                responses,
                lambda event: event.get("invocationId") == invocation_id,
                "successful tool response",
            )
            assert completed["status"] == "Completed", completed
            assert completed["output"]["structuredContent"] == {
                "sku": "SKU-42",
                "available": 7,
            }
            assert page.locator("#result").evaluate("element => element.value") == '{"sku":"SKU-42","available":7}'
            assert page.locator("#status").inner_text() == "invoked"

            failing = next(tool for tool in added if tool.get("name") == "fail_predictably")
            failed_invocation = cdp.send(
                "WebMCP.invokeTool",
                {
                    "frameId": failing["frameId"],
                    "toolName": failing["name"],
                    "input": {},
                },
            )
            failed = wait_for_event(
                page,
                responses,
                lambda event: event.get("invocationId") == failed_invocation["invocationId"],
                "failed tool response",
            )
            assert failed["status"] == "Error", failed
            failure_text = failed.get("errorText", "") or failed.get("exception", {}).get("description", "")
            assert "fixture failure" in failure_text, failed
            page.wait_for_timeout(25)
            assert any("fixture failure" in error for error in page_errors), page_errors

            page.evaluate("window.webMCPFixture.unregister()")
            wait_for_event(
                page,
                removed,
                lambda tool: tool.get("name") == "lookup_inventory",
                "tool removal",
            )
            assert any(tool.get("name") == "fail_predictably" for tool in removed)
            unexpected_page_errors = [error for error in page_errors if "fixture failure" not in error]
            assert not unexpected_page_errors, unexpected_page_errors
            cdp.send("WebMCP.disable")
            print(
                "PASS: real Chrome discovered, invoked, rejected, and removed "
                f"WebMCP tools via CDP ({len(added)} added, {len(removed)} removed)."
            )
        finally:
            browser.close()


if __name__ == "__main__":
    main()
