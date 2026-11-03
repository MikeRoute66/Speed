#!/usr/bin/env node

/**
 * Manual calibration runner for Rockport vehicles.
 *
 * Usage:
 *   node tools/calibrate.js           # runs using existing cache
 *   node tools/calibrate.js --force   # clears previous results first
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const STORAGE_FILE = path.join(ROOT, ".calibration-store.json");
const STORAGE_KEY = "rockport.verification.v1";

function loadStorageFile() {
  try {
    const raw = fs.readFileSync(STORAGE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      return parsed;
    }
  } catch (error) {
    // ignore – treat as empty storage
  }
  return {};
}

function saveStorageFile(data) {
  try {
    fs.writeFileSync(STORAGE_FILE, JSON.stringify(data, null, 2));
  } catch (error) {
    console.warn(`Unable to persist calibration cache: ${error}`);
  }
}

const storageData = loadStorageFile();

const localStoragePolyfill = {
  getItem(key) {
    if (key == null) return null;
    const normalized = String(key);
    return Object.prototype.hasOwnProperty.call(storageData, normalized)
      ? storageData[normalized]
      : null;
  },
  setItem(key, value) {
    const normalized = String(key);
    storageData[normalized] = String(value);
    saveStorageFile(storageData);
  },
  removeItem(key) {
    if (key == null) return;
    const normalized = String(key);
    if (Object.prototype.hasOwnProperty.call(storageData, normalized)) {
      delete storageData[normalized];
      saveStorageFile(storageData);
    }
  },
  clear() {
    const keys = Object.keys(storageData);
    if (keys.length === 0) return;
    for (const key of keys) {
      delete storageData[key];
    }
    saveStorageFile(storageData);
  },
  key(index) {
    const keys = Object.keys(storageData);
    return keys[index] ?? null;
  },
  get length() {
    return Object.keys(storageData).length;
  }
};

globalThis.localStorage = localStoragePolyfill;
globalThis.performance = globalThis.performance || {
  now: () => Number(process.hrtime.bigint()) / 1_000_000
};
globalThis.self = globalThis;

const args = process.argv.slice(2);
if (args.includes("--force")) {
  localStoragePolyfill.removeItem(STORAGE_KEY);
}
if (args.includes("--reset")) {
  localStoragePolyfill.clear();
}

require(path.join(ROOT, "carPhysics.js"));
require(path.join(ROOT, "carSpecs.js"));
require(path.join(ROOT, "main.js"));

const calibration = globalThis.RockportCalibration;
if (!calibration || !calibration.verifyAllCars) {
  console.error("Calibration harness is unavailable. Ensure main.js exposes RockportCalibration.");
  process.exit(1);
}

async function main() {
  const catalog = Array.isArray(globalThis.RockportCarCatalog)
    ? globalThis.RockportCarCatalog
    : [];

  if (catalog.length === 0) {
    console.warn("No cars found in RockportCarCatalog.");
    return;
  }

  const beforeUnverified = catalog.filter(
    (car) => !(car?.specs?.performanceVerified)
  );
  console.log(
    `Found ${catalog.length} cars (${beforeUnverified.length} pending verification).`
  );

  await calibration.verifyAllCars(catalog);

  const afterUnverified = catalog.filter(
    (car) => !(car?.specs?.performanceVerified)
  );

  const recordRaw = globalThis.localStorage.getItem(STORAGE_KEY);
  let recordCount = 0;
  if (recordRaw) {
    try {
      const parsed = JSON.parse(recordRaw);
      recordCount = Object.keys(parsed).length;
    } catch (error) {
      console.warn("Unable to parse persisted calibration data:", error);
    }
  }

  console.log("");
  console.log("Calibration summary");
  console.log("===================");
  console.log(`Verified records stored: ${recordCount}`);
  console.log(`Vehicles pending verification: ${afterUnverified.length}`);

  if (afterUnverified.length > 0) {
    console.log("");
    console.log("Unverified vehicles:");
    afterUnverified.slice(0, 10).forEach((car) => {
      const label = car?.specs?.performanceVerified
        ? "(verified)"
        : "";
      const name = car ? `${car.year ?? "-"} ${car.make ?? ""} ${car.model ?? ""}`.trim() : "Unknown";
      console.log(` - ${name} ${label}`);
    });
    if (afterUnverified.length > 10) {
      console.log(` ...and ${afterUnverified.length - 10} more`);
    }
  } else {
    console.log("All catalog vehicles verified.");
  }
}

main().catch((error) => {
  console.error("Calibration failed:", error);
  process.exit(1);
});
