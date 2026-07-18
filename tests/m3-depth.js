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

  // ── 5. commands during context loss: newest wins, pair cache invalidated ──
  {
    const page = await readyPage(browser, '?debug=1&gl2n=64');
    await page.waitForFunction(() => window.DMDS_GL2.status().mix === 1, { timeout: 60000 });
    const r = await page.evaluate(async () => {
      const E = window.DMDS_GL2;
      // keep real refs, stub the public API so page choreography can't
      // fight the scripted command sequence
      const sf = E.setFormation.bind(E), smp = E.setMorphPair.bind(E);
      E.setFormation = function () {}; E.setMorphPair = function () {};
      // GPU-backed reference: materialize neural once and save its target
      // texels — restoration is judged against these, never against status
      sf('neural', 0.2);
      E.pause(); E.debugStep(30, 1 / 60); // settle mix deterministically
      const neuralRef = Array.from(E.debugReadTargets(64).b); // FULL 64² texture — all 4096 texels
      sf('logo', 0.2); E.debugStep(30, 1 / 60); E.resume();
      smp('logo', 'grid', 0.3); // pre-loss scrub pair, uploaded
      const lose = document.querySelector('#gl').getContext('webgl2').getExtension('WEBGL_lose_context');
      lose.loseContext();
      await new Promise(r2 => setTimeout(r2, 400));
      sf('device', 0.2);  // requested while lost
      sf('neural', 0.2);  // newer request while lost — must win
      lose.restoreContext();
      await new Promise(r2 => setTimeout(r2, 1500));
      const nameAfter = E.status().formation;
      // the rebuilt textures must CONTAIN neural, not merely claim it
      const restA = E.debugReadTargets(64).a, restB = E.debugReadTargets(64).b;
      let refDiff = 0;
      for (let i = 0; i < neuralRef.length; i++) {
        refDiff = Math.max(refDiff, Math.abs(restA[i] - neuralRef[i]), Math.abs(restB[i] - neuralRef[i]));
      }
      // the stale-pair hazard: SAME pair as pre-loss — with the bug the
      // guard skips re-upload and both textures hold 'neural'
      smp('logo', 'grid', 0.7);
      await new Promise(r2 => setTimeout(r2, 300));
      const t = E.debugReadTargets(16);
      let abDiff = 0;
      for (let i = 0; i < t.a.length; i++) abDiff = Math.max(abDiff, Math.abs(t.a[i] - t.b[i]));
      // convergence sanity after the whole sequence — leave scrub mode via
      // a formation that is NOT the scrub's current name ('grid' at t=0.7
      // would early-return and leave the shader targeting the pair blend)
      sf('device', 0.2);
      E.pause();
      E.debugStep(30, 1 / 60); // mix → 1 deterministically
      const tb = E.debugReadTargets(4).b;
      E.debugPoke(2, tb[8] + 8, tb[9], tb[10]);
      E.debugStep(120);
      const s = E.debugReadState();
      const conv = Math.hypot(s.positions[8] - tb[8], s.positions[9] - tb[9], s.positions[10] - tb[10]);
      E.resume();
      return { nameAfter, refDiff, abDiff, conv };
    });
    check('loss:newest-request-wins', r.nameAfter === 'neural', r.nameAfter);
    check('loss:restored-textures-hold-newest', r.refDiff < 1e-3, 'maxDiff-vs-neural-ref=' + r.refDiff);
    check('loss:pair-cache-invalidated', r.abDiff > 1.0, 'A↔B maxDiff=' + r.abDiff.toFixed(2));
    check('loss:converges-after-sequence', r.conv < 1.0, 'dist=' + r.conv.toFixed(3));
    await page.close();
  }

  // ── 6. parallax amplitude (fixed-step, exact) + depth differential ──
  {
    const page = await readyPage(browser, '?debug=1&gl2n=64');
    const r = await page.evaluate(async () => {
      const E = window.DMDS_GL2;
      const mm = (x, y) => window.dispatchEvent(new MouseEvent('mousemove', { clientX: x, clientY: y }));
      E.pause();
      mm(1440, 450); // mouse.x = +1
      E.debugStep(600, 1 / 60); // lerp fully settles, deterministically
      const camR = E.debugCamera();
      mm(0, 450); // mouse.x = -1
      E.debugStep(600, 1 / 60);
      const camL = E.debugCamera();
      // depth differential on the SCROLL axis: scroll trucks the camera
      // without touching the sway rotation (mouse.x feeds both, so the
      // pointer axis can't isolate trucking from rotation)
      mm(720, 450); // recenter pointer
      const sc = E.setScroll.bind(E);
      E.setScroll = function () {}; // page raf must not override
      sc(0);
      E.debugStep(600, 1 / 60);
      const nearT = E.debugProject([[0, 0, 6]])[0], farT = E.debugProject([[0, 0, -6]])[0];
      sc(1);
      E.debugStep(600, 1 / 60);
      const nearB = E.debugProject([[0, 0, 6]])[0], farB = E.debugProject([[0, 0, -6]])[0];
      E.resume();
      return {
        camR, camL,
        expR: camR.mouseX * 0.4, expL: camL.mouseX * 0.4,
        nearShift: nearB[1] - nearT[1], farShift: farB[1] - farT[1],
      };
    });
    check('par:amplitude-exact-right', Math.abs(r.camR.parX - r.expR) < 0.02, 'parX=' + r.camR.parX.toFixed(3) + ' want=' + r.expR.toFixed(3));
    check('par:amplitude-exact-left', Math.abs(r.camL.parX - r.expL) < 0.02, 'parX=' + r.camL.parX.toFixed(3));
    // trucking must produce DEPTH-DEPENDENT shift — a uniform screen
    // translation would fail this (near points shift more than far)
    check('par:depth-differential', Math.abs(r.nearShift) > Math.abs(r.farShift) * 1.15,
      'near=' + r.nearShift.toFixed(4) + ' far=' + r.farShift.toFixed(4));
    await page.close();
  }

  // ── 7. interrupted type morph: dust factor blends, no binary pop ──
  {
    const page = await readyPage(browser, '?debug=1'); // 512², dust exists
    await page.waitForFunction(() => window.DMDS_GL2.status().mix === 1, { timeout: 120000 });
    const r = await page.evaluate(async () => {
      const E = window.DMDS_GL2;
      const sf = E.setFormation.bind(E);
      E.setFormation = function () {}; E.setMorphPair = function () {};
      // deterministic stepping — wall-clock waits can't hit a mid-morph
      // window under SwiftShader's seconds-per-frame at 512²
      E.pause();
      sf('text:AB', 2.5);                    // long morph toward dusty text
      E.debugStep(54, 1 / 60);               // 0.9 sim-s → mix ≈ 0.36
      const midMix = E.status().mix;
      // per-particle expectation: each particle's frozen target must equal
      // the STAGGERED blend it was chasing — capture A/B before interrupt
      const preA = E.debugReadTargets(16, 0, 400).a, preB = E.debugReadTargets(16, 0, 400).b;
      sf('grid', 1.0);                       // interrupt → targA = GPU freeze
      const frozen = E.debugReadTargets(16, 0, 400).a; // overflow indices
      E.resume();
      let minW = 2, maxW = -1, finite = true, offSegment = 0, wtMismatch = 0, tOutOfRange = 0, n = frozen.length / 4;
      for (let i = 0; i < n; i++) {
        const w = frozen[i * 4 + 3];
        minW = Math.min(minW, w); maxW = Math.max(maxW, w);
        for (let k = 0; k < 3; k++) if (!Number.isFinite(frozen[i * 4 + k])) finite = false;
        // frozen point must lie on the A→B segment at ITS OWN blend factor:
        // recover t from the DOMINANT axis (a small-span axis amplifies
        // 16F quantization into a garbage t) and verify the other axes
        let bestK = 0, bestSpan = 0;
        for (const k of [0, 1, 2]) {
          const span = Math.abs(preB[i * 4 + k] - preA[i * 4 + k]);
          if (span > bestSpan) { bestSpan = span; bestK = k; }
        }
        if (bestSpan < 0.5) continue; // degenerate segment — nothing to verify
        const t = (frozen[i * 4 + bestK] - preA[i * 4 + bestK]) / (preB[i * 4 + bestK] - preA[i * 4 + bestK]);
        for (const k of [0, 1, 2]) {
          if (k === bestK) continue;
          const exp = preA[i * 4 + k] + (preB[i * 4 + k] - preA[i * 4 + k]) * t;
          if (Math.abs(frozen[i * 4 + k] - exp) > 0.05) offSegment++;
        }
        // the decisive check: preA.w=0, preB.w=1 here, so frozen.w IS the
        // blend factor — positions and dust must use the SAME per-particle
        // factor, and it must be a valid blend. A shader using any OTHER
        // varied factor (e.g. hash11(id) directly) passes spread+segment
        // but fails this.
        if (Math.abs(w - t) > 0.02) wtMismatch++;
        if (t < -0.02 || t > 1.02) tOutOfRange++;
      }
      // golden float32 vectors: recompute stag for each sampled id with a
      // Math.fround-exact replica of the GLSL and compare against frozen.w
      // (preA.w=0, preB.w=1 here, so frozen.w IS the stagger). Catches
      // altered constants and precision failures at high particle ids.
      const f = Math.fround;
      const hash11f32 = p => {
        p = f(p * f(0.1031)); p = f(p - Math.floor(p));
        p = f(p * f(p + f(33.33)));
        p = f(p * f(p + p));
        return f(p - Math.floor(p));
      };
      const stagf32 = (id, m) => {
        const r1 = hash11f32(f(f(id * f(0.1031)) + f(0.13)));
        let s = Math.min(1, Math.max(0, f(f(m - f(r1 * f(0.35))) / f(0.65))));
        return f(s * f(s * f(3 - f(2 * s))));
      };
      const m32 = f(midMix);
      let goldenMax = 0;
      for (let i = 0; i < n; i++) {
        const id = (400 + Math.floor(i / 16)) * 512 + (i % 16); // region (0,400)
        goldenMax = Math.max(goldenMax, Math.abs(frozen[i * 4 + 3] - stagf32(id, m32)));
      }
      return { midMix, minW, maxW, spread: maxW - minW, finite, offSegment, wtMismatch, tOutOfRange, goldenMax, n };
    });
    check('dust:interrupt-mid-morph', r.midMix > 0.05 && r.midMix < 0.95, 'mix=' + r.midMix.toFixed(2));
    // per-particle stagger ⇒ the frozen dust factors VARY (a uniform value
    // is the fingerprint of a global blend — the previous bug)
    check('dust:freeze-is-per-particle', r.spread > 0.2, 'w∈[' + r.minW.toFixed(3) + ',' + r.maxW.toFixed(3) + '] spread=' + r.spread.toFixed(3));
    check('dust:freeze-on-own-segment', r.offSegment === 0, 'off=' + r.offSegment + '/' + r.n * 2);
    check('dust:freeze-w-equals-position-t', r.wtMismatch === 0, 'mismatch=' + r.wtMismatch + '/' + r.n);
    check('dust:freeze-t-in-range', r.tOutOfRange === 0, 'out=' + r.tOutOfRange);
    check('dust:freeze-matches-f32-golden', r.goldenMax < 0.01, 'maxDiff=' + r.goldenMax.toFixed(5));
    check('dust:frozen-blend-finite', r.finite);
    await page.close();
  }

  // ── 7b. staged freeze failures: every mid-pass exit leaves clean GL
  //        state, degrades honestly, and the engine keeps simulating ──
  {
    const page = await readyPage(browser, '?debug=1&gl2n=64');
    await page.waitForFunction(() => window.DMDS_GL2.status().mix === 1, { timeout: 60000 });
    const r = await page.evaluate(async () => {
      const E = window.DMDS_GL2;
      const sf = E.setFormation.bind(E);
      E.setFormation = function () {}; E.setMorphPair = function () {};
      const gl = document.querySelector('#gl').getContext('webgl2');
      const out = [];
      const f6 = ['logo', 'grid', 'device', 'neural', 'curve', 'ambient'];
      E.pause();
      for (let stage = 1; stage <= 5; stage++) {
        // three DISTINCT formations per round (a repeat early-returns and
        // never enters the freeze path): settle A, morph toward B, interrupt with C
        const A = f6[(stage * 3) % 6], B = f6[(stage * 3 + 1) % 6], C = f6[(stage * 3 + 2) % 6];
        sf(A, 0.3);
        E.debugStep(30, 1 / 60); // settle
        sf(B, 2.0);
        E.debugStep(30, 1 / 60); // mid-morph
        const before = E.debugGLHealth().freezeDegraded;
        window.__DMDS_FREEZE_BREAK__ = stage;
        sf(C, 1.0); // interrupt → freeze throws at this stage
        window.__DMDS_FREEZE_BREAK__ = 0;
        const fbClean = gl.getParameter(gl.FRAMEBUFFER_BINDING) === null;
        const degradedOnce = E.debugGLHealth().freezeDegraded === before + 1;
        // a normal frame must run cleanly right after the failure
        E.debugStep(5, 1 / 60);
        const glErr = E.debugGLHealth().error;
        const s = E.debugReadSample();
        let finite = true;
        for (let i = 0; i < s.positions.length; i += 4) {
          for (let k = 0; k < 3; k++) if (!Number.isFinite(s.positions[i + k])) finite = false;
        }
        out.push({ stage, fbClean, degradedOnce, glErr, finite });
        E.debugStep(60, 1 / 60); // settle before the next round
      }
      // recovery: with the hook off, the next interrupt must freeze
      // successfully — i.e. WITHOUT touching the degradation counter
      sf('neural', 2.0);
      E.debugStep(30, 1 / 60);
      const dBefore = E.debugGLHealth().freezeDegraded;
      sf('grid', 1.0);
      const dAfter = E.debugGLHealth().freezeDegraded;
      const glOK = E.debugGLHealth().error === 0;
      E.resume();
      return { out, recovered: dAfter === dBefore && glOK, dBefore, dAfter };
    });
    for (const s of r.out) {
      check('freeze:stage' + s.stage + ':clean-degrade',
        s.fbClean && s.degradedOnce && s.glErr === 0 && s.finite,
        JSON.stringify(s));
    }
    check('freeze:recovers-after-staged-failures', r.recovered, 'degraded ' + r.dBefore + '→' + r.dAfter);
    check('freeze:no-page-errors', page.errs.length === 0, page.errs.join('; '));
    await page.close();
  }

  // ── 8. the deepened device formation is measurably volumetric ──
  {
    const page = await readyPage(browser, '?debug=1&gl2n=64');
    await page.waitForFunction(() => window.DMDS_GL2.status().mix === 1, { timeout: 60000 });
    const r = await page.evaluate(async () => {
      const E = window.DMDS_GL2;
      const sf = E.setFormation.bind(E);
      E.setFormation = function () {}; E.setMorphPair = function () {};
      sf('device', 0.2);
      await new Promise(r2 => setTimeout(r2, 200));
      const t = E.debugReadTargets(64).b;
      let minZ = 1e9, maxZ = -1e9, sum = 0, sum2 = 0, n = t.length / 4, finite = true;
      for (let i = 0; i < n; i++) {
        const z = t[i * 4 + 2];
        if (!Number.isFinite(z)) finite = false;
        minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
        sum += z; sum2 += z * z;
      }
      const std = Math.sqrt(sum2 / n - (sum / n) * (sum / n));
      return { minZ, maxZ, std, finite };
    });
    check('depth:device-z-range', r.minZ <= -1.2 && r.maxZ >= 0.7, 'z∈[' + r.minZ.toFixed(2) + ',' + r.maxZ.toFixed(2) + ']');
    check('depth:device-z-variance', r.std > 0.4, 'std=' + r.std.toFixed(3));
    check('depth:device-z-finite', r.finite);
    await page.close();
  }

  await browser.close();
  const pass = results.every(r => r.ok);
  results.forEach(r => console.log((r.ok ? '  ok  ' : '  FAIL'), r.name, r.detail));
  console.log(pass ? 'M3 DEPTH: PASS (' + results.length + ' checks)' : 'M3 DEPTH: FAIL');
  process.exit(pass ? 0 : 1);
})().catch(e => { console.error('M3 RUN FAILED', e); process.exit(2); });
