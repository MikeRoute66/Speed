#!/usr/bin/env node
const path = require("path");
const { chromium } = require("playwright");

async function main() {
  const root = path.resolve(__dirname, "..", "index.html");
  const fileUrl = `file://${root}`;

  const browser = await chromium.launch({ headless: false, args: ["--autoplay-policy=no-user-gesture-required"] });
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();
  console.log("Launching Rockport game...");
  await page.goto(fileUrl, { waitUntil: "domcontentloaded" });
  console.log("Game loaded at", fileUrl);
  console.log("Leave this window open while profiling. Press Ctrl+C here to exit.");

  const handleExit = async () => {
    console.log("\nShutting down browser...");
    try {
      await browser.close();
    } catch (error) {
      // ignore errors during shutdown
    }
    process.exit(0);
  };

  process.on("SIGINT", handleExit);
  process.on("SIGTERM", handleExit);
}

main().catch((error) => {
  console.error("Failed to launch game for profiling:", error);
  process.exit(1);
});
