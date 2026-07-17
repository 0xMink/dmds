/* M0 gate runner — headless probe of the production GPGPU shape.
   Usage: node tests/m0-run.js [--out results/file.json]
   Chromium resolution: PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH env var, else
   playwright-core's registered chromium, else newest headless shell in
   the playwright cache. */
const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

function resolveChromium() {
  if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH) return process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  try {
    const p = chromium.executablePath();
    if (p && fs.existsSync(p)) return p;
  } catch (e) {}
  const cache = path.join(process.env.HOME || '/root', '.cache', 'ms-playwright');
  const dirs = fs.readdirSync(cache).filter(d => d.startsWith('chromium')).sort().reverse();
  for (const d of dirs) {
    for (const bin of ['chrome-headless-shell-linux64/chrome-headless-shell', 'chrome-linux/chrome']) {
      const p = path.join(cache, d, bin);
      if (fs.existsSync(p)) return p;
    }
  }
  throw new Error('No chromium found: set PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH');
}

(async () => {
  const outIdx = process.argv.indexOf('--out');
  const outFile = outIdx > -1 ? process.argv[outIdx + 1] : null;
  const executablePath = resolveChromium();
  const args = ['--no-sandbox', '--use-gl=swiftshader', '--enable-unsafe-swiftshader'];
  const browser = await chromium.launch({ executablePath, args });
  const page = await browser.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(String(e)));
  await page.goto('file://' + path.join(__dirname, 'm0-probe.html'));
  await page.waitForFunction(() => window.M0, { timeout: 15000 });
  const m0 = await page.evaluate(() => window.M0);

  let commit = 'unknown';
  try { commit = execSync('git rev-parse --short HEAD', { cwd: __dirname }).toString().trim(); } catch (e) {}
  const artifact = {
    gate: 'M0',
    date: new Date().toISOString(),
    pass: m0.pass,
    commit,
    runner: { node: process.version, browserVersion: browser.version(), executablePath, args },
    env: m0.env,
    tolerances: {
      simValues: { portableMax: 1e-4, note: 'absolute; SwiftShader observed 0 — bit-exactness is an observation, not the gate' },
      rgba16fRoundtrip: { portableMax: 2e-3, note: 'binary16 quantization bound near |x|<=1' },
    },
    cycles: 3,
    checks: m0.checks,
    pageErrors: errs,
  };
  console.log(JSON.stringify(artifact, null, 2));
  if (outFile) {
    const dest = path.isAbsolute(outFile) ? outFile : path.join(__dirname, outFile);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, JSON.stringify(artifact, null, 2) + '\n');
  }
  await browser.close();
  process.exit(m0.pass && errs.length === 0 ? 0 : 1);
})().catch(e => { console.error('M0 RUN FAILED', e); process.exit(2); });
