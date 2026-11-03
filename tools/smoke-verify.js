#!/usr/bin/env node

/**
 * Smoke test for the calibration visualization sequence.
 *
 * Launches the browser, clears verification cache, lets the calibration
 * animation run, and captures before/after screenshots.
 */

const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const ROOT = path.resolve(__dirname, "..");
const ARTIFACTS = path.join(ROOT, "tests", "artifacts");
const INDEX_URL = `file://${path.join(ROOT, "index.html")}`;

fs.mkdirSync(ARTIFACTS, { recursive: true });

async function run() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.setDefaultTimeout(0);

  page.addInitScript({
    content: `
      try {
        localStorage.removeItem(\"rockport.verification.v1\");
        localStorage.setItem(\"rockport.calibration.options\", JSON.stringify({ limit: 5 }));
      } catch (error) {
        // ignore
      }
      globalThis.ROCKPORT_CALIBRATION_OPTIONS = { limit: 5 };
    `
  });

  const consoleMessages = [];
  page.on("pageerror", (err) => console.log(`[browser:pageerror] ${err}`));
  page.on("console", (msg) => {
    consoleMessages.push(`[${msg.type().toUpperCase()}] ${msg.text()}`);
    console.log(`[browser:${msg.type()}] ${msg.text()}`);
  });

  await page.goto(INDEX_URL, { waitUntil: 'domcontentloaded' });
  await page.addInitScript({
    content: `
      try {
        localStorage.removeItem(\"rockport.verification.v1\");
        localStorage.setItem(\"rockport.calibration.options\", JSON.stringify({ limit: 5 }));
      } catch (error) {
        // ignore
      }
      window.ROCKPORT_CALIBRATION_OPTIONS = { limit: 5 };
    `
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.evaluate(() => {
    console.log('Calibration options set', window.ROCKPORT_CALIBRATION_OPTIONS);
  });
  await page.waitForSelector("#start-button", { timeout: 60000 });

  await page.waitForTimeout(1200);
  const duringPath = path.join(ARTIFACTS, "calibration-during.png");
  await page.screenshot({ path: duringPath });

  await page.waitForFunction(
    () => {
      const btn = document.querySelector("#start-button");
      return btn && !btn.disabled;
    },
    { timeout: 600000 }
  );
  const afterPath = path.join(ARTIFACTS, "calibration-after.png");
  await page.screenshot({ path: afterPath });

  await browser.close();

  console.log("Calibration smoke test complete.");
  console.log(`During-calibration screenshot: ${path.relative(ROOT, duringPath)}`);
  console.log(`Post-calibration screenshot:   ${path.relative(ROOT, afterPath)}`);

  if (consoleMessages.length) {
    console.log("\nConsole log excerpt:");
    consoleMessages.slice(0, 15).forEach((entry) => console.log(entry));
    if (consoleMessages.length > 15) {
      console.log(`... (${consoleMessages.length - 15} more lines)`);
    }
  }
}

run().catch((error) => {
  console.error("Smoke test failed:", error);
  process.exit(1);
});
