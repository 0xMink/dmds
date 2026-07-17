/* Reproducible capture of the tear evidence screenshot (m2-tear.png).
   Run: node tests/m2-tear-shot.js */
const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');
function resolveChromium() {
  if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH) return process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  try { const p = chromium.executablePath(); if (p && fs.existsSync(p)) return p; } catch (e) {}
  const cache = path.join(process.env.HOME || '/root', '.cache', 'ms-playwright');
  const dirs = fs.readdirSync(cache).filter(d => d.startsWith('chromium')).sort().reverse();
  for (const d of dirs) for (const bin of ['chrome-headless-shell-linux64/chrome-headless-shell', 'chrome-linux/chrome']) {
    const p = path.join(cache, d, bin);
    if (fs.existsSync(p)) return p;
  }
  throw new Error('No chromium found');
}
(async () => {
  const browser = await chromium.launch({
    executablePath: resolveChromium(),
    args: ['--no-sandbox', '--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto('file://' + path.resolve(__dirname, '..', 'dist', 'index.html') + '?debug=1&gl2n=128');
  await page.waitForFunction(() => window.DMDS_GL2 && window.DMDS_GL2.isReady(), { timeout: 60000 });
  await page.waitForFunction(() => window.DMDS_GL2.status().mix === 1, { timeout: 60000 });
  await page.waitForTimeout(20000); // settle to crisp-lock
  await page.evaluate(async () => {
    const E = window.DMDS_GL2;
    E.pause();
    window.dispatchEvent(new PointerEvent('pointerdown', { clientX: 300, clientY: 370, button: 0, pointerType: 'mouse' }));
    E.debugStep(1);
    for (let k = 1; k <= 8; k++) {
      window.dispatchEvent(new PointerEvent('pointermove', { clientX: 300 - k * 22, clientY: 370 + k * 38, pointerType: 'mouse' }));
      await new Promise(r => setTimeout(r, 25));
      E.debugStep(10);
    }
  });
  await page.evaluate(() => window.DMDS_GL2.resume()); // render the held state
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(__dirname, 'm2-tear.png') });
  await browser.close();
  console.log('tear captured');
})().catch(e => { console.error(e); process.exit(1); });
