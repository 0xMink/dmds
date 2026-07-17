/* M1 verification — tier-1 GPGPU engine: boot, production shape, morph,
   numerical recovery, lifecycle, and the full fallback matrix.
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
const OOB_BOUND = 60; // must equal src/gl2.js OOB (spec rev 3.1 world scale)
const results = [];
function check(name, ok, detail) { results.push({ name, ok: !!ok, detail: detail || '' }); }

(async () => {
  const browser = await chromium.launch({
    executablePath: resolveChromium(),
    args: ['--no-sandbox', '--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
  });
  async function newPage(initScript) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.errs = [];
    page.on('pageerror', e => page.errs.push(String(e)));
    if (initScript) await page.addInitScript(initScript);
    return page;
  }

  // ── 1. production shape: 512² allocates, executes, stays healthy ──
  {
    const page = await newPage();
    await page.goto(DIST + '?debug=1'); // default desktop N = 512
    await page.waitForFunction(() => window.DMDS_GL2 && window.DMDS_GL2.isReady(), { timeout: 60000 });
    await page.waitForTimeout(2500); // ≥3 frames even at SwiftShader pace
    const r = await page.evaluate(() => ({
      status: window.DMDS_GL2.status(),
      health: window.DMDS_GL2.debugGLHealth(),
      log: Array.from(document.querySelectorAll('.loader__log-line')).map(l => l.textContent),
    }));
    check('prod:count-262144', r.status.count === 262144, JSON.stringify(r.status));
    check('prod:seed-line', r.log.some(l => /SEED particles.*262,144/.test(l)));
    check('prod:running', r.status.running === true && r.status.tier === 'gl2');
    check('prod:no-gl-error', r.health.error === 0, 'glError=' + r.health.error);
    check('prod:fbos-complete', r.health.fbo.every(s => s === 0x8CD5), JSON.stringify(r.health.fbo));
    check('prod:no-page-errors', page.errs.length === 0, page.errs.join('; '));
    await page.close();
  }

  // ── 2. numerical hygiene + injected recovery + morph (N = 64, readable) ──
  {
    const page = await newPage();
    await page.goto(DIST + '?debug=1&gl2n=64');
    await page.waitForFunction(() => window.DMDS_GL2 && window.DMDS_GL2.isReady(), { timeout: 60000 });
    await page.waitForTimeout(1500);

    const hygiene = await page.evaluate(() => {
      const s = window.DMDS_GL2.debugReadState();
      let finite = true, maxR = 0, sentinelOK = true;
      for (let i = 0; i < s.positions.length; i += 4) {
        for (let k = 0; k < 3; k++) if (!Number.isFinite(s.positions[i + k]) || !Number.isFinite(s.velocities[i + k])) finite = false;
        maxR = Math.max(maxR, Math.hypot(s.positions[i], s.positions[i + 1], s.positions[i + 2]));
        if (s.positions[i + 3] !== -2.0) sentinelOK = false;
      }
      return { finite, maxR, sentinelOK };
    });
    check('num:all-finite', hygiene.finite);
    // the reset bound itself, not a looser stand-in; legit motion also
    // stays far inside it (formations span ≲20)
    check('num:inside-reset-bound', hygiene.maxR <= OOB_BOUND, 'maxR=' + hygiene.maxR.toFixed(1));
    check('num:legit-motion-far-inside', hygiene.maxR < 25, 'maxR=' + hygiene.maxR.toFixed(1));
    check('num:sentinel-free', hygiene.sentinelOK);

    // injected OOB: poked to r=200; V_max·dt caps legit travel at ~3 wu/frame,
    // so returning inside the formation envelope within ~1s proves the
    // reset branch fired (10 frames of max legit travel ≈ 30 wu, not 180)
    const oob = await page.evaluate(async () => {
      window.DMDS_GL2.debugPoke(0, 200, 0, 0);
      await new Promise(r => setTimeout(r, 1000));
      const s = window.DMDS_GL2.debugReadState();
      return { r: Math.hypot(s.positions[0], s.positions[1], s.positions[2]), finite: Number.isFinite(s.positions[0]) };
    });
    check('num:oob-recovers-via-reset', oob.finite && oob.r < 25, 'r=' + oob.r.toFixed(1));

    // injected NaN: same contract
    const nan = await page.evaluate(async () => {
      window.DMDS_GL2.debugPoke(1, NaN, NaN, NaN);
      await new Promise(r => setTimeout(r, 1000));
      const s = window.DMDS_GL2.debugReadState();
      return { finite: [4, 5, 6].every(i => Number.isFinite(s.positions[i])), r: Math.hypot(s.positions[4], s.positions[5], s.positions[6]) };
    });
    check('num:nan-recovers-via-reset', nan.finite && nan.r < 25, 'r=' + nan.r.toFixed(1));

    // morph: setFormation must actually move the population
    const morph = await page.evaluate(async () => {
      const before = Array.from(window.DMDS_GL2.debugReadState().positions);
      window.DMDS_GL2.setFormation('grid', 0.6);
      // the page's scroll choreography re-asserts the hero formation on
      // later frames (by design) — the engine-level name change is sync
      const nameRightAfter = window.DMDS_GL2.status().formation;
      await new Promise(r => setTimeout(r, 2500));
      const after = window.DMDS_GL2.debugReadState().positions;
      let moved = 0, maxR = 0, finite = true;
      for (let i = 0; i < after.length; i += 4) {
        const d = Math.hypot(after[i] - before[i], after[i + 1] - before[i + 1], after[i + 2] - before[i + 2]);
        if (d > 0.5) moved++;
        maxR = Math.max(maxR, Math.hypot(after[i], after[i + 1], after[i + 2]));
        for (let k = 0; k < 3; k++) if (!Number.isFinite(after[i + k])) finite = false;
      }
      return { moved, total: after.length / 4, maxR, finite, nameRightAfter };
    });
    check('morph:population-moved', morph.moved > morph.total * 0.5, morph.moved + '/' + morph.total);
    check('morph:formation-name', morph.nameRightAfter === 'grid', morph.nameRightAfter);
    check('morph:stays-finite-in-bounds', morph.finite && morph.maxR <= OOB_BOUND, 'maxR=' + morph.maxR.toFixed(1));
    check('num:no-page-errors', page.errs.length === 0, page.errs.join('; '));
    await page.close();
  }

  // ── 3. fallback matrix ──
  // 3a. WebGL2 context unavailable → tier 2
  {
    const page = await newPage(() => {
      const orig = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (t, o) { return t === 'webgl2' ? null : orig.call(this, t, o); };
    });
    await page.goto(DIST);
    await page.waitForFunction(() => window.DMDS_GL && window.DMDS_GL.isReady(), { timeout: 60000 });
    const r = await page.evaluate(() => window.DMDS_GL.status());
    check('fb:no-webgl2 → gl1', r.tier === 'gl1' && r.running === true, JSON.stringify(r));
    await page.close();
  }
  // 3b. EXT_color_buffer_float unavailable → probe fails → tier 2
  {
    const page = await newPage(() => {
      const orig = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (t, o) {
        const ctx = orig.call(this, t, o);
        if (t === 'webgl2' && ctx) {
          const ge = ctx.getExtension.bind(ctx);
          ctx.getExtension = n => (n === 'EXT_color_buffer_float' ? null : ge(n));
        }
        return ctx;
      };
    });
    await page.goto(DIST);
    await page.waitForFunction(() => window.DMDS_GL && window.DMDS_GL.isReady(), { timeout: 60000 });
    const r = await page.evaluate(() => window.DMDS_GL.status());
    check('fb:no-float-ext → gl1', r.tier === 'gl1' && r.running === true, JSON.stringify(r));
    await page.close();
  }
  // 3c. production FBO incomplete → probe fails → tier 2
  {
    const page = await newPage(() => {
      const orig = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (t, o) {
        const ctx = orig.call(this, t, o);
        if (t === 'webgl2' && ctx) { ctx.checkFramebufferStatus = () => 0x8CD6; }
        return ctx;
      };
    });
    await page.goto(DIST);
    await page.waitForFunction(() => window.DMDS_GL && window.DMDS_GL.isReady(), { timeout: 60000 });
    const r = await page.evaluate(() => window.DMDS_GL.status());
    check('fb:fbo-incomplete → gl1', r.tier === 'gl1' && r.running === true, JSON.stringify(r));
    await page.close();
  }
  // 3d. failure AFTER the visible canvas holds WebGL2 → canvas REPLACED → tier 2
  {
    const page = await newPage(() => {
      window.__DMDS_GL2_BREAK__ = true;
      const orig = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (t, o) {
        const ctx = orig.call(this, t, o);
        if (this.id === 'gl') {
          this.__ctxTypes = (this.__ctxTypes || []).concat(ctx ? t : t + ':null');
          // capture the ORIGINAL at the moment it first hands out webgl2 —
          // DOMContentLoaded can lose the race against the replacement microtask
          if (t === 'webgl2' && ctx && !window.__ORIG_CANVAS__) window.__ORIG_CANVAS__ = this;
        }
        return ctx;
      };
    });
    await page.goto(DIST + '?debug=1');
    await page.waitForFunction(() => window.DMDS_GL && window.DMDS_GL.isReady(), { timeout: 60000 });
    const r = await page.evaluate(() => {
      const now = document.querySelector('#gl');
      return {
        tier: window.DMDS_GL.status().tier,
        running: window.DMDS_GL.status().running,
        identityChanged: window.__ORIG_CANVAS__ !== now,
        origHadWebgl2: (window.__ORIG_CANVAS__.__ctxTypes || []).indexOf('webgl2') > -1,
        newHasWebgl1: (now.__ctxTypes || []).indexOf('webgl') > -1,
      };
    });
    check('fb:late-failure → canvas replaced', r.identityChanged === true, JSON.stringify(r));
    check('fb:old-canvas-held-webgl2', r.origHadWebgl2 === true);
    check('fb:new-canvas-runs-gl1', r.tier === 'gl1' && r.running && r.newHasWebgl1, JSON.stringify(r));
    await page.close();
  }
  // 3e. runtime context loss → pause; restore within timeout → resume
  {
    const page = await newPage();
    await page.goto(DIST + '?debug=1&gl2n=64');
    await page.waitForFunction(() => window.DMDS_GL2 && window.DMDS_GL2.isReady(), { timeout: 60000 });
    const r = await page.evaluate(async () => {
      const ctx = document.querySelector('#gl').getContext('webgl2');
      const lose = ctx.getExtension('WEBGL_lose_context');
      lose.loseContext();
      await new Promise(r2 => setTimeout(r2, 500));
      const paused = window.DMDS_GL2.status().running === false;
      lose.restoreContext();
      await new Promise(r2 => setTimeout(r2, 1500));
      return { paused, resumed: window.DMDS_GL2.status().running === true, tier: window.DMDS_GL2.status().tier };
    });
    check('fb:loss-pauses', r.paused === true, JSON.stringify(r));
    check('fb:restore-resumes-gl2', r.resumed === true && r.tier === 'gl2', JSON.stringify(r));
    await page.close();
  }
  // 3f. context loss with NO restore within 4s → demote to tier 2 on fresh canvas
  {
    const page = await newPage(() => {
      const orig = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (t, o) {
        const ctx = orig.call(this, t, o);
        if (this.id === 'gl' && t === 'webgl2' && ctx && !window.__ORIG_CANVAS__) window.__ORIG_CANVAS__ = this;
        return ctx;
      };
    });
    await page.goto(DIST + '?debug=1&gl2n=64');
    await page.waitForFunction(() => window.DMDS_GL2 && window.DMDS_GL2.isReady(), { timeout: 60000 });
    await page.evaluate(() => {
      document.querySelector('#gl').getContext('webgl2').getExtension('WEBGL_lose_context').loseContext();
    });
    await page.waitForFunction(() => window.DMDS_GL && window.DMDS_GL.isReady && window.DMDS_GL.isReady(), { timeout: 20000 });
    const r = await page.evaluate(() => ({
      tier: window.DMDS_GL.status().tier,
      running: window.DMDS_GL.status().running,
      identityChanged: window.__ORIG_CANVAS__ !== document.querySelector('#gl'),
    }));
    check('fb:restore-timeout → demoted-gl1-fresh-canvas', r.tier === 'gl1' && r.running && r.identityChanged, JSON.stringify(r));
    await page.close();
  }
  // 3g. tier 2 also unavailable → CSS fallback, honest log
  {
    const page = await newPage(() => {
      const orig = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (t, o) {
        return (t === 'webgl2' || t === 'webgl') ? null : orig.call(this, t, o);
      };
    });
    await page.goto(DIST);
    await page.waitForTimeout(4000);
    const r = await page.evaluate(() => ({
      log: Array.from(document.querySelectorAll('.loader__log-line, body')).map(l => l.textContent).join(' '),
      glDimmed: document.querySelector('#gl').style.opacity === '0.5',
      loaded: document.documentElement.classList.contains('loaded'),
    }));
    check('fb:no-gl-at-all → css-tier', r.glDimmed && r.loaded, 'dimmed=' + r.glDimmed + ' loaded=' + r.loaded);
    check('fb:css-tier-honest-log', /FALLBACK static field/.test(r.log));
    await page.close();
  }

  // ── 4. engine destroy/reinit: teardown leaves a working page ──
  {
    const page = await newPage();
    await page.goto(DIST + '?debug=1&gl2n=64');
    await page.waitForFunction(() => window.DMDS_GL2 && window.DMDS_GL2.isReady(), { timeout: 60000 });
    const r = await page.evaluate(async () => {
      window.DMDS_GL2.destroy();
      const stopped = window.DMDS_GL2.status().running === false && window.DMDS_GL2.isReady() === false;
      let readbackThrows = false;
      try { window.DMDS_GL2.debugReadState(); } catch (e) { readbackThrows = true; }
      return { stopped, readbackThrows };
    });
    check('life:destroy-stops-engine', r.stopped, JSON.stringify(r));
    check('life:destroy-releases-state', r.readbackThrows);
    check('life:no-errors-after-destroy', page.errs.length === 0, page.errs.join('; '));
    await page.close();
  }

  // ── 5. settle capture (reproducible visual evidence; sharpness is a
  //       VISUAL observation — physical convergence tests live above) ──
  {
    const page = await newPage();
    await page.goto(DIST + '?debug=1&gl2n=128');
    await page.waitForFunction(() => window.DMDS_GL2 && window.DMDS_GL2.isReady(), { timeout: 60000 });
    await page.waitForTimeout(25000);
    const excite = await page.evaluate(() => window.DMDS_GL2.status().excite);
    await page.screenshot({ path: path.join(__dirname, 'm1-settled.png') });
    check('visual:settled-capture', excite < 0.1, 'excite=' + excite);
    await page.close();
  }

  await browser.close();
  const pass = results.every(r => r.ok);
  results.forEach(r => console.log((r.ok ? '  ok  ' : '  FAIL'), r.name, r.detail));
  console.log(pass ? 'M1 CORE: PASS (' + results.length + ' checks)' : 'M1 CORE: FAIL');
  process.exit(pass ? 0 : 1);
})().catch(e => { console.error('M1 RUN FAILED', e); process.exit(2); });
