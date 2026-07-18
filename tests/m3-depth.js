/* M3 verification — camera parallax, reduced-motion camera, dust rules.
   Run: node tests/m3-depth.js  (headless SwiftShader) */
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

async function readyPage(browser, query, opts) {
  const page = await browser.newPage(Object.assign({ viewport: { width: 1440, height: 900 } }, opts || {}));
  page.errs = [];
  page.on('pageerror', e => page.errs.push(String(e)));
  await page.goto(DIST + query);
  await page.waitForFunction(() => window.DMDS_GL2 && window.DMDS_GL2.isReady(), { timeout: 120000 });
  await page.waitForFunction(() => {
    try { window.DMDS_GL2.debugProject([[0, 0, 0]]); return true; } catch (e) { return false; }
  }, { timeout: 60000 });
  return page;
}

(async () => {
  const browser = await chromium.launch({
    executablePath: resolveChromium(),
    args: ['--no-sandbox', '--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
  });

  // ── 1. pointer parallax: the camera leans, world points shift in NDC ──
  {
    const page = await readyPage(browser, '?debug=1&gl2n=64');
    const r = await page.evaluate(async () => {
      const origin = () => window.DMDS_GL2.debugProject([[0, 0, 0]])[0];
      const mm = (x, y) => window.dispatchEvent(new MouseEvent('mousemove', { clientX: x, clientY: y }));
      mm(50, 450);   // far left
      await new Promise(r2 => setTimeout(r2, 1200)); // lerp settles
      const left = origin();
      mm(1390, 450); // far right
      await new Promise(r2 => setTimeout(r2, 1200));
      const right = origin();
      return { dx: right[0] - left[0], left: left[0], right: right[0] };
    });
    // pointer right → camera trucks right → world origin shifts LEFT in NDC
    // (plus the pre-existing rotation sway, same sign) — magnitude matters
    check('par:pointer-shifts-camera', Math.abs(r.dx) > 0.02, 'dNDCx=' + r.dx.toFixed(4));
    check('par:no-errors', page.errs.length === 0, page.errs.join('; '));
    await page.close();
  }

  // ── 2. scroll parallax via the engine API ──
  {
    const page = await readyPage(browser, '?debug=1&gl2n=64');
    const r = await page.evaluate(async () => {
      // real page scroll — the raf feeds GL.setScroll every frame, so the
      // end-to-end path is scroll position → engine → camera
      const origin = () => window.DMDS_GL2.debugProject([[0, 0, 0]])[0];
      window.scrollTo(0, 0);
      await new Promise(r2 => setTimeout(r2, 1200));
      const top = origin();
      window.scrollTo(0, document.documentElement.scrollHeight);
      await new Promise(r2 => setTimeout(r2, 1500));
      const bottom = origin();
      return { dy: bottom[1] - top[1] };
    });
    check('par:scroll-shifts-camera', Math.abs(r.dy) > 0.02, 'dNDCy=' + r.dy.toFixed(4));
    await page.close();
  }

  // ── 3. reduced motion: camera is FIXED — no parallax, no sway ──
  {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
    await page.goto(DIST + '?debug=1&gl2n=64');
    await page.waitForFunction(() => window.DMDS_GL2 && window.DMDS_GL2.isReady(), { timeout: 120000 });
    await page.waitForFunction(() => {
      try { window.DMDS_GL2.debugProject([[0, 0, 0]]); return true; } catch (e) { return false; }
    }, { timeout: 60000 });
    const r = await page.evaluate(async () => {
      const origin = () => window.DMDS_GL2.debugProject([[0, 0, 0]])[0];
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: 50, clientY: 450 }));
      window.DMDS_GL2.setScroll(1);
      const a = origin();
      await new Promise(r2 => setTimeout(r2, 1500));
      const b = origin();
      return { drift: Math.hypot(b[0] - a[0], b[1] - a[1]) };
    });
    check('par:reduced-motion-camera-fixed', r.drift < 1e-6, 'drift=' + r.drift);
    await page.close();
  }

  // ── 4. dust: type-mode text above the cap becomes flagged, behind-plane
  //       dust; below the cap there is none ──
  {
    const page = await readyPage(browser, '?debug=1'); // 512² = 262,144 > cap
    await page.waitForFunction(() => window.DMDS_GL2.status().mix === 1, { timeout: 120000 });
    const r = await page.evaluate(async () => {
      window.DMDS_GL2.setFormation('text:HI', 0.4);
      await new Promise(r2 => setTimeout(r2, 300)); // targets upload synchronously with the call
      // glyph region: low indices (texel rows near 0)
      const glyph = window.DMDS_GL2.debugReadTargets(16, 0, 0).b;
      // dust region: rows ≥ 400 → indices ≥ 204,800 > 120,000 cap
      const dust = window.DMDS_GL2.debugReadTargets(16, 0, 400).b;
      let glyphDustFlags = 0, dustFlags = 0, dustBehind = 0, n = 16 * 16;
      for (let i = 0; i < n; i++) {
        if (glyph[i * 4 + 3] === 1) glyphDustFlags++;
        if (dust[i * 4 + 3] === 1) dustFlags++;
        if (dust[i * 4 + 2] <= -3) dustBehind++;
      }
      return { glyphDustFlags, dustFlags, dustBehind, n };
    });
    check('dust:glyph-region-unflagged', r.glyphDustFlags === 0, r.glyphDustFlags + '/' + r.n);
    check('dust:overflow-region-flagged', r.dustFlags === r.n, r.dustFlags + '/' + r.n);
    check('dust:sits-behind-text-plane', r.dustBehind === r.n, r.dustBehind + '/' + r.n);
    check('dust:no-errors', page.errs.length === 0, page.errs.join('; '));
    await page.close();
  }
  {
    const page = await readyPage(browser, '?debug=1&gl2n=64'); // 4,096 < cap
    await page.waitForFunction(() => window.DMDS_GL2.status().mix === 1, { timeout: 60000 });
    const r = await page.evaluate(async () => {
      window.DMDS_GL2.setFormation('text:HI', 0.4);
      await new Promise(r2 => setTimeout(r2, 200));
      const t = window.DMDS_GL2.debugReadTargets(64).b;
      let flags = 0;
      for (let i = 3; i < t.length; i += 4) if (t[i] === 1) flags++;
      return { flags };
    });
    check('dust:none-below-cap', r.flags === 0, 'flags=' + r.flags);
    await page.close();
  }

  await browser.close();
  const pass = results.every(r => r.ok);
  results.forEach(r => console.log((r.ok ? '  ok  ' : '  FAIL'), r.name, r.detail));
  console.log(pass ? 'M3 DEPTH: PASS (' + results.length + ' checks)' : 'M3 DEPTH: FAIL');
  process.exit(pass ? 0 : 1);
})().catch(e => { console.error('M3 RUN FAILED', e); process.exit(2); });
