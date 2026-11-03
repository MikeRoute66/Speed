#!/usr/bin/env node
/*
Headless calibrator: launches a local static server and uses Puppeteer to open
calibrate_all.html, waits for the carVerificationManager to produce records for
requested car IDs, then prints JSON with the measured results for those cars.

Usage: node tools/headless_calibrate.js

This script expects Python 3 to be available for a quick http.server. It also
requires puppeteer to be installed (npm install puppeteer).
*/

const { spawn } = require('child_process');
const path = require('path');

(async () => {
  const puppeteer = require('puppeteer');
  const root = path.resolve(__dirname, '..');
  const server = spawn('python3', ['-m', 'http.server', '8000'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });

  server.stdout.on('data', (d) => {
    process.stderr.write(`[http-server] ${d}`);
  });
  server.stderr.on('data', (d) => {
    process.stderr.write(`[http-server-err] ${d}`);
  });

  const browser = await puppeteer.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  const page = await browser.newPage();

  page.on('console', (msg) => {
    const text = msg.text();
    console.log('[PAGE]', text);
  });

  // Set up a counting handler before navigation so we don't miss initial logs
  let totalToProcess = null;
  let verifiedCount = 0;
  const countingHandler = (msg) => {
    const text = msg.text();
    const mTotal = text.match(/Calibrating\s+(\d+)\s+unverified\s+cars/);
    if (mTotal) {
      totalToProcess = Number(mTotal[1]);
    }
    const mVer = text.match(/\] (.+) verified \(Δ0-100: ([^s]+)s, ΔVmax: ([^\)]+)\)/);
    if (mVer) {
      verifiedCount += 1;
    }
  };
  page.on('console', countingHandler);

  const url = 'http://localhost:8000/calibrate_all.html';
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 120000 });

  const targetIds = ['1973-lamborghini-urraco-p250', '1985-lamborghini-jalpa-p350'];
  const overallTimeoutMs = 8 * 60 * 1000; // 8 minutes overall

  // Listen for console messages to detect when verification finishes (counts 'verified' messages)
  const records = await (async () => {
    return await new Promise((resolve) => {
      // Use the values populated by countingHandler
      const parsed = { resolved: false };
      const checkInterval = setInterval(async () => {
        if (totalToProcess !== null && verifiedCount >= totalToProcess && !parsed.resolved) {
          parsed.resolved = true;
          clearInterval(checkInterval);
          // Allow a short delay for watcher to copy records to window.__CALIB_RESULTS
          setTimeout(async () => {
            try {
              const out = await page.evaluate((targetIds) => {
                const res = {};
                for (const id of targetIds) {
                  res[id] = (window.__CALIB_RESULTS && window.__CALIB_RESULTS[id]) || null;
                }
                return res;
              }, targetIds);
              resolve(out);
            } catch (e) {
              resolve({ error: String(e) });
            }
          }, 1200);
        }
      }, 400);
      // Fallback: overall timeout
      setTimeout(() => {
        if (!parsed.resolved) {
          parsed.resolved = true;
          resolve({ timeout: true });
        }
      }, overallTimeoutMs);
    });
  })();

  console.log('---RESULTS---');
  console.log(JSON.stringify(records, null, 2));

  await browser.close();
  server.kill('SIGTERM');
  process.exit(0);
})();
