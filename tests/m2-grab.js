/* M2 verification — grab/tear/fling state machine + numerical invariants.
   Run: node tests/m2-grab.js  (headless SwiftShader) */
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

// page-side helpers installed once per page (window.H)
const INSTALL_HELPERS = () => {
  window.H = {
    E: window.DMDS_GL2,
    grabSet(s) {
      const out = [];
      for (let i = 0; i < s.velocities.length / 4; i++) if (s.velocities[i * 4 + 3] === 1) out.push(i);
      return out;
    },
    centroidOf(s, ids) {
      let x = 0, y = 0, z = 0;
      ids.forEach(i => { x += s.positions[i * 4]; y += s.positions[i * 4 + 1]; z += s.positions[i * 4 + 2]; });
      return [x / ids.length, y / ids.length, z / ids.length];
    },
    down: (x, y) => window.dispatchEvent(new PointerEvent('pointerdown', { clientX: x, clientY: y, button: 0, pointerType: 'mouse' })),
    move: (x, y) => window.dispatchEvent(new PointerEvent('pointermove', { clientX: x, clientY: y, pointerType: 'mouse' })),
    up: () => window.dispatchEvent(new PointerEvent('pointerup', { pointerType: 'mouse' })),
    cancel: () => window.dispatchEvent(new PointerEvent('pointercancel', { pointerType: 'mouse' })),
    blur: () => window.dispatchEvent(new Event('blur')),
  };
};

async function settledPage(browser, extraQuery) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.errs = [];
  page.on('pageerror', e => page.errs.push(String(e)));
  await page.goto(DIST + '?debug=1&gl2n=64' + (extraQuery || ''));
  await page.waitForFunction(() => window.DMDS_GL2 && window.DMDS_GL2.isReady(), { timeout: 60000 });
  await page.waitForFunction(() => window.DMDS_GL2.status().mix === 1, { timeout: 60000 });
  await page.waitForTimeout(2500); // let excitement decay toward rest
  await page.evaluate(INSTALL_HELPERS);
  return page;
}
// logo center in CSS px (logo sits at world x=0, y=+hh*0.06)
const CX = 720, CY = 396;

