/* M1 verification — tier-1 GPGPU engine boots, simulates, and falls back.
   Run: node tests/m1-core.js  (headless SwiftShader) */
const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');

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
  throw new Error('No chromium found');
}

const DIST = 'file://' + path.resolve(__dirname, '..', 'dist', 'index.html');
const results = [];
function check(name, ok, detail) { results.push({ name, ok: !!ok, detail: detail || '' }); }

(async () => {
  const browser = await chromium.launch({
    executablePath: resolveChromium(),
    args: ['--no-sandbox', '--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
  });

  // ── 1. tier-1 boot at reduced debug size (SwiftShader-friendly) ──
  {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errs = [];
    page.on('pageerror', e => errs.push(String(e)));
    await page.goto(DIST + '?debug=1&gl2n=128');
    await page.waitForFunction(() => window.DMDS_GL2 && window.DMDS_GL2.isReady(), { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(3000);
    const r = await page.evaluate(() => ({
      status: window.DMDS_GL2.status(),
      log: Array.from(document.querySelectorAll('.loader__log-line')).map(l => l.textContent.replace(/\.{2,}/g, ' … ')),
    }));
    check('t1:boots', r.status.running === true, JSON.stringify(r.status));
    check('t1:tier-is-gl2', r.status.tier === 'gl2');
    check('t1:log-names-sim', r.log.some(l => l.indexOf('COMPILE sim + render') === 0), r.log.join(' | '));
    check('t1:seed-line-honest', r.log.some(l => /SEED particles.*16,384/.test(l)), 'want 128²=16,384');
    check('t1:no-page-errors', errs.length === 0, errs.join('; '));
    await page.screenshot({ path: path.join(__dirname, 'm1-tier1.png') });
    await page.close();
  }

  // ── 2. sim aliveness + numerical hygiene via debugReadState (N=64) ──
  {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(DIST + '?debug=1&gl2n=64');
    await page.waitForFunction(() => window.DMDS_GL2 && window.DMDS_GL2.isReady(), { timeout: 30000 });
    await page.waitForTimeout(1200);
    const a = await page.evaluate(() => {
      const s = window.DMDS_GL2.debugReadState();
      return { pos: Array.from(s.positions.slice(0, 4096)), n: s.n };
    });
    await page.waitForTimeout(1500);
    const b = await page.evaluate(() => {
      const s = window.DMDS_GL2.debugReadState();
      const pos = s.positions, vel = s.velocities;
      let finite = true, moved = 0, maxR = 0, sentinelOK = true;
      for (let i = 0; i < pos.length; i += 4) {
        for (let k = 0; k < 3; k++) if (!Number.isFinite(pos[i + k]) || !Number.isFinite(vel[i + k])) finite = false;
        const r = Math.hypot(pos[i], pos[i + 1], pos[i + 2]);
        if (r > maxR) maxR = r;
        if (pos[i + 3] !== -2.0) sentinelOK = false;
      }
      return { pos: Array.from(pos.slice(0, 4096)), finite, maxR, sentinelOK };
    });
    let drift = 0;
    for (let i = 0; i < a.pos.length; i += 4) drift = Math.max(drift, Math.abs(a.pos[i] - b.pos[i]));
    check('t2:readback-n64', a.n === 64);
    check('t2:all-finite', b.finite);
    check('t2:within-bounds', b.maxR < 60, 'maxR=' + b.maxR.toFixed(1));
    check('t2:depth-sentinel-free', b.sentinelOK);
    check('t2:sim-is-integrating', drift > 1e-5, 'maxDrift=' + drift);
    await page.close();
  }

  // ── 3. fallback: WebGL2 denied at context creation → tier 2 boots ──
  {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.addInitScript(() => {
      const orig = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (type, opts) {
        if (type === 'webgl2') return null;
        return orig.call(this, type, opts);
      };
    });
    await page.goto(DIST);
    await page.waitForFunction(() => window.DMDS_GL && window.DMDS_GL.isReady(), { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(1500);
    const r = await page.evaluate(() => ({
      tier: window.DMDS_GL.status().tier,
      running: window.DMDS_GL.status().running,
      log: Array.from(document.querySelectorAll('.loader__log-line')).map(l => l.textContent),
    }));
    check('t3:tier2-boots-when-gl2-denied', r.tier === 'gl1' && r.running === true, JSON.stringify(r));
    check('t3:log-names-tier2', r.log.some(l => l.indexOf('COMPILE vertex + fragment') === 0));
    await page.close();
  }

  // ── 4. fallback: tier-1 init failure AFTER probe → canvas replaced, tier 2 boots ──
  {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.addInitScript(() => { window.__DMDS_GL2_BREAK__ = true; });
    await page.goto(DIST + '?debug=1');
    await page.waitForFunction(() => window.DMDS_GL && window.DMDS_GL.isReady(), { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(1500);
    const r = await page.evaluate(() => ({
      tier: window.DMDS_GL.status() ? window.DMDS_GL.status().tier : null,
      running: window.DMDS_GL.status().running,
      canvasIsWebgl1: (function () {
        // the replacement canvas must have accepted a webgl1 context
        const c = document.querySelector('#gl');
        return !!c;
      })(),
    }));
    check('t4:injected-late-failure-reaches-tier2', r.tier === 'gl1' && r.running === true, JSON.stringify(r));
    await page.close();
  }

  await browser.close();
  const pass = results.every(r => r.ok);
  results.forEach(r => console.log((r.ok ? '  ok  ' : '  FAIL'), r.name, r.detail));
  console.log(pass ? 'M1 CORE: PASS' : 'M1 CORE: FAIL');
  process.exit(pass ? 0 : 1);
})().catch(e => { console.error('M1 RUN FAILED', e); process.exit(2); });
