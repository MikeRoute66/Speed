#!/usr/bin/env python3
"""Automated drive test to verify movement and HUD updates."""

from __future__ import annotations

import asyncio
from pathlib import Path

from playwright.async_api import async_playwright

ROOT = Path(__file__).resolve().parents[1]
ARTIFACTS = ROOT / "tests" / "artifacts"
ARTIFACTS.mkdir(parents=True, exist_ok=True)


async def run_drive() -> None:
    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch()
        page = await browser.new_page(viewport={"width": 1280, "height": 720})
        await page.goto((ROOT / "index.html").as_uri())
        await page.wait_for_selector("#viewport")
        await page.wait_for_timeout(1200)

        await page.click("#viewport")
        initial_position = await page.inner_text("#stat-position")
        await page.keyboard.down("KeyW")
        await page.wait_for_timeout(1500)
        speed_during = await page.inner_text("#stat-speed")
        position_during = await page.inner_text("#stat-position")
        await page.keyboard.down("KeyD")
        await page.wait_for_timeout(900)
        await page.keyboard.up("KeyD")
        await page.keyboard.up("KeyW")
        await page.wait_for_timeout(400)
        await page.keyboard.press("Space")
        await page.wait_for_timeout(400)

        if not speed_during:
            raise AssertionError("Speed readout missing")
        try:
            speed_value = float(speed_during.strip())
        except ValueError as exc:  # pragma: no cover - diagnostic aid
            raise AssertionError(f"Speed readout not numeric: {speed_during!r}") from exc
        try:
            during_x, during_y = (float(part) for part in position_during.split(","))
            initial_x, initial_y = (float(part) for part in initial_position.split(","))
        except ValueError as exc:  # pragma: no cover - diagnostic aid
            raise AssertionError(f"Position readout malformed: {position_during!r}") from exc
        if speed_value <= 0 and (abs(during_x - initial_x) < 1 and abs(during_y - initial_y) < 1):
            raise AssertionError("Vehicle failed to move during the test")

        await page.screenshot(path=str(ARTIFACTS / "drive-test.png"))
        await browser.close()


if __name__ == "__main__":
    asyncio.run(run_drive())
