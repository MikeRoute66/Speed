const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");
const { chromium } = require("playwright");

const ROOT = path.resolve(__dirname, "..", "..");
const ARTIFACTS = path.join(ROOT, "tests", "artifacts");
fs.mkdirSync(ARTIFACTS, { recursive: true });
const INDEX_URL = pathToFileURL(path.join(ROOT, "index.html")).href;

function parseBooleanEnv(value, defaultValue) {
  if (value === undefined) {
    return defaultValue;
  }
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return defaultValue;
}

const HEADLESS = parseBooleanEnv(process.env.HEADLESS, false);
const STEP_LOGGING = parseBooleanEnv(process.env.STEP_LOGGING, true);

function describeStep(step) {
  switch (step.type) {
    case "down":
      return `key down ${step.key}${step.ms ? ` (${step.ms} ms)` : ""}`;
    case "up":
      return `key up ${step.key}${step.ms ? ` (${step.ms} ms)` : ""}`;
    case "press":
      return `key press ${step.key}${step.ms ? ` (${step.ms} ms)` : ""}`;
    case "wait":
      return `wait ${step.ms} ms`;
    case "screenshot":
      return "capture screenshot";
    default:
      return `unknown step: ${JSON.stringify(step)}`;
  }
}

async function runScenario(name, steps) {
  console.log(`\n[Scenario] ${name} starting (${steps.length} steps)`);
  const browser = await chromium.launch({ headless: HEADLESS });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on("console", (msg) => {
    console.log(`[Browser:${msg.type().toUpperCase()}] ${msg.text()}`);
  });
  page.on("pageerror", (error) => {
    console.error(`[Browser:PAGEERROR] ${error}`);
  });

  await page.goto(INDEX_URL);
  await page.waitForSelector("#viewport");
  await page.waitForTimeout(500);

  const startedAt = Date.now();
  let screenshotPath = null;

  for (const step of steps) {
    if (STEP_LOGGING) {
      console.log(`  • ${describeStep(step)}`);
    }
    switch (step.type) {
      case "down":
        await page.keyboard.down(step.key);
        if (step.ms) await page.waitForTimeout(step.ms);
        break;
      case "up":
        await page.keyboard.up(step.key);
        if (step.ms) await page.waitForTimeout(step.ms);
        break;
      case "press":
        await page.keyboard.press(step.key);
        if (step.ms) await page.waitForTimeout(step.ms);
        break;
      case "wait":
        await page.waitForTimeout(step.ms);
        break;
      case "screenshot":
        screenshotPath = path.join(ARTIFACTS, `${name}.png`);
        await page.screenshot({ path: screenshotPath });
        console.log(`    ↳ Screenshot saved to ${screenshotPath}`);
        break;
      default:
        throw new Error(`Unknown step type: ${step.type}`);
    }
  }

  if (!steps.some(step => step.type === "screenshot")) {
    screenshotPath = path.join(ARTIFACTS, `${name}.png`);
    await page.screenshot({ path: screenshotPath });
    console.log(`    ↳ Screenshot saved to ${screenshotPath}`);
  }

  await browser.close();
  const durationMs = Date.now() - startedAt;
  console.log(`[Scenario] ${name} completed in ${(durationMs / 1000).toFixed(2)}s`);

  return {
    name,
    durationMs,
    screenshotPath
  };
}

async function main() {
  const results = [];

  results.push(await runScenario("accelerate", [
    { type: "down", key: "KeyW", ms: 1400 },
    { type: "up", key: "KeyW", ms: 300 },
    { type: "press", key: "Space", ms: 250 },
    { type: "screenshot" }
  ]));

  results.push(await runScenario("turn-and-brake", [
    { type: "down", key: "KeyW", ms: 1100 },
    { type: "down", key: "KeyD", ms: 900 },
    { type: "up", key: "KeyD" },
    { type: "up", key: "KeyW", ms: 250 },
    { type: "press", key: "Space", ms: 250 },
    { type: "screenshot" }
  ]));

  console.log("\n[Test Summary]");
  for (const result of results) {
    console.log(
      `- ${result.name}: ${(result.durationMs / 1000).toFixed(2)}s ` +
      (result.screenshotPath ? `(${path.relative(ROOT, result.screenshotPath)})` : "")
    );
  }
  console.log("All scenarios executed.\n");
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
