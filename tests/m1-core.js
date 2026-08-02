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
const results = [];
function check(name, ok, detail) { results.push({ name, ok: !!ok, detail: detail || '' }); }

// exact-tuple listener registry + RAF ownership accounting: net counts can
// false-balance (a leak + a remove-of-nonexistent cancel out), so removal
// only unregisters on an exact (target, type, callback, capture) match —
// mirroring EventTarget semantics
const LIFECYCLE_INSTRUMENTS = () => {
  window.__LREG = [];
  const capOf = o => (typeof o === 'object' && o !== null) ? !!o.capture : !!o;
  const ae = EventTarget.prototype.addEventListener, re = EventTarget.prototype.removeEventListener;
  EventTarget.prototype.addEventListener = function (type, fn, o) {
    if (!window.__LREG.some(r => r.t === this && r.type === type && r.fn === fn && r.cap === capOf(o))) {
      window.__LREG.push({ t: this, type, fn, cap: capOf(o) });
    }
    return ae.call(this, type, fn, o);
  };
  EventTarget.prototype.removeEventListener = function (type, fn, o) {
    const i = window.__LREG.findIndex(r => r.t === this && r.type === type && r.fn === fn && r.cap === capOf(o));
    if (i > -1) window.__LREG.splice(i, 1);
    return re.call(this, type, fn, o);
  };
  window.__LSNAP = () => {
    const m = {};
    window.__LREG.forEach(r => {
      const k = ((r.t === window) ? 'window' : (r.t === document) ? 'document' : (r.t.tagName || '?')) + ':' + r.type;
      m[k] = (m[k] || 0) + 1;
    });
    return JSON.stringify(m, Object.keys(m).sort());
  };
  window.__RAF = { pending: new Set() };
  const oraf = window.requestAnimationFrame.bind(window), ocaf = window.cancelAnimationFrame.bind(window);
  window.requestAnimationFrame = cb => {
    let id;
    id = oraf(ts => { window.__RAF.pending.delete(id); cb(ts); });
    window.__RAF.pending.add(id);
    return id;
  };
  window.cancelAnimationFrame = id => { window.__RAF.pending.delete(id); ocaf(id); };
  // steady-state loop count: median pending size over several samples
  window.__RAFCOUNT = async () => {
    const s = [];
    for (let i = 0; i < 9; i++) { await new Promise(r => setTimeout(r, 60)); s.push(window.__RAF.pending.size); }
    return s.sort((a, b) => a - b)[4];
  };
};

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
      // DMDS_BOOTLOG is the durable mirror — the loader element removes
      // itself ~1.1s after the reveal, so reading its DOM here races the
      // removal (latent since the first commit; surfaced when scrim
      // compositing shifted SwiftShader frame pacing)
      log: (window.DMDS_BOOTLOG || []).slice(),
    }));
    check('prod:count-262144', r.status.count === 262144, JSON.stringify(r.status));
    check('prod:seed-line', r.log.some(l => /SEED particles.*262,144/.test(l)), JSON.stringify(r.log));
    check('prod:running', r.status.running === true && r.status.tier === 'gl2');
    check('prod:no-gl-error', r.health.error === 0, 'glError=' + r.health.error);
    check('prod:fbos-complete', r.health.fbo.every(s => s === 0x8CD5), JSON.stringify(r.health.fbo));
    // morph AT production size, measured on a deterministic 32×32 texel
    // sample — not inferred from the 64² numerical run
    const morph512 = await page.evaluate(async () => {
      const before = Array.from(window.DMDS_GL2.debugReadSample().positions);
      window.DMDS_GL2.setFormation('grid', 0.6);
      await new Promise(r2 => setTimeout(r2, 4000));
      const s = window.DMDS_GL2.debugReadSample();
      let changed = 0, finite = true;
      for (let i = 0; i < s.positions.length; i += 4) {
        const d = Math.hypot(s.positions[i] - before[i], s.positions[i + 1] - before[i + 1], s.positions[i + 2] - before[i + 2]);
        if (d > 0.5) changed++;
        for (let k = 0; k < 3; k++) if (!Number.isFinite(s.positions[i + k])) finite = false;
      }
      return { changed, total: s.positions.length / 4, finite };
    });
    check('prod:morph-at-512', morph512.changed > morph512.total * 0.5, morph512.changed + '/' + morph512.total);
    check('prod:morph-finite-at-512', morph512.finite);
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
    const bound = await page.evaluate(() => window.DMDS_GL2.debugGLHealth().oob);
    check('num:all-finite', hygiene.finite);
    // the runtime-derived reset bound itself, not a stand-in; legit motion
    // also stays far inside it at 16:9 (formations span ≲20 here)
    check('num:inside-reset-bound', hygiene.maxR <= bound, 'maxR=' + hygiene.maxR.toFixed(1) + ' bound=' + bound.toFixed(1));
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

    // EXACT reset contract via single-stepping: paused engine, one sim
    // step → position equals the active GPU target texel, velocity is
    // exactly zero, and the next step stays put
    // must be fully settled (mix = 1) so the active target is exactly targB
    await page.waitForFunction(() => window.DMDS_GL2.status().mix === 1, { timeout: 30000 });
    const exact = await page.evaluate(() => {
      window.DMDS_GL2.pause();
      window.DMDS_GL2.debugPoke(2, 150, 150, 150);
      window.DMDS_GL2.debugStep(1);
      const s = window.DMDS_GL2.debugReadState();
      const t = window.DMDS_GL2.debugReadTargets(4);
      const i = 2 * 4; // particle 2 = texel (2,0) in both layouts
      const dp = Math.hypot(s.positions[i] - t.b[i], s.positions[i + 1] - t.b[i + 1], s.positions[i + 2] - t.b[i + 2]);
      const dv = Math.hypot(s.velocities[i], s.velocities[i + 1], s.velocities[i + 2]);
      window.DMDS_GL2.debugStep(1);
      const s2 = window.DMDS_GL2.debugReadState();
      const drift2 = Math.hypot(s2.positions[i] - s.positions[i], s2.positions[i + 1] - s.positions[i + 1], s2.positions[i + 2] - s.positions[i + 2]);
      window.DMDS_GL2.resume();
      return { dp, dv, drift2 };
    });
    check('num:reset-same-step-onto-target', exact.dp < 1e-3, 'dp=' + exact.dp);
    check('num:reset-velocity-exactly-zero', exact.dv === 0, 'dv=' + exact.dv);
    check('num:reset-stable-next-step', exact.drift2 < 0.1, 'drift2=' + exact.drift2);

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
    check('morph:stays-finite-in-bounds', morph.finite && morph.maxR <= bound, 'maxR=' + morph.maxR.toFixed(1));
    check('num:no-page-errors', page.errs.length === 0, page.errs.join('; '));
    await page.close();
  }

  // ── 2b. viewport safety: the reset bound must be derived, not fixed —
  //       ultrawide's ambient corner would cross a fixed 60 ──
  for (const [label, vw, vh] of [['ultrawide-32x9', 3440, 1080], ['portrait', 390, 844]]) {
    const page = await newPage();
    await page.setViewportSize({ width: vw, height: vh });
    await page.goto(DIST + '?debug=1&gl2n=64');
    await page.waitForFunction(() => window.DMDS_GL2 && window.DMDS_GL2.isReady(), { timeout: 60000 });
    await page.waitForTimeout(1500);
    const r = await page.evaluate(async () => {
      const h = window.DMDS_GL2.debugGLHealth();
      const s = window.DMDS_GL2.debugReadState();
      let maxR = 0, finite = true;
      for (let i = 0; i < s.positions.length; i += 4) {
        maxR = Math.max(maxR, Math.hypot(s.positions[i], s.positions[i + 1], s.positions[i + 2]));
        for (let k = 0; k < 3; k++) if (!Number.isFinite(s.positions[i + k])) finite = false;
      }
      // recovery still works against the derived bound
      window.DMDS_GL2.debugPoke(0, h.oob * 4, 0, 0);
      await new Promise(r2 => setTimeout(r2, 1000));
      const s2 = window.DMDS_GL2.debugReadState();
      const rec = Math.hypot(s2.positions[0], s2.positions[1], s2.positions[2]);
      return { oob: h.oob, maxR, finite, rec };
    });
    // the bound must clear the legit envelope by the excursion margin
    check('aspect:' + label + ':bound-covers-envelope', r.oob >= r.maxR + 31, 'oob=' + r.oob.toFixed(1) + ' maxR=' + r.maxR.toFixed(1));
    check('aspect:' + label + ':finite-in-bounds', r.finite && r.maxR <= r.oob, 'maxR=' + r.maxR.toFixed(1));
    check('aspect:' + label + ':recovery-works', r.rec < r.maxR + 10, 'rec=' + r.rec.toFixed(1));
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
  // 3e. runtime context loss → pause; restore → resume with VERIFIED
  //     integrity (status must not be its own evidence)
  {
    const page = await newPage();
    await page.goto(DIST + '?debug=1&gl2n=64');
    await page.waitForFunction(() => window.DMDS_GL2 && window.DMDS_GL2.isReady(), { timeout: 60000 });
    const r = await page.evaluate(async () => {
      // freeze the page choreography: scroll-zone boundary jitter can call
      // setMorphPair mid-test and re-upload targets, racing the before/
      // after texture comparison (the source of an intermittent failure).
      // Stubbing the public API neutralizes the page; the restore handler
      // uses internal paths and is unaffected.
      window.DMDS_GL2.setMorphPair = function () {};
      window.DMDS_GL2.setFormation = function () {};
      const before = window.DMDS_GL2.status();
      const targBefore = Array.from(window.DMDS_GL2.debugReadTargets(8).b);
      const ctx = document.querySelector('#gl').getContext('webgl2');
      const lose = ctx.getExtension('WEBGL_lose_context');
      lose.loseContext();
      await new Promise(r2 => setTimeout(r2, 500));
      const paused = window.DMDS_GL2.status().running === false;
      lose.restoreContext();
      await new Promise(r2 => setTimeout(r2, 1500));
      const after = window.DMDS_GL2.status();
      const health = window.DMDS_GL2.debugGLHealth();
      window.DMDS_GL2.kick(0.4); // a settled field is legally static — provoke motion
      const s1 = window.DMDS_GL2.debugReadSample();
      await new Promise(r2 => setTimeout(r2, 1000));
      const s2 = window.DMDS_GL2.debugReadSample();
      let drift = 0, finite = true;
      for (let i = 0; i < s1.positions.length; i += 4) {
        drift = Math.max(drift, Math.abs(s2.positions[i] - s1.positions[i]));
        for (let k = 0; k < 3; k++) if (!Number.isFinite(s2.positions[i + k])) finite = false;
      }
      // GPU-backed preservation: the REBUILT target texture must carry the
      // same data as before the loss — the name alone is not evidence
      const targAfter = window.DMDS_GL2.debugReadTargets(8).b;
      let targDiff = 0;
      for (let i = 0; i < targBefore.length; i++) targDiff = Math.max(targDiff, Math.abs(targAfter[i] - targBefore[i]));
      // and particles must converge toward that restored target: displace
      // one deterministically, step the paused sim, watch the spring work
      window.DMDS_GL2.pause();
      const ti = 3 * 4;
      window.DMDS_GL2.debugPoke(3, targAfter[ti] + 10, targAfter[ti + 1], targAfter[ti + 2]);
      window.DMDS_GL2.debugStep(90); // 1.5 sim-seconds
      const sc = window.DMDS_GL2.debugReadState();
      const convDist = Math.hypot(sc.positions[ti] - targAfter[ti], sc.positions[ti + 1] - targAfter[ti + 1], sc.positions[ti + 2] - targAfter[ti + 2]);
      window.DMDS_GL2.resume();
      // the 4s demotion timer must be cancelled — outlive its window
      await new Promise(r2 => setTimeout(r2, 4600));
      const late = window.DMDS_GL2.status();
      const demoted = !!(window.DMDS_GL && window.DMDS_GL.isReady());
      return { paused, after, health, drift, finite, formationKept: after.formation === before.formation, targDiff, convDist, late, demoted };
    });
    check('fb:loss-pauses', r.paused === true);
    check('fb:restore-resumes-gl2', r.after.running === true && r.after.tier === 'gl2', JSON.stringify(r.after));
    check('fb:restore-gl-healthy', r.health.error === 0 && r.health.fbo.every(s => s === 0x8CD5), JSON.stringify(r.health));
    check('fb:restore-sim-alive-finite', r.drift > 1e-5 && r.finite, 'drift=' + r.drift);
    check('fb:restore-formation-kept', r.formationKept);
    check('fb:restore-target-texture-preserved', r.targDiff < 1e-3, 'maxDiff=' + r.targDiff);
    check('fb:restore-converges-to-target', r.convDist < 1.0, 'dist=' + r.convDist.toFixed(3));
    check('fb:restore-timer-cancelled', r.late.running === true && r.late.tier === 'gl2' && !r.demoted, JSON.stringify({ late: r.late, demoted: r.demoted }));
    await page.close();
  }
  // 3e2. shader compile failure on the visible canvas → cleanup → tier 2
  {
    const page = await newPage(() => {
      const orig = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (t, o) {
        const ctx = orig.call(this, t, o);
        if (t === 'webgl2' && ctx && this.id === 'gl') {
          const ss = ctx.shaderSource.bind(ctx);
          ctx.shaderSource = (sh, src) => ss(sh, src + '\n#error injected-compile-failure');
        }
        return ctx;
      };
    });
    await page.goto(DIST);
    await page.waitForFunction(() => window.DMDS_GL && window.DMDS_GL.isReady(), { timeout: 60000 });
    const r = await page.evaluate(() => window.DMDS_GL.status());
    check('fb:shader-compile-failure → gl1', r.tier === 'gl1' && r.running === true, JSON.stringify(r));
    await page.close();
  }
  // 3e3. failure after PARTIAL resource build (textures+FBOs+programs
  //      already exist) → destroy() cleans up EVERY created object → tier 2
  {
    const page = await newPage(() => {
      window.__DMDS_GL2_BREAK_LATE__ = true;
      window.__GLACC = { created: [], deleted: [] };
      const orig = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (t, o) {
        const ctx = orig.call(this, t, o);
        if (t === 'webgl2' && ctx && this.id === 'gl') {
          ['Texture', 'Framebuffer', 'Program', 'Buffer', 'VertexArray', 'Shader'].forEach(kind => {
            const c = ctx['create' + kind].bind(ctx), d = ctx['delete' + kind].bind(ctx);
            ctx['create' + kind] = function () { const obj = c.apply(null, arguments); window.__GLACC.created.push(obj); return obj; };
            ctx['delete' + kind] = function (obj) { if (obj) window.__GLACC.deleted.push(obj); return d(obj); };
          });
        }
        return ctx;
      };
    });
    await page.goto(DIST + '?debug=1');
    await page.waitForFunction(() => window.DMDS_GL && window.DMDS_GL.isReady(), { timeout: 60000 });
    const r = await page.evaluate(() => {
      const del = new Set(window.__GLACC.deleted);
      const leaked = window.__GLACC.created.filter(o => !del.has(o)).length;
      return { status: window.DMDS_GL.status(), created: window.__GLACC.created.length, leaked };
    });
    check('fb:partial-build-failure → gl1', r.status.tier === 'gl1' && r.status.running === true, JSON.stringify(r.status));
    check('fb:partial-build-all-objects-deleted', r.created > 0 && r.leaked === 0, 'created=' + r.created + ' leaked=' + r.leaked);
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

  // ── 4. lifecycle: init → destroy → init ×3, exact-tuple listener registry
  //       + RAF ownership, both tiers ──
  for (const tier of ['gl2', 'gl1']) {
    const page = await newPage(LIFECYCLE_INSTRUMENTS);
    if (tier === 'gl1') {
      await page.addInitScript(() => {
        const orig = HTMLCanvasElement.prototype.getContext;
        HTMLCanvasElement.prototype.getContext = function (t, o) { return t === 'webgl2' ? null : orig.call(this, t, o); };
      });
    }
    await page.goto(DIST + (tier === 'gl2' ? '?debug=1&gl2n=64' : ''));
    await page.waitForFunction(t => window['DMDS_' + t.toUpperCase()] && window['DMDS_' + t.toUpperCase()].isReady(), tier === 'gl2' ? 'gl2' : 'gl', { timeout: 60000 });
    // the loader's own RAF (tickLoader) must finish before the baseline
    // sample, or it gets misattributed to the engine
    await page.waitForSelector('#loader', { state: 'detached', timeout: 60000 });
    const r = await page.evaluate(async (engineName) => {
      const E = window[engineName];
      const rafWithEngine = await window.__RAFCOUNT();
      E.destroy();
      const stopped = E.status().running === false && E.isReady() === false;
      const afterFirstDestroy = window.__LSNAP();
      const rafAfterDestroy = await window.__RAFCOUNT();
      const canvas = document.querySelector('#gl');
      for (let c = 0; c < 2; c++) {
        await E.init(canvas, null);
        E.destroy();
      }
      const afterCycles = window.__LSNAP();
      const rafAfterCycles = await window.__RAFCOUNT();
      await E.init(canvas, null);
      await new Promise(r2 => setTimeout(r2, 900));
      const rafAfterReinit = await window.__RAFCOUNT();
      return {
        stopped,
        balanced: afterFirstDestroy === afterCycles, afterFirstDestroy, afterCycles,
        // engine owns exactly one loop: destroyed states match, reinit adds one back
        rafOwnership: rafAfterDestroy === rafWithEngine - 1 && rafAfterCycles === rafAfterDestroy && rafAfterReinit === rafWithEngine,
        rafs: [rafWithEngine, rafAfterDestroy, rafAfterCycles, rafAfterReinit].join(','),
        reinitReady: E.isReady(),
        running: E.status().running,
      };
    }, tier === 'gl2' ? 'DMDS_GL2' : 'DMDS_GL');
    check('life:' + tier + ':destroy-stops-engine', r.stopped);
    check('life:' + tier + ':3-cycles-listener-balanced', r.balanced, r.balanced ? '' : r.afterFirstDestroy + ' vs ' + r.afterCycles);
    check('life:' + tier + ':raf-ownership', r.rafOwnership, 'rafs=' + r.rafs);
    check('life:' + tier + ':reinit-ready-running', r.reinitReady && r.running === true);
    check('life:' + tier + ':no-errors', page.errs.length === 0, page.errs.join('; '));
    await page.close();
  }
  // 4c. destroyed gl2 releases readback state (kept from earlier suite)
  {
    const page = await newPage();
    await page.goto(DIST + '?debug=1&gl2n=64');
    await page.waitForFunction(() => window.DMDS_GL2 && window.DMDS_GL2.isReady(), { timeout: 60000 });
    const r = await page.evaluate(() => {
      window.DMDS_GL2.destroy();
      let readbackThrows = false;
      try { window.DMDS_GL2.debugReadState(); } catch (e) { readbackThrows = true; }
      return { readbackThrows };
    });
    check('life:destroy-releases-state', r.readbackThrows);
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
    // run ARTIFACT, not tracked evidence: writing to a tracked path made
    // every M1 run dirty the tree, poisoning later suites' provenance in
    // the run manifest. The committed tests/m1-settled.png stays as the
    // frozen M1-milestone capture; per-run captures land in gitignored logs/
    fs.mkdirSync(path.join(__dirname, 'logs'), { recursive: true });
    await page.screenshot({ path: path.join(__dirname, 'logs', 'm1-settled.png') });
    check('visual:settled-capture', excite < 0.1, 'excite=' + excite);
    await page.close();
  }

  await browser.close();
  const pass = results.every(r => r.ok);
  results.forEach(r => console.log((r.ok ? '  ok  ' : '  FAIL'), r.name, r.detail));
  console.log(pass ? 'M1 CORE: PASS (' + results.length + ' checks)' : 'M1 CORE: FAIL');
  process.exit(pass ? 0 : 1);
})().catch(e => { console.error('M1 RUN FAILED', e); process.exit(2); });