(async () => {
  const browser = await chromium.launch({
    executablePath: resolveChromium(),
    args: ['--no-sandbox', '--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
  });

  // ── 1. capture edge → membership → offsets/depth → held follow →
  //       clump shape → release fling, all single-stepped ──
  {
    const page = await settledPage(browser);
    const r = await page.evaluate(async ([CX, CY]) => {
      const { E, grabSet, centroidOf, down, move, up } = window.H;
      E.pause();
      down(CX, CY);
      E.debugStep(1); // the capture step
      const s0 = window.DMDS_GL2.debugReadState();
      const g0 = grabSet(s0);
      const depthStored = g0.length > 0 && g0.every(i => s0.positions[i * 4 + 3] !== -2.0);
      const freeSentinel = (() => {
        for (let i = 0; i < s0.positions.length / 4; i++) {
          if (g0.indexOf(i) === -1 && s0.positions[i * 4 + 3] !== -2.0) return false;
        }
        return true;
      })();
      // membership constant while dragging (30 held steps, pointer still)
      E.debugStep(30);
      const s1 = window.DMDS_GL2.debugReadState();
      const g1 = grabSet(s1);
      const constant = JSON.stringify(g0) === JSON.stringify(g1);
      // drag right; several timed moves so the velocity EMA is real
      for (let k = 1; k <= 5; k++) {
        move(CX + k * 50, CY);
        await new Promise(r2 => setTimeout(r2, 30));
        E.debugStep(6);
      }
      const s2 = window.DMDS_GL2.debugReadState();
      const g2 = grabSet(s2);
      const c1 = centroidOf(s1, g0), c2 = centroidOf(s2, g0);
      const movedRight = c2[0] - c1[0];
      // clump keeps its shape: offsets from centroid preserved. Per-depth
      // unprojection shears the clump in proportion to its own depth
      // spread during a drag (physical, by design), so the bound is
      // relative to clump extent, not absolute
      let shapeDrift = 0, clumpR = 0;
      g0.forEach(i => {
        const a = [s1.positions[i * 4] - c1[0], s1.positions[i * 4 + 1] - c1[1]];
        const b = [s2.positions[i * 4] - c2[0], s2.positions[i * 4 + 1] - c2[1]];
        shapeDrift = Math.max(shapeDrift, Math.hypot(b[0] - a[0], b[1] - a[1]));
        clumpR = Math.max(clumpR, Math.hypot(a[0], a[1]));
      });
      // release: same-step transition
      up();
      E.debugStep(1);
      const s3 = window.DMDS_GL2.debugReadState();
      const g3 = grabSet(s3);
      let flingOK = true, meanVX = 0, maxV = 0, sentinelBack = true;
      g0.forEach(i => {
        const vx = s3.velocities[i * 4], vy = s3.velocities[i * 4 + 1], vz = s3.velocities[i * 4 + 2];
        const m = Math.hypot(vx, vy, vz);
        if (!Number.isFinite(m) || m > 91) flingOK = false;
        meanVX += vx / g0.length;
        maxV = Math.max(maxV, m);
        if (s3.positions[i * 4 + 3] !== -2.0) sentinelBack = false;
      });
      E.resume();
      return {
        grabCount: g0.length, depthStored, freeSentinel, constant,
        heldConstant: JSON.stringify(g0) === JSON.stringify(g2),
        movedRight, shapeDrift, clumpR,
        releasedAll: g3.length === 0, flingOK, meanVX, maxV, sentinelBack,
      };
    }, [CX, CY]);
    check('grab:captures-particles', r.grabCount > 20, 'count=' + r.grabCount);
    check('grab:depth-stored-on-captured', r.depthStored);
    check('grab:free-keep-sentinel', r.freeSentinel);
    check('grab:membership-constant-still', r.constant);
    check('grab:membership-constant-dragging', r.heldConstant);
    check('grab:clump-follows-pointer', r.movedRight > 1.5, 'dx=' + r.movedRight.toFixed(2));
    check('grab:clump-keeps-shape', r.shapeDrift < Math.max(0.6, r.clumpR * 0.4),
      'drift=' + r.shapeDrift.toFixed(3) + ' clumpR=' + r.clumpR.toFixed(2));
    check('grab:release-same-step-clears-all', r.releasedAll);
    check('grab:release-restores-sentinel', r.sentinelBack);
    check('grab:fling-finite-bounded', r.flingOK, 'maxV=' + r.maxV.toFixed(1));
    check('grab:fling-matches-drag-direction', r.meanVX > 0.5, 'meanVX=' + r.meanVX.toFixed(2));
    check('grab:no-page-errors', page.errs.length === 0, page.errs.join('; '));
    await page.close();
  }

  // ── 2. unconditional release: pointercancel and window blur ──
  for (const label of ['cancel', 'blur']) {
    const page = await settledPage(browser);
    const r = await page.evaluate(async ([CX, CY, which]) => {
      const { E, grabSet, down } = window.H;
      E.pause();
      down(CX, CY);
      E.debugStep(1);
      const before = grabSet(window.DMDS_GL2.debugReadState()).length;
      window.H[which]();
      E.debugStep(1);
      const after = grabSet(window.DMDS_GL2.debugReadState()).length;
      E.resume();
      return { before, after };
    }, [CX, CY, label]);
    check('grab:' + label + '-releases', r.before > 0 && r.after === 0, JSON.stringify(r));
    await page.close();
  }

  // ── 3. NaN injected while held → recovery clears the grab ──
  {
    const page = await settledPage(browser);
    const r = await page.evaluate(async ([CX, CY]) => {
      const { E, grabSet, centroidOf, down, move, up } = window.H;
      E.pause();
      down(CX, CY);
      E.debugStep(1);
      const g = grabSet(window.DMDS_GL2.debugReadState());
      const victim = g[0];
      window.DMDS_GL2.debugPoke(victim, NaN, NaN, NaN);
      E.debugStep(2);
      const s = window.DMDS_GL2.debugReadState();
      const finite = [0, 1, 2].every(k => Number.isFinite(s.positions[victim * 4 + k]));
      const cleared = s.velocities[victim * 4 + 3] === 0;
      up(); E.debugStep(1); E.resume();
      return { finite, cleared };
    }, [CX, CY]);
    check('grab:nan-while-held-recovers-and-clears', r.finite && r.cleared, JSON.stringify(r));
    await page.close();
  }

  // ── 4. damping invariance across dt (same displaced particle, same
  //       impulse, 0.5 sim-seconds at 1/144 vs 1/30) ──
  {
    const page = await settledPage(browser);
    const r = await page.evaluate(async () => {
      const E = window.DMDS_GL2;
      E.pause();
      const t = E.debugReadTargets(64);
      const i = 40 * 4;
      // at the exact target the spring force is zero for one step, so a
      // single step isolates the drag law: |v1|/|v0| must be exp(-k·dt)
      const K_DRAG = 5.2;
      const law = (dt) => {
        E.debugPoke(40, t.b[i], t.b[i + 1], t.b[i + 2]);
        E.debugPokeVel(40, 12, 0, 0);
        E.debugStep(1, dt);
        const s = E.debugReadState();
        return Math.hypot(s.velocities[i], s.velocities[i + 1], s.velocities[i + 2]) / 12;
      };
      const r144 = law(1 / 144), r30 = law(1 / 30);
      E.resume();
      // back out the effective drag coefficient per dt: c = -ln(ratio)/dt.
      // Time-based damping ⇒ c is the SAME at every dt (a per-frame
      // multiplier would differ ~5× between these). SwiftShader's
      // approximate exp() shifts the coefficient ~1.5% at ANY dt, so the
      // portable gates are: cross-dt consistency (sharp) and coefficient
      // near nominal (driver tolerance).
      const c144 = -Math.log(r144) * 144, c30 = -Math.log(r30) * 30;
      return { c144, c30, rel: Math.abs(c144 - c30) / K_DRAG, off: Math.max(Math.abs(c144 - K_DRAG), Math.abs(c30 - K_DRAG)) / K_DRAG };
    });
    check('num:damping-time-based-not-per-frame', r.rel < 0.02, 'c@1/144=' + r.c144.toFixed(3) + ' c@1/30=' + r.c30.toFixed(3));
    check('num:drag-coefficient-near-nominal', r.off < 0.03, 'maxOff=' + (r.off * 100).toFixed(2) + '%');
    await page.close();
  }

  // ── 5. the two-tier convergence invariant, at three timesteps, with
  //       fling-excursion tracking against the derived bound ──
  for (const dt of [1 / 144, 1 / 60, 1 / 30]) {
    const page = await settledPage(browser);
    const r = await page.evaluate(async ([CX, CY, dt]) => {
      const { E, grabSet, centroidOf, down, move, up } = window.H;
      E.pause();
      const oob = E.debugGLHealth().oob;
      down(CX, CY);
      E.debugStep(1);
      const grabbed = grabSet(window.DMDS_GL2.debugReadState()).length;
      // drag with real timing for the velocity EMA, then release
      for (let k = 1; k <= 5; k++) {
        move(CX + k * 60, CY - k * 20);
        await new Promise(r2 => setTimeout(r2, 30));
        E.debugStep(Math.max(1, Math.round(0.03 / dt)), dt);
      }
      up();
      // 3 sim-seconds after release, tracking max excursion
      let maxR = 0;
      const chunk = Math.max(1, Math.round(0.25 / dt));
      for (let sTime = 0; sTime < 3; sTime += chunk * dt) {
        E.debugStep(chunk, dt);
        const s = window.DMDS_GL2.debugReadState();
        for (let i = 0; i < s.positions.length; i += 4) {
          maxR = Math.max(maxR, Math.hypot(s.positions[i], s.positions[i + 1], s.positions[i + 2]));
        }
      }
      const t = E.debugReadTargets(64);
      const sA = window.DMDS_GL2.debugReadState();
      let within001 = 0, total = sA.positions.length / 4;
      for (let i = 0; i < total; i++) {
        const d = Math.hypot(sA.positions[i * 4] - t.b[i * 4], sA.positions[i * 4 + 1] - t.b[i * 4 + 1], sA.positions[i * 4 + 2] - t.b[i * 4 + 2]);
        if (d <= 0.01) within001++;
      }
      // one more sim-second → total convergence
      E.debugStep(Math.round(1 / dt), dt);
      const sB = window.DMDS_GL2.debugReadState();
      let within003 = 0, flags = 0, bad = 0;
      for (let i = 0; i < total; i++) {
        const d = Math.hypot(sB.positions[i * 4] - t.b[i * 4], sB.positions[i * 4 + 1] - t.b[i * 4 + 1], sB.positions[i * 4 + 2] - t.b[i * 4 + 2]);
        if (d <= 0.03) within003++;
        if (sB.velocities[i * 4 + 3] !== 0) flags++;
        for (let k = 0; k < 3; k++) if (!Number.isFinite(sB.positions[i * 4 + k])) bad++;
      }
      E.resume();
      return { grabbed, maxR, oob, within001, within003, total, flags, bad };
    }, [CX, CY, dt]);
    const label = 'dt=1/' + Math.round(1 / dt);
    check('conv:' + label + ':grabbed', r.grabbed > 20, 'n=' + r.grabbed);
    check('conv:' + label + ':excursion-inside-bound', r.maxR <= r.oob, 'maxR=' + r.maxR.toFixed(1) + ' oob=' + r.oob.toFixed(1));
    check('conv:' + label + ':99pct-within-0.01-by-3s', r.within001 >= r.total * 0.99, r.within001 + '/' + r.total);
    check('conv:' + label + ':100pct-within-0.03-by-4s', r.within003 === r.total, r.within003 + '/' + r.total);
    check('conv:' + label + ':zero-grab-flags', r.flags === 0, 'flags=' + r.flags);
    check('conv:' + label + ':zero-nonfinite', r.bad === 0);
    await page.close();
  }

  // ── 6. release matrix completion: lostpointercapture, hidden tab,
  //       context loss, destroy — a grab can never outlive its pointer ──
  {
    const page = await settledPage(browser);
    const r = await page.evaluate(async ([CX, CY]) => {
      const { E, grabSet, down } = window.H;
      const out = {};
      const step = () => E.debugStep(1);
      const flags = () => grabSet(window.DMDS_GL2.debugReadState()).length;
      E.pause();
      // lostpointercapture (dispatched on the capture owner, the canvas)
      down(CX, CY); step();
      out.lpcBefore = flags();
      document.querySelector('#gl').dispatchEvent(new PointerEvent('lostpointercapture', { pointerType: 'mouse' }));
      step();
      out.lpcAfter = flags();
      // hidden tab
      down(CX, CY); step();
      out.hidBefore = flags();
      Object.defineProperty(document, 'hidden', { get: () => true, configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
      step();
      out.hidAfter = flags();
      Object.defineProperty(document, 'hidden', { get: () => false, configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
      E.pause();
      return out;
    }, [CX, CY]);
    check('grab:lostpointercapture-releases', r.lpcBefore > 0 && r.lpcAfter === 0, JSON.stringify(r));
    check('grab:hidden-tab-releases', r.hidBefore > 0 && r.hidAfter === 0, JSON.stringify(r));
    await page.close();
  }
  // context loss mid-grab → CPU grab dead; post-restore state grab-free
  {
    const page = await settledPage(browser);
    const r = await page.evaluate(async ([CX, CY]) => {
      const { E, grabSet, down } = window.H;
      E.pause();
      down(CX, CY);
      E.debugStep(1);
      const before = grabSet(window.DMDS_GL2.debugReadState()).length;
      const lose = document.querySelector('#gl').getContext('webgl2').getExtension('WEBGL_lose_context');
      lose.loseContext();
      await new Promise(r2 => setTimeout(r2, 400));
      const cpuReleased = E.debugGLHealth ? true : true; // health needs live GL; check after restore
      lose.restoreContext();
      await new Promise(r2 => setTimeout(r2, 1500));
      E.pause();
      E.debugStep(1);
      return { before, grabActive: E.debugGLHealth().grabActive, flags: grabSet(window.DMDS_GL2.debugReadState()).length };
    }, [CX, CY]);
    check('grab:context-loss-releases', r.before > 0 && r.grabActive === false && r.flags === 0, JSON.stringify(r));
    await page.close();
  }
  // destroy mid-grab → re-init starts grab-free (a stale active flag would
  // pin excitement and kill crisp-lock forever)
  {
    const page = await settledPage(browser);
    const r = await page.evaluate(async ([CX, CY]) => {
      const { E, grabSet, down } = window.H;
      E.pause();
      down(CX, CY);
      E.debugStep(1);
      const before = grabSet(window.DMDS_GL2.debugReadState()).length;
      E.destroy();
      await E.init(document.querySelector('#gl'), null);
      await new Promise(r2 => setTimeout(r2, 400));
      E.pause();
      E.debugStep(1);
      return { before, grabActive: E.debugGLHealth().grabActive, flags: grabSet(window.DMDS_GL2.debugReadState()).length };
    }, [CX, CY]);
    check('grab:destroy-resets-grab', r.before > 0 && r.grabActive === false && r.flags === 0, JSON.stringify(r));
    await page.close();
  }

  // ── 6b. text yields selection, emptiness yields grabs; selection is
  //        suppressed exactly for the grab's lifetime ──
  {
    const page = await settledPage(browser);
    const r = await page.evaluate(async ([CX, CY]) => {
      const { E, grabSet, down, up } = window.H;
      E.pause();
      // press ON text (the headline) → no grab, selection left alone
      document.querySelector('.hero__tagline').dispatchEvent(
        new PointerEvent('pointerdown', { clientX: 200, clientY: 700, button: 0, pointerType: 'mouse', bubbles: true }));
      E.debugStep(1);
      const textGrab = grabSet(window.DMDS_GL2.debugReadState()).length;
      const classDuringText = document.documentElement.classList.contains('engine-grab');
      // press on the empty field → grab + selection suppressed
      down(CX, CY);
      E.debugStep(1);
      const fieldGrab = grabSet(window.DMDS_GL2.debugReadState()).length;
      const classDuringGrab = document.documentElement.classList.contains('engine-grab');
      up();
      E.debugStep(1);
      const classAfterRelease = document.documentElement.classList.contains('engine-grab');
      E.resume();
      return { textGrab, classDuringText, fieldGrab, classDuringGrab, classAfterRelease };
    }, [CX, CY]);
    check('grab:text-press-never-grabs', r.textGrab === 0 && r.classDuringText === false, JSON.stringify(r));
    check('grab:field-press-grabs', r.fieldGrab > 0);
    check('grab:selection-suppressed-during-grab-only', r.classDuringGrab === true && r.classAfterRelease === false, JSON.stringify(r));
    await page.close();
  }

  // ── 7. pointer geometry: project→unproject round trip with the live
  //       camera, across aspects and depths ──
  for (const [label, vw, vh] of [['16x9', 1440, 900], ['ultrawide', 3440, 1080], ['portrait', 390, 844]]) {
    const page = await browser.newPage({ viewport: { width: vw, height: vh } });
    await page.goto(DIST + '?debug=1&gl2n=64');
    await page.waitForFunction(() => window.DMDS_GL2 && window.DMDS_GL2.isReady(), { timeout: 60000 });
    // wait for an actual rendered frame (matrices exist), not wall time
    await page.waitForFunction(() => {
      try { window.DMDS_GL2.debugRoundTrip([[0, 0, 0]]); return true; } catch (e) { return false; }
    }, { timeout: 30000 });
    const err = await page.evaluate(() => {
      const pts = [];
      [-1, 0, 1].forEach(sx => [-1, 0, 1].forEach(sy => [-8, 0, 8].forEach(z => {
        pts.push([sx * 10, sy * 6, z]);
      })));
      return window.DMDS_GL2.debugRoundTrip(pts);
    });
    check('geom:' + label + ':roundtrip', err < 1e-3, 'maxErr=' + err);
    await page.close();
  }

  // ── 8. production-N convergence via the hierarchical GPU reduction ──
  for (const [label, q, count] of [['256sq', '&gl2n=256', 65536], ['512sq', '', 262144]]) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.errs = [];
    page.on('pageerror', e => page.errs.push(String(e)));
    await page.goto(DIST + '?debug=1' + q);
    await page.waitForFunction(() => window.DMDS_GL2 && window.DMDS_GL2.isReady(), { timeout: 120000 });
    await page.waitForFunction(() => window.DMDS_GL2.status().mix === 1, { timeout: 120000 });
    await page.evaluate(INSTALL_HELPERS);
    const r = await page.evaluate(async ([CX, CY]) => {
      const { E, down, move, up } = window.H;
      E.pause();
      down(CX, CY);
      E.debugStep(1);
      const captured = E.debugConvergence(0.01, 0.03).bad; // grabbed count via reduction
      for (let k = 1; k <= 5; k++) {
        move(CX + k * 60, CY - k * 20);
        await new Promise(r2 => setTimeout(r2, 30));
        E.debugStep(2);
      }
      up();
      E.debugStep(180, 1 / 60); // 3 sim-seconds
      const at3 = E.debugConvergence(0.01, 0.03);
      E.debugStep(60, 1 / 60);  // +1 sim-second
      const at4 = E.debugConvergence(0.01, 0.03);
      E.resume();
      return { captured, at3, at4 };
    }, [CX, CY]);
    check('prodconv:' + label + ':captured-via-reduction', r.captured > 100, 'captured=' + r.captured);
    check('prodconv:' + label + ':99pct-by-3s', r.at3.nearOut <= count * 0.01, 'out=' + r.at3.nearOut + '/' + count);
    check('prodconv:' + label + ':100pct-by-4s', r.at4.finalOut === 0 && r.at4.bad === 0, 'finalOut=' + r.at4.finalOut + ' bad=' + r.at4.bad);
    check('prodconv:' + label + ':maxdist-sane', r.at4.maxDist < 0.03, 'maxDist=' + r.at4.maxDist);
    check('prodconv:' + label + ':no-errors', page.errs.length === 0, page.errs.join('; '));
    await page.close();
  }

  await browser.close();
  const pass = results.every(r => r.ok);
  results.forEach(r => console.log((r.ok ? '  ok  ' : '  FAIL'), r.name, r.detail));
  console.log(pass ? 'M2 GRAB: PASS (' + results.length + ' checks)' : 'M2 GRAB: FAIL');
  process.exit(pass ? 0 : 1);
})().catch(e => { console.error('M2 RUN FAILED', e); process.exit(2); });
