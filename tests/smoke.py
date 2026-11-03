#!/usr/bin/env python3
"""Simple visual smoke test using Playwright for the new driving sandbox."""

from __future__ import annotations

import asyncio
from pathlib import Path

from playwright.async_api import async_playwright

ROOT = Path(__file__).resolve().parents[1]
ARTIFACTS = ROOT / "tests" / "artifacts"
ARTIFACTS.mkdir(parents=True, exist_ok=True)


async def run_smoke() -> None:
    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch()
        page = await browser.new_page(viewport={"width": 1280, "height": 720})
        await page.goto((ROOT / "index.html").as_uri())
        await page.wait_for_selector("#viewport")
        await page.wait_for_timeout(2000)
        await page.screenshot(path=str(ARTIFACTS / "game-screen.png"))
        await browser.close()


if __name__ == "__main__":
    asyncio.run(run_smoke())
