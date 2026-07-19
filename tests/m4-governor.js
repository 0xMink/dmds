/* M4 verification — two-axis governor, resize-as-reinit, demotion,
   reduced-motion power stop, status honesty.
   Run: node tests/m4-governor.js  (headless SwiftShader; ladder driven
   deterministically through debugGovInject, which calls the SAME
   production evaluation functions as the frame loop) */
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
const BAD = Array(70).fill(30);   // p90 = 30ms → degrade
const GOOD = Array(70).fill(10);  // p90 = 10ms → good window

async function readyPage(browser, query, opts) {
  opts = opts || {};
  const init = opts.init;
  delete opts.init;
  const page = await browser.newPage(Object.assign({ viewport: { width: 1440, height: 900 } }, opts));
  page.errs = [];
  page.on('pageerror', e => page.errs.push(String(e)));
  if (init) await page.addInitScript(init);
  await page.goto(DIST + query);
  await page.waitForFunction(() => window.DMDS_GL2 && window.DMDS_GL2.isReady(), { timeout: 120000 });
  await page.waitForFunction(() => window.DMDS_GL2.status().mix === 1, { timeout: 120000 });
  return page;
}

(async () => {
  const browser = await chromium.launch({
    executablePath: resolveChromium(),
    args: ['--no-sandbox', '--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
  });

  // ── 1. degradation ladder order: rungs 1..3, then size, then post-off,
  //       then demotion request — driven through production evaluation ──
  {
    const page = await readyPage(browser, '?debug=1&gl2n=64&govoff=1');
    const r = await page.evaluate(async ([BAD]) => {
      const E = window.DMDS_GL2;
      const seq = [];
      const snap = () => { const g = E.debugGov(); return { rung: g.rung, sizeIdx: g.sizeIdx, pending: g.pending, post: g.post, demoted: g.demoted }; };
      let demoteCalled = 0;
      E.onDemote(() => demoteCalled++); // capture instead of actually demoting
      E.setFormation = function () {}; E.setMorphPair = function () {};
      for (let i = 0; i < 5; i++) {
        E.debugGovInject(BAD);
        seq.push(snap());
      }
      // the 5th bad FORCED the queued downsize; it executes at a real
      // frame boundary — demotion evidence must come from the applied
      // floor, never from the size the ladder already left
      for (let i = 0; i < 40 && E.status().count !== 1024; i++) await new Promise(r2 => setTimeout(r2, 250));
      const applied = E.status().count;
      E.debugGovInject(BAD); seq.push(snap()); // bad AT the floor: post off
      E.debugGovInject(BAD); seq.push(snap()); // still bad at floor → demote
      const hist = E.debugGovHistory();
      const demoteEntry = hist.filter(e => e.event === 'demote')[0];
      return { seq, applied, demoteCalled, degradedFlag: E.status().degraded,
               forcedLogged: hist.some(e => e.event === 'resize-forced'), demoteEntry };
    }, [BAD]);
    const s = r.seq;
    check('gov:ladder-rungs-first', s[0].rung === 1 && s[1].rung === 2 && s[2].rung === 3, JSON.stringify(s.slice(0, 3)));
    check('gov:ladder-then-size-request', s[3].pending && s[3].pending.idx === 0 && s[3].pending.dir === 'degrade' && !s[3].pending.forced, JSON.stringify(s[3]));
    check('gov:sustained-bad-forces-downsize', s[4].pending && s[4].pending.forced === true && r.forcedLogged, JSON.stringify(s[4]));
    check('gov:floor-actually-applied', r.applied === 1024, 'count=' + r.applied);
    check('gov:ladder-post-off-at-floor', s[5].post === false, JSON.stringify(s[5]));
    check('gov:ladder-ends-in-demotion', r.demoteCalled >= 1, 'demote calls=' + r.demoteCalled);
    check('gov:demote-evidence-at-floor', r.demoteEntry && r.demoteEntry.n === 32, JSON.stringify(r.demoteEntry));
    check('gov:degraded-flag-honest', r.degradedFlag === true);
    check('gov:no-errors', page.errs.length === 0, page.errs.join('; '));
    await page.close();
  }

  // ── 2. cooldown and invalid windows produce no action ──
  {
    const page = await readyPage(browser, '?debug=1&gl2n=64&govoff=1');
    const r = await page.evaluate(async ([BAD]) => {
      const E = window.DMDS_GL2;
      const a1 = E.debugGovInject(BAD);                              // degrade → starts cooldown
      const during = E.debugGov();
      const a2 = E.debugGovInject(BAD, { respectCooldown: true });   // must be ignored
      const after2 = E.debugGov();
      const a3 = E.debugGovInject(BAD, { invalid: true });           // invalid window: no action
      const after3 = E.debugGov();
      return { a1, a2, a3, r1: during.rung, r2: after2.rung, r3: after3.rung, cooling: during.cooling };
    }, [BAD]);
    check('gov:first-bad-degrades', r.a1 === 'degrade' && r.r1 === 1, JSON.stringify(r));
    check('gov:cooldown-blocks', r.a2 === 'cooldown' && r.r2 === 1 && r.cooling === true, JSON.stringify(r));
    check('gov:invalid-window-no-action', r.a3 === 'invalid' && r.r3 === 1);
    await page.close();
  }

  // ── 3. recovery needs two consecutive good windows; a mid streak
  //       resets; promotion above baseline trial-allocates ──
  {
    const page = await readyPage(browser, '?debug=1&gl2n=64&govoff=1');
    const r = await page.evaluate(async ([BAD, GOOD]) => {
      const E = window.DMDS_GL2;
      E.debugGovInject(BAD); // rung 1
      const one = E.debugGovInject(GOOD);
      const midRung = E.debugGov().rung;         // still 1 (needs 2 good)
      E.debugGovInject(Array(70).fill(20));      // "hold" band resets streak
      E.debugGovInject(GOOD);
      const afterHoldReset = E.debugGov().rung;  // still 1
      const two = E.debugGovInject(GOOD);        // second consecutive good
      const recovered = E.debugGov().rung;       // back to 0
      // promotion: two more good windows → size promotion request (trial-allocated)
      E.debugGovInject(GOOD);
      const promo = E.debugGovInject(GOOD);
      const g = E.debugGov();
      return { one, midRung, afterHoldReset, two, recovered, promo, pending: g.pending, sizeIdx: g.sizeIdx, sizes: g.sizes, trialFailed: g.trialFailed };
    }, [BAD, GOOD]);
    check('gov:one-good-not-enough', r.one === 'good' && r.midRung === 1, JSON.stringify(r));
    check('gov:hold-resets-streak', r.afterHoldReset === 1);
    check('gov:two-good-recovers', r.recovered === 0, 'rung=' + r.recovered);
    check('gov:promotion-requested-above-baseline', r.promo === 'improve' && r.pending && r.pending.idx === 2 && r.pending.dir === 'promote', JSON.stringify(r.pending));
    check('gov:trial-alloc-passed', r.trialFailed.length === 0, JSON.stringify(r.trialFailed));
    await page.close();
  }

  // ── 4. emergency path: two rungs at once, then cooldown ──
  {
    const page = await readyPage(browser, '?debug=1&gl2n=64&govoff=1');
    const r = await page.evaluate(async () => {
      const E = window.DMDS_GL2;
      const a = E.debugGovInject([], { emergency: true });
      const g1 = E.debugGov();
      const b = E.debugGovInject([], { emergency: true, respectCooldown: true });
      const g2 = E.debugGov();
      return { a, rung: g1.rung, b, rung2: g2.rung };
    });
    check('gov:emergency-skips-rungs', r.a === 'emergency' && r.rung === 2, JSON.stringify(r));
    check('gov:emergency-respects-cooldown', r.b === 'cooldown' && r.rung2 === 2);
    await page.close();
  }

  // ── 5. resize executes as a managed reinit — idle-only, formation
  //       survives, count changes, governor state persists ──
  {
    const page = await readyPage(browser, '?debug=1&gl2n=64&govoff=1');
    const r = await page.evaluate(async ([GOOD]) => {
      const E = window.DMDS_GL2;
      E.setFormation = function () {}; E.setMorphPair = function () {}; // freeze choreography
      const before = E.status();
      // hold a grab: the pending resize must NOT execute while held
      window.dispatchEvent(new PointerEvent('pointerdown', { clientX: 720, clientY: 396, button: 0, pointerType: 'mouse' }));
      E.debugGovInject(GOOD); E.debugGovInject(GOOD); // promotion → pending
      const pendingDuringGrab = (E.debugGov().pending || {}).idx;
      await new Promise(r2 => setTimeout(r2, 2600));
      const stillPending = (E.debugGov().pending || {}).idx;
      const countDuringGrab = E.status().count;
      window.dispatchEvent(new PointerEvent('pointerup', { pointerType: 'mouse' }));
      // idle path: excitement decays in SIM time (slow-motion under
      // SwiftShader's dt clamp) — poll for the resize instead of guessing
      for (let i = 0; i < 40 && E.status().count === before.count; i++) {
        await new Promise(r2 => setTimeout(r2, 1000));
      }
      const after = E.status();
      const g = E.debugGov();
      return {
        beforeCount: before.count, pendingDuringGrab, stillPending, countDuringGrab,
        afterCount: after.count, formation: after.formation, sizeIdx: g.sizeIdx,
        running: after.running, degradedAfterPromo: after.degraded,
      };
    }, [GOOD]);
    check('resize:requested', r.pendingDuringGrab === 2, 'pending=' + r.pendingDuringGrab);
    check('resize:deferred-while-grabbed', r.stillPending === 2 && r.countDuringGrab === r.beforeCount, JSON.stringify(r));
    check('resize:executes-when-idle', r.afterCount === 128 * 128 && r.sizeIdx === 2, 'count=' + r.afterCount);
    check('resize:formation-survives', r.formation === 'logo', r.formation);
    check('resize:engine-running-after', r.running === true);
    check('resize:promotion-not-degraded', r.degradedAfterPromo === false, 'degraded=' + r.degradedAfterPromo);
    check('resize:no-page-errors', page.errs.length === 0, page.errs.join('; '));
    await page.close();
  }

  // ── 6. performance demotion reaches tier 2 end-to-end ──
  {
    const page = await readyPage(browser, '?debug=1&gl2n=64&govoff=1');
    await page.evaluate(async ([BAD]) => {
      const E = window.DMDS_GL2;
      E.setFormation = function () {}; E.setMorphPair = function () {};
      // walk the whole ladder: rungs → size floor → post off → demote.
      // sizes are idle-deferred; wait for each resize to land.
      for (let i = 0; i < 12; i++) {
        E.debugGovInject(BAD);
        await new Promise(r2 => setTimeout(r2, 2600));
        if (E.debugGov && (() => { try { return E.debugGov().demoted; } catch (e) { return true; } })()) break;
      }
    }, [BAD]).catch(() => {}); // engine may be torn down mid-evaluate at demotion
    await page.waitForFunction(() => window.DMDS_GL && window.DMDS_GL.isReady && window.DMDS_GL.isReady(), { timeout: 60000 });
    const r = await page.evaluate(() => window.DMDS_GL.status());
    check('gov:demotion-boots-tier2', r.tier === 'gl1' && r.running === true, JSON.stringify(r));
    await page.close();
  }

  // ── 7. reduced motion: loop stops after settling, wakes on a command ──
  {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
    page.errs = [];
    page.on('pageerror', e => page.errs.push(String(e)));
    await page.goto(DIST + '?debug=1&gl2n=64&govoff=1');
    await page.waitForFunction(() => window.DMDS_GL2 && window.DMDS_GL2.isReady(), { timeout: 120000 });
    const r = await page.evaluate(async () => {
      const E = window.DMDS_GL2;
      const sf = E.setFormation.bind(E);
      E.setFormation = function () {}; E.setMorphPair = function () {};
      // physical sleep needs ≥4 SIMULATED seconds + excitement < 0.05 —
      // sim time runs slower than wall time under the dt clamp, so poll
      const waitSleep = async () => {
        for (let i = 0; i < 90 && !window.DMDS_GL2.status().sleeping; i++) {
          await new Promise(r2 => setTimeout(r2, 1000));
        }
        return window.DMDS_GL2.status();
      };
      const slept = await waitSleep();
      // sleep may only be claimed over a CRISP field: within snap/final
      // epsilons, tiny residual velocities, zero flags
      const conv = E.debugConvergence(0.012, 0.03);
      const st = E.debugReadState();
      let maxV = 0;
      for (let i = 0; i < st.velocities.length; i += 4) {
        maxV = Math.max(maxV, Math.hypot(st.velocities[i], st.velocities[i + 1], st.velocities[i + 2]));
      }
      sf('grid', 0.2); // a real command must wake it
      await new Promise(r2 => setTimeout(r2, 500));
      const awake = E.status();
      const reslept = await waitSleep();
      return {
        slept: { running: slept.running, sleeping: slept.sleeping, excite: slept.excite },
        conv: { nearOut: conv.nearOut, finalOut: conv.finalOut, bad: conv.bad, maxDist: conv.maxDist, maxV, count: conv.count },
        awake: { running: awake.running, formation: awake.formation },
        reslept: { running: reslept.running, sleeping: reslept.sleeping },
      };
    });
    check('rm:stops-after-settle', r.slept.running === false && r.slept.sleeping === true, JSON.stringify(r.slept));
    check('rm:sleep-is-crisp', r.conv.finalOut === 0 && r.conv.bad === 0 && r.conv.maxDist < 0.03 && r.conv.maxV < 0.1, JSON.stringify(r.conv));
    check('rm:sleep-mostly-snapped', r.conv.nearOut <= r.conv.count * 0.02, 'outside-snap-eps=' + r.conv.nearOut + '/' + r.conv.count);
    check('rm:command-wakes', r.awake.running === true && r.awake.formation === 'grid', JSON.stringify(r.awake));
    check('rm:sleeps-again', r.reslept.running === false && r.reslept.sleeping === true, JSON.stringify(r.reslept));
    check('rm:no-page-errors', page.errs.length === 0, page.errs.join('; '));
    await page.close();
  }

  // ── 8. footer honesty: degradation shows, recovery clears ──
  {
    const page = await readyPage(browser, '?debug=1&gl2n=64&govoff=1');
    const r = await page.evaluate(async ([BAD, GOOD]) => {
      const E = window.DMDS_GL2;
      E.debugGovInject(BAD); // rung 1 — post quality cut, count unchanged
      const degraded = E.status().degraded;
      await new Promise(r2 => setTimeout(r2, 4500)); // footer interval
      const text1 = document.querySelector('#sys-status').textContent;
      E.debugGovInject(GOOD); E.debugGovInject(GOOD); // recover
      const recovered = E.status().degraded;
      await new Promise(r2 => setTimeout(r2, 4500));
      const text2 = document.querySelector('#sys-status').textContent;
      return { degraded, text1, recovered, text2 };
    }, [BAD, GOOD]);
    check('honest:rung-degradation-flagged', r.degraded === true && /DEGRADED/.test(r.text1), r.text1);
    check('honest:recovery-clears', r.recovered === false && /NOMINAL/.test(r.text2) && !/DEGRADED/.test(r.text2), r.text2);
    await page.close();
  }

  // ── 9. transactional resize: failed promotion rolls back to the
  //       known-good size; only a failed rollback demotes ──
  {
    const page = await readyPage(browser, '?debug=1&gl2n=64&govoff=1', {
      init: () => {
        // listener + RAF accounting across the multi-reinit transaction
        window.__LN = 0;
        const ae = EventTarget.prototype.addEventListener, re = EventTarget.prototype.removeEventListener;
        EventTarget.prototype.addEventListener = function () { window.__LN++; return ae.apply(this, arguments); };
        EventTarget.prototype.removeEventListener = function () { window.__LN--; return re.apply(this, arguments); };
        window.__RAFP = new Set();
        const oraf = window.requestAnimationFrame.bind(window), ocaf = window.cancelAnimationFrame.bind(window);
        window.requestAnimationFrame = cb => { let id; id = oraf(ts => { window.__RAFP.delete(id); cb(ts); }); window.__RAFP.add(id); return id; };
        window.cancelAnimationFrame = id => { window.__RAFP.delete(id); ocaf(id); };
      }
    });
    const r = await page.evaluate(async ([GOOD, BAD]) => {
      const E = window.DMDS_GL2;
      E.setFormation = function () {}; E.setMorphPair = function () {};
      const rafCount = async () => {
        const s = [];
        for (let i = 0; i < 7; i++) { await new Promise(r2 => setTimeout(r2, 80)); s.push(window.__RAFP.size); }
        return s.sort((a, b) => a - b)[3];
      };
      // the loader's own RAF must be gone before the baseline (M1 lesson)
      for (let i = 0; i < 60 && document.querySelector('#loader'); i++) {
        await new Promise(r2 => setTimeout(r2, 500));
      }
      const lnBefore = window.__LN, rafBefore = await rafCount();
      window.__DMDS_GL2_BREAK_N__ = [128]; // the promotion target will fail to build
      E.debugGovInject(GOOD); E.debugGovInject(GOOD); // queue promotion
      // wait on the TRANSACTION, not on side-effect inference
      for (let i = 0; i < 60 && !(E.debugGov().txn.phase === 'idle' && E.debugGov().txn.last); i++) {
        await new Promise(r2 => setTimeout(r2, 1000));
      }
      window.__DMDS_GL2_BREAK_N__ = null;
      const txn = E.debugGov().txn;
      const g = E.debugGov();
      const s = E.status();
      // state integrity after rollback: formation survives, field converges
      // onto its GPU targets
      let conv = { finalOut: -1 };
      for (let i = 0; i < 30; i++) {
        await new Promise(r2 => setTimeout(r2, 1000));
        conv = E.debugConvergence(0.05, 0.1);
        if (conv.finalOut === 0 && conv.nearOut === 0) break;
      }
      const lnAfter = window.__LN, rafAfter = await rafCount();
      // no retry of the poisoned size after cooldown
      E.debugGovInject(GOOD); E.debugGovInject(GOOD);
      const retried = E.debugGov().pending;
      // the resize machinery is still healthy for non-poisoned sizes
      E.debugGovInject(BAD); E.debugGovInject(BAD); E.debugGovInject(BAD); E.debugGovInject(BAD);
      for (let i = 0; i < 60 && E.status().count !== 1024; i++) {
        await new Promise(r2 => setTimeout(r2, 1000));
      }
      const downsized = E.status().count;
      return {
        count: s.count, running: s.running, tier: s.tier,
        trialFailed: g.trialFailed, demoted: g.demoted, sizeIdx: g.sizeIdx,
        txn, formation: s.formation, pending: g.pending,
        convOK: conv.finalOut === 0 && conv.nearOut === 0 && conv.bad === 0,
        lnDelta: lnAfter - lnBefore, rafBefore, rafAfter,
        retried, downsized,
      };
    }, [GOOD, BAD]);
    check('txn:failed-promotion-rolls-back', r.count === 4096 && r.running === true && r.tier === 'gl2' && r.sizeIdx === 1, JSON.stringify({ count: r.count, sizeIdx: r.sizeIdx }));
    check('txn:phase-observable', r.txn.phase === 'idle' && r.txn.last === 'rolled-back', JSON.stringify(r.txn));
    check('txn:failed-size-marked', r.trialFailed.indexOf('128') > -1, JSON.stringify(r.trialFailed));
    check('txn:no-demotion-on-rollback', r.demoted === false);
    check('txn:formation-survives-and-converges', r.formation === 'logo' && r.convOK === true, JSON.stringify({ f: r.formation, conv: r.convOK }));
    check('txn:pending-cleared', r.pending === null);
    check('txn:no-listener-or-raf-leak', r.lnDelta === 0 && r.rafAfter === r.rafBefore, 'ln±' + r.lnDelta + ' raf ' + r.rafBefore + '→' + r.rafAfter);
    check('txn:poisoned-size-never-retried', r.retried === null, JSON.stringify(r.retried));
    check('txn:machinery-healthy-after', r.downsized === 1024, 'count=' + r.downsized);
    check('txn:no-page-errors', page.errs.length === 0, page.errs.join('; '));
    await page.close();
  }
  {
    const page = await readyPage(browser, '?debug=1&gl2n=64&govoff=1');
    await page.evaluate(async ([GOOD]) => {
      const E = window.DMDS_GL2;
      E.setFormation = function () {}; E.setMorphPair = function () {};
      window.__DMDS_GL2_BREAK_N__ = [128, 64]; // target AND rollback fail
      E.debugGovInject(GOOD); E.debugGovInject(GOOD);
    }, [GOOD]).catch(() => {});
    await page.waitForFunction(() => window.DMDS_GL && window.DMDS_GL.isReady && window.DMDS_GL.isReady(), { timeout: 90000 });
    const r = await page.evaluate(() => window.DMDS_GL.status());
    check('txn:rollback-failure-demotes', r.tier === 'gl1' && r.running === true, JSON.stringify(r));
    await page.close();
  }

  // ── 10. stale pending requests cancel on opposite evidence ──
  {
    const page = await readyPage(browser, '?debug=1&gl2n=64&govoff=1');
    const r = await page.evaluate(async ([BAD, GOOD]) => {
      const E = window.DMDS_GL2;
      E.setFormation = function () {}; E.setMorphPair = function () {};
      // promotion queued, then performance drops → promotion must cancel
      E.debugGovInject(GOOD); E.debugGovInject(GOOD);
      const queuedPromo = (E.debugGov().pending || {}).dir;
      E.debugGovInject(BAD);
      const afterBad = E.debugGov();
      // downsize queued (rung is already 1 after cancel-and-degrade; three
      // more bads walk 2→3→size request), then recovery → downsize cancels
      E.debugGovInject(BAD); E.debugGovInject(BAD); E.debugGovInject(BAD);
      const queuedDown = (E.debugGov().pending || {}).dir;
      E.debugGovInject(GOOD); E.debugGovInject(GOOD);
      const afterRecover = E.debugGov();
      // give idle machinery a chance — nothing may execute
      await new Promise(r2 => setTimeout(r2, 8000));
      const finalCount = E.status().count;
      const cancels = E.debugGovHistory().filter(e => e.event === 'resize-cancel').map(e => e.reason);
      return { queuedPromo, promoCancelled: afterBad.pending === null, rungAfterBad: afterBad.rung,
               queuedDown, downCancelled: afterRecover.pending === null, finalCount, cancels };
    }, [BAD, GOOD]);
    check('stale:promotion-queued', r.queuedPromo === 'promote');
    check('stale:bad-window-cancels-AND-degrades', r.promoCancelled === true && r.rungAfterBad === 1, JSON.stringify(r));
    check('stale:downsize-queued', r.queuedDown === 'degrade', r.queuedDown);
    check('stale:recovery-cancels-downsize', r.downCancelled === true);
    check('stale:no-spurious-resize', r.finalCount === 4096, 'count=' + r.finalCount);
    // cancellations are LOGGED with reasons — no interpretive archaeology
    check('stale:cancels-logged-with-reasons',
      r.cancels.indexOf('performance-dropped') >= 0 && r.cancels.indexOf('recovery') >= 0,
      JSON.stringify(r.cancels));
    await page.close();
  }

  // ── 11. the REAL collector, fed synthetic time end-to-end ──
  {
    const page = await readyPage(browser, '?debug=1&gl2n=64&govoff=1');
    const r = await page.evaluate(() => {
      const E = window.DMDS_GL2;
      let t = 1000;
      const feed = (n, ms) => { for (let i = 0; i < n; i++) { t += ms / 1000; E.debugGovFrame(ms, t); } };
      // warm-up: 30 frames at 16ms (0.48s) → warmed
      feed(30, 16);
      const warmed = E.debugGov().warmed;
      // startup fast path: a 1s window of bad frames degrades immediately
      feed(35, 30); // 1.05s of 30ms frames — enough presented frames
      const fastRung = E.debugGov().rung;
      // skip past the fast path, then an under-populated window is invalid
      t += 4;
      feed(10, 30); t += 5; feed(1, 30); // closes a 5s window with ~11 frames
      const afterInvalid = E.debugGov().rung;
      // full valid 5s window of good frames → collector counts a good
      feed(260, 20); // 5.2s of 20ms frames — hold band, streak building
      const mid1 = E.debugGov().mid;
      feed(260, 20); // second hold window → sustained-hold degrade
      const afterHold2 = E.debugGov().rung;
      // emergency: a burst of 60ms frames trips the rolling 1s mean —
      // after the sustained-hold cooldown expires (cooldown blocking the
      // emergency is itself correct behavior)
      t += 6;
      const rungBeforeEm = E.debugGov().rung;
      feed(20, 60);
      const afterEm = E.debugGov().rung;
      return { warmed, fastRung, afterInvalid, mid1, afterHold2, rungBeforeEm, afterEm };
    });
    check('collector:warms-up', r.warmed === true);
    check('collector:fast-path-degrades', r.fastRung === 1, 'rung=' + r.fastRung);
    check('collector:invalid-window-no-action', r.afterInvalid === r.fastRung, 'rung=' + r.afterInvalid);
    check('collector:hold-streak-counted', r.mid1 === 1, 'mid=' + r.mid1);
    check('collector:sustained-hold-degrades', r.afterHold2 === r.fastRung + 1, 'rung=' + r.afterHold2);
    check('collector:emergency-via-rolling-mean', r.afterEm === Math.min(5, r.rungBeforeEm + 2) || r.afterEm > r.rungBeforeEm, 'rung ' + r.rungBeforeEm + '→' + r.afterEm);
    await page.close();
  }

  // ── 12. rung effects are OBSERVED, not commanded: real buffer sizes,
  //       real uniform values, real restoration ──
  {
    const page = await readyPage(browser, '?debug=1&gl2n=64&govoff=1');
    const r = await page.evaluate(async ([BAD, GOOD]) => {
      const E = window.DMDS_GL2;
      const wait = () => new Promise(r2 => setTimeout(r2, 700)); // let frames render
      const g0 = E.debugGov();
      E.debugGovInject(BAD); await wait();
      const g1 = E.debugGov(); // rung 1: bloom at eighth-res, aberration uniform 0
      E.debugGovInject(BAD); await wait();
      const g2 = E.debugGov(); // rung 2: trail at half-res
      // honest ladder route: rung 3 → size request → sustained bad forces
      // it → floor APPLIES → bad at the floor turns post off
      E.debugGovInject(BAD); E.debugGovInject(BAD); E.debugGovInject(BAD);
      for (let i = 0; i < 40 && window.DMDS_GL2.status().count !== 1024; i++) await wait();
      E.debugGovInject(BAD); await wait();
      const g5 = E.debugGov(); // at the applied floor, post off
      // recover: rungs restore fully; the duress-marked size does NOT
      // bounce back this session
      for (let i = 0; i < 12; i++) E.debugGovInject(GOOD);
      await wait();
      const gr = E.debugGov();
      return { g0, g1, g2, g5, gr };
    }, [BAD, GOOD]);
    const q = (g) => ({ rung: g.rung, trail: g.trail, glow: g.glow, ab: g.aberrUniform, post: g.post });
    check('observe:baseline-full-quality', r.g0.trail && r.g0.trail[0] === r.g0.canvasPx[0] && r.g0.glow[0] === r.g0.trail[0] >> 2 && r.g0.aberrUniform === 1, JSON.stringify(q(r.g0)));
    check('observe:rung1-bloom-eighth-aberr-off', r.g1.glow[0] === r.g1.trail[0] >> 3 && r.g1.aberrUniform === 0, JSON.stringify(q(r.g1)));
    check('observe:rung2-trail-half', Math.abs(r.g2.trail[0] - Math.round(r.g2.canvasPx[0] / 2)) <= 1, JSON.stringify(q(r.g2)));
    check('observe:post-off-real', r.g5.post === false && r.g5.trail === null, JSON.stringify(q(r.g5)));
    check('observe:recovery-restores', r.gr.rung === 0 && r.gr.trail && r.gr.trail[0] === r.gr.canvasPx[0] && r.gr.glow[0] === r.gr.trail[0] >> 2 && r.gr.aberrUniform === 1, JSON.stringify(q(r.gr)));
    check('observe:duress-marked-size-stays', r.gr.sizeIdx === 0 && r.gr.trialFailed.indexOf('64') >= 0, JSON.stringify({ sizeIdx: r.gr.sizeIdx, trialFailed: r.gr.trialFailed }));
    await page.close();
  }

  // ── 13. status fields are honest: count/baseline/ceiling, no "max" ──
  {
    const page = await readyPage(browser, '?debug=1&gl2n=64&govoff=1');
    const r = await page.evaluate(() => {
      const s = window.DMDS_GL2.status();
      return { count: s.count, baseline: s.baseline, ceiling: s.ceiling, hasMax: 'max' in s, degraded: s.degraded };
    });
    check('status:honest-fields', r.count === 4096 && r.baseline === 4096 && r.ceiling === 16384 && r.hasMax === false && r.degraded === false, JSON.stringify(r));
    await page.close();
  }

  // ── 14. the DPR rung, observed under a real 2× device scale ──
  {
    const page = await readyPage(browser, '?debug=1&gl2n=64&govoff=1', { deviceScaleFactor: 2 });
    const r = await page.evaluate(async ([BAD, GOOD]) => {
      const E = window.DMDS_GL2;
      const wait = () => new Promise(r2 => setTimeout(r2, 700));
      const g0 = E.debugGov();
      const css0 = document.querySelector('#gl').clientWidth;
      E.debugGovInject(BAD); E.debugGovInject(BAD); E.debugGovInject(BAD); await wait();
      const g3 = E.debugGov();
      const css3 = document.querySelector('#gl').clientWidth;
      for (let i = 0; i < 8; i++) E.debugGovInject(GOOD);
      await wait();
      const gr = E.debugGov();
      return {
        dpr0: g0.dprEff, px0: g0.canvasPx, css0,
        rung3: g3.rung, dpr3: g3.dprEff, px3: g3.canvasPx, trail3: g3.trail, css3,
        dprR: gr.dprEff, pxR: gr.canvasPx,
      };
    }, [BAD, GOOD]);
    check('dpr:baseline-caps-at-1.75', Math.abs(r.dpr0 - 1.75) < 0.01, 'dpr=' + r.dpr0 + ' px=' + r.px0);
    check('dpr:rung3-caps-at-1.0', r.rung3 === 3 && Math.abs(r.dpr3 - 1.0) < 0.01 && r.px3[0] === r.css3, 'dpr=' + r.dpr3 + ' px=' + r.px3 + ' css=' + r.css3);
    check('dpr:post-realloc-tracks-backing', r.trail3 && r.trail3[0] === Math.round(r.px3[0] / 2), 'trail=' + r.trail3 + ' (rung3 keeps half-res trail)');
    check('dpr:css-size-unchanged', r.css0 === r.css3, r.css0 + ' vs ' + r.css3);
    check('dpr:recovery-restores', Math.abs(r.dprR - 1.75) < 0.01 && r.pxR[0] === r.px0[0], 'dpr=' + r.dprR);
    await page.close();
  }

  // ── 15. collector invalidation sources: a contaminated window acts
  //        never, the following clean window acts normally ──
  {
    const page = await readyPage(browser, '?debug=1&gl2n=64&govoff=1');
    const r = await page.evaluate(() => {
      const E = window.DMDS_GL2;
      let t = 5000;
      const feed = (n, ms) => { for (let i = 0; i < n; i++) { t += ms / 1000; E.debugGovFrame(ms, t); } };
      feed(30, 16); // warm
      t += 4; // past fast path
      const out = {};
      // browser resize mid-window → invalid → no action
      feed(150, 30);
      window.dispatchEvent(new Event('resize'));
      feed(60, 30); // closes a ~6s window, plenty of frames, marked invalid
      out.afterResizeEvt = E.debugGov().rung;
      // clean bad window after → acts
      feed(200, 30);
      out.afterClean = E.debugGov().rung;
      // hidden→resume mid-window → invalid → no action
      Object.defineProperty(document, 'hidden', { get: () => true, configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
      Object.defineProperty(document, 'hidden', { get: () => false, configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
      feed(210, 30);
      out.afterResume = E.debugGov().rung;
      // and the next clean window acts again
      t += 6; // past cooldown
      feed(200, 30);
      out.afterClean2 = E.debugGov().rung;
      return out;
    });
    check('invalidate:resize-event-window-inert', r.afterResizeEvt === 0, 'rung=' + r.afterResizeEvt);
    check('invalidate:clean-window-acts', r.afterClean === 1, 'rung=' + r.afterClean);
    check('invalidate:resume-window-inert', r.afterResume === 1, 'rung=' + r.afterResume);
    check('invalidate:clean-window-acts-again', r.afterClean2 === 2, 'rung=' + r.afterClean2);
    await page.close();
  }

  // ── 16. LIVE-path demotion end-to-end (the real-hardware crash repro):
  //       SwiftShader's genuinely slow frames drive the LIVE collector
  //       down the whole ladder to demotion — with zero page errors ──
  {
    const page = await readyPage(browser, '?debug=1&gl2n=64&govlive=1');
    // walk happens on its own: warm-up → emergencies/windows → rungs →
    // sizes (idle-deferred) → post off → demote → tier 2 boots
    await page.waitForFunction(() => window.DMDS_GL && window.DMDS_GL.isReady && window.DMDS_GL.isReady(), { timeout: 300000 });
    const r = await page.evaluate(async () => {
      const readHist = () => { try { return window.DMDS_GL2.debugGovHistory(); } catch (e) { return null; } };
      // the trajectory is MOST valuable on the run that demoted — it must
      // survive tier-1 teardown and END at the demote event, immutably:
      // tier 2 keeps rendering below, so if any stale tier-1 loop were
      // still scribbling in the chart, the ring would grow while we wait
      const h1 = readHist();
      await new Promise(res => setTimeout(res, 2000));
      const h2 = readHist();
      return { status: window.DMDS_GL.status(), h1, h2 };
    });
    const crash = page.errs.filter(e => /bindVertexArray|null/.test(e));
    const h1 = r.h1, h2 = r.h2;
    check('live:demotes-cleanly-to-tier2', r.status.tier === 'gl1' && r.status.running === true, JSON.stringify(r.status));
    check('live:no-mid-frame-lifecycle-crash', crash.length === 0, crash.join('; '));
    check('live:no-page-errors-at-all', page.errs.length === 0, page.errs.join('; '));
    check('live:history-survives-demotion', h1 && h1.length > 3 && h1.some(e => e.event === 'demote'),
      h1 ? h1.length + ' entries, events=' + [...new Set(h1.map(e => e.event))] : 'null');
    check('live:history-ends-at-demotion', h1 && h1.length > 0 && h1[h1.length - 1].event === 'demote',
      h1 && h1.length ? 'last=' + h1[h1.length - 1].event : 'null');
    check('live:history-seq-strict', h1 && h1.every((e, i) => i === 0 || e.seq > h1[i - 1].seq));
    check('live:history-immutable-after-demotion',
      h1 && h2 && h2.length === h1.length
      && h2[h2.length - 1].seq === h1[h1.length - 1].seq
      && h2[h2.length - 1].event === 'demote',
      h1 && h2 ? 'len ' + h1.length + '→' + h2.length + ', lastSeq ' + h1[h1.length - 1].seq + '→' + h2[h2.length - 1].seq : 'null');
    // exact snapshot equality: also catches in-place mutation of an
    // existing entry, which length + final seq cannot see
    check('live:history-byte-identical-after-demotion',
      h1 && h2 && JSON.stringify(h1) === JSON.stringify(h2));
    await page.close();
  }

  // ── 17. tier-2 oscillation lock machine: precise cycle identity ──
  {
    const page = await readyPage(browser, '');
    await page.addInitScript(() => {
      const orig = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (t, o) { return t === 'webgl2' ? null : orig.call(this, t, o); };
    });
    await page.goto(DIST + '?debug=1');
    await page.waitForFunction(() => window.DMDS_GL && window.DMDS_GL.isReady(), { timeout: 60000 });
    const r = await page.evaluate(() => {
      const T = (fps, t) => window.DMDS_GL.debugGovTick(fps, t);
      const out = {};
      // transient drop: no suspect (no recent restore), no lock
      out.a = T(30, 100);                    // 42000 → 21000
      // restore (two goods), then drop soon after → SUSPECT, no lock
      T(60, 102); out.b = T(60, 104);        // → 42000, restoredAt=104
      out.c = T(30, 106);                    // → 21000, suspect=42000
      // restore again, drop again (same pair, within window) → LOCK
      T(60, 108); out.d = T(60, 110);        // → 42000
      out.e = T(30, 112);                    // → 21000, LOCKED
      return out;
    });
    check('lock:transient-no-lock', r.a.locked === false && r.a.suspect === null && r.a.drawCount === 21000, JSON.stringify(r.a));
    check('lock:first-reversal-suspect-only', r.c.locked === false && r.c.suspect === 42000, JSON.stringify(r.c));
    check('lock:same-pair-repeat-locks', r.e.locked === true && r.e.drawCount === 21000, JSON.stringify(r.e));
    await page.close();
  }
  {
    const page = await readyPage(browser, '');
    await page.addInitScript(() => {
      const orig = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (t, o) { return t === 'webgl2' ? null : orig.call(this, t, o); };
    });
    await page.goto(DIST + '?debug=1');
    await page.waitForFunction(() => window.DMDS_GL && window.DMDS_GL.isReady(), { timeout: 60000 });
    const r = await page.evaluate(async () => {
      const T = (fps, t) => window.DMDS_GL.debugGovTick(fps, t);
      const out = {};
      // suspicion decays: reversal, then a second one 60s later → still no lock
      T(30, 100); T(60, 102); T(60, 104); T(30, 106); // suspect=42000 @106
      T(60, 170); T(60, 172);                          // restore at t=172
      out.decayed = T(30, 174);                        // suspect expired → re-suspect, NO lock
      // now force the lock, then verify tab-revisit unlock semantics
      T(60, 176); T(60, 178); out.locked = T(30, 180); // same pair again → LOCK
      Object.defineProperty(document, 'hidden', { get: () => true, configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
      Object.defineProperty(document, 'hidden', { get: () => false, configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
      // the unlock just re-armed the LIVE governor too — on SwiftShader its
      // genuinely slow frames can tick between our deterministic ticks.
      // Stop the real loop (destroy keeps governor state; ticks are pure).
      window.DMDS_GL.destroy();
      // unlocked, but fresh evidence required: ONE good tick must not restore
      out.oneGood = T(60, 190);
      out.twoGood = T(60, 192); // second consecutive good → restore permitted
      return out;
    });
    check('lock:suspicion-decays-no-false-lock', r.decayed.locked === false, JSON.stringify(r.decayed));
    check('lock:locks-on-true-repeat', r.locked.locked === true);
    check('lock:resume-unlocks-without-promotion', r.oneGood.locked === false && r.oneGood.drawCount === 21000 && r.oneGood.good === 1, JSON.stringify(r.oneGood));
    check('lock:fresh-evidence-then-restores', r.twoGood.drawCount === 42000, JSON.stringify(r.twoGood));
    await page.close();
  }

  // ── 17b. visibility resume clears ALL oscillation evidence — the
  //        UNLOCKED branch: a pre-hide restoration credential (still
  //        inside its 12s window) must not mint a post-resume strike ──
  {
    const page = await readyPage(browser, '');
    await page.addInitScript(() => {
      const orig = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (t, o) { return t === 'webgl2' ? null : orig.call(this, t, o); };
    });
    await page.goto(DIST + '?debug=1');
    await page.waitForFunction(() => window.DMDS_GL && window.DMDS_GL.isReady(), { timeout: 60000 });
    const r = await page.evaluate(() => {
      const T = (fps, t) => window.DMDS_GL.debugGovTick(fps, t);
      const out = {};
      // establish a genuine restoration credential: drop, restore → 42000
      T(30, 100); T(60, 102); T(60, 104);               // restoredTo=42000 @104
      // hide → resume: lifecycle discontinuity, governor re-arms
      Object.defineProperty(document, 'hidden', { get: () => true, configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
      Object.defineProperty(document, 'hidden', { get: () => false, configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
      // NO destroy() here: the assertion must isolate the RESUME HANDLER
      // as the thing that cleared the credential — another lifecycle
      // function must not wander through the crime scene. This is safe:
      // dispatchEvent ran the handler synchronously, and the rAF it
      // requested cannot fire inside this synchronous evaluate task.
      // immediate post-resume drop: t=106 is inside the pre-hide window,
      // but the credential must be gone — drop normally, NO suspicion
      out.postResume = T(30, 106);
      // suspicion is earned only after the pair restores AGAIN post-resume
      T(60, 108); T(60, 110);                            // → 42000, fresh credential
      out.fresh = T(30, 112);
      return out;
    });
    check('lock:resume-clears-stale-restore-credential',
      r.postResume.locked === false && r.postResume.suspect === null && r.postResume.drawCount === 21000,
      JSON.stringify(r.postResume));
    check('lock:post-resume-suspicion-freshly-earned',
      r.fresh.locked === false && r.fresh.suspect === 42000,
      JSON.stringify(r.fresh));
    await page.close();
  }

  // ── 18. governor history ring records the trajectory ──
  {
    const page = await readyPage(browser, '?debug=1&gl2n=64&govoff=1');
    const r = await page.evaluate(([BAD, GOOD]) => {
      const E = window.DMDS_GL2;
      E.debugGovInject(BAD);
      E.debugGovInject(GOOD); E.debugGovInject(GOOD);
      const h = E.debugGovHistory();
      return {
        len: h.length,
        events: h.map(e => e.event),
        hasWindow: h.some(e => e.event === 'window' && typeof e.p90 === 'number'),
        hasRung: h.some(e => e.event === 'rung'),
      };
    }, [BAD, GOOD]);
    check('history:records-trajectory', r.len >= 4 && r.hasWindow && r.hasRung, JSON.stringify(r));
    await page.close();
  }

  // ── 19. oscillation lock: a DIFFERENT pair must not inherit suspicion ──
  {
    const page = await readyPage(browser, '');
    await page.addInitScript(() => {
      const orig = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (t, o) { return t === 'webgl2' ? null : orig.call(this, t, o); };
    });
    await page.goto(DIST + '?debug=1');
    await page.waitForFunction(() => window.DMDS_GL && window.DMDS_GL.isReady(), { timeout: 60000 });
    const r = await page.evaluate(() => {
      const T = (fps, t) => window.DMDS_GL.debugGovTick(fps, t);
      const out = {};
      // genuinely suspect the 42000↔21000 pair
      T(30, 100); T(60, 102); T(60, 104); T(30, 106);   // drop, restore→42000, drop: suspect=42000, at 21000
      // monotonic continuation 21000 → 10500: the only recent restore was
      // TO 42000 — a different pair's credential. It must NOT mint a
      // first strike for 21000↔10500 (that's plain degradation, not a cycle)
      out.forged = T(30, 108);
      // the new pair earns its own first strike: restore to 21000, drop
      T(60, 110); T(60, 112);                            // → 21000 (restoredTo=21000)
      out.firstStrike = T(30, 114);                      // suspect→21000, NOT locked
      // and locks only on its own SECOND complete cycle
      T(60, 116); T(60, 118);                            // → 21000 again
      out.lock = T(30, 120);
      return out;
    });
    check('lock:monotonic-degradation-mints-no-strike',
      r.forged.locked === false && r.forged.suspect === 42000 && r.forged.drawCount === 10500,
      JSON.stringify(r.forged));
    check('lock:new-pair-first-own-cycle-suspect-only',
      r.firstStrike.locked === false && r.firstStrike.suspect === 21000,
      JSON.stringify(r.firstStrike));
    check('lock:new-pair-locks-on-own-second-cycle',
      r.lock.locked === true && r.lock.drawCount === 10500,
      JSON.stringify(r.lock));
    await page.close();
  }

  // ── 20. history-ring semantics: order, cap+eviction, field fidelity,
  //        copy-not-reference, survival across a managed reinit ──
  {
    const page = await readyPage(browser, '?debug=1&gl2n=64&govoff=1');
    const r = await page.evaluate(async ([GOOD]) => {
      const E = window.DMDS_GL2;
      E.setFormation = function () {}; E.setMorphPair = function () {};
      // field fidelity + order on a known sequence
      E.debugGovInject(Array(70).fill(30));  // window(bad) + rung(1)
      const h1 = E.debugGovHistory();
      const winEntry = h1.find(e => e.event === 'window');
      const rungEntry = h1.find(e => e.event === 'rung');
      // copy-not-reference
      const stolen = E.debugGovHistory();
      stolen.length = 0;
      const stillThere = E.debugGovHistory().length;
      // entries must be clones too, not shared references
      const grab = E.debugGovHistory();
      grab[0].event = 'everything-was-fine';
      const entryTampered = E.debugGovHistory()[0].event === 'everything-was-fine';
      // cap + eviction: flood with action-free alternating windows
      for (let i = 0; i < 140; i++) {
        E.debugGovInject(Array(70).fill(i % 2 ? 10 : 20)); // good/hold alternation → no actions
      }
      const h2 = E.debugGovHistory();
      // order is proven by seq, not t: injections don't advance state.time,
      // so timestamps repeat — sequence must stay STRICTLY monotonic anyway
      let seqStrict = true, equalTDistinctSeq = false;
      for (let i = 1; i < h2.length; i++) {
        if (!(h2[i].seq > h2[i - 1].seq)) seqStrict = false;
        if (h2[i].t === h2[i - 1].t && h2[i].seq !== h2[i - 1].seq) equalTDistinctSeq = true;
      }
      const evictedOldest = !h2.some(e => e.event === 'rung'); // the early rung entry fell off
      // survival across a managed reinit (promotion resize)
      E.debugGovInject(Array(70).fill(10)); E.debugGovInject(Array(70).fill(10));
      E.debugGovInject(Array(70).fill(10)); E.debugGovInject(Array(70).fill(10));
      for (let i = 0; i < 40 && E.status().count !== 16384; i++) await new Promise(r2 => setTimeout(r2, 1000));
      const h3 = E.debugGovHistory();
      // seq continuity: if the counter reset across reinit, post-reinit
      // entries would break strict growth against the surviving ring
      let seqContinuous = true;
      for (let i = 1; i < h3.length; i++) if (!(h3[i].seq > h3[i - 1].seq)) seqContinuous = false;
      return {
        winOK: winEntry && winEntry.p90 === 30 && winEntry.action === 'bad',
        rungOK: rungEntry && rungEntry.to === 1,
        stillThere, entryTampered,
        capped: h2.length === 120, seqStrict, equalTDistinctSeq, evictedOldest,
        survivedReinit: E.status().count === 16384 && h3.some(e => e.event === 'resize-commit') && h3.some(e => e.event === 'window'),
        seqContinuous,
      };
    }, [GOOD]);
    check('history:window-fields-faithful', r.winOK === true);
    check('history:rung-fields-faithful', r.rungOK === true);
    check('history:returns-a-copy', r.stillThere > 0, 'len=' + r.stillThere);
    check('history:entries-are-clones-not-references', r.entryTampered === false);
    check('history:seq-strictly-monotonic-where-t-repeats', r.seqStrict && r.equalTDistinctSeq, JSON.stringify({ seqStrict: r.seqStrict, equalTDistinctSeq: r.equalTDistinctSeq }));
    check('history:caps-at-120-evicting-oldest', r.capped && r.evictedOldest, JSON.stringify({ capped: r.capped, evictedOldest: r.evictedOldest }));
    check('history:survives-managed-reinit', r.survivedReinit === true);
    check('history:seq-survives-reinit-uninterrupted', r.seqContinuous === true);
    await page.close();
  }

  // ── 22. rung-promotion two-strike lock (real-hardware finding: p90
  //        16.9–17.4ms at rung 2, 18–20ms at rung 1 → post effects
  //        flickered every ~30s forever) ──
  {
    const page = await readyPage(browser, '?debug=1&gl2n=64&govoff=1');
    const r = await page.evaluate(async ([BAD, GOOD]) => {
      const E = window.DMDS_GL2;
      E.setFormation = function () {}; E.setMorphPair = function () {};
      const HOLD = Array(70).fill(20); // 17.9–25ms hold band
      E.debugGovInject(BAD); E.debugGovInject(BAD);       // → rung 2
      // bounce 1: promote on 2 goods, sustained-hold degrades back
      E.debugGovInject(GOOD); E.debugGovInject(GOOD);     // → rung 1
      const afterPromo1 = E.debugGov().rung;
      E.debugGovInject(HOLD); E.debugGovInject(HOLD);     // → rung 2 (strike 1)
      const strike1 = E.debugGov();
      // bounce 2 → lock
      E.debugGovInject(GOOD); E.debugGovInject(GOOD);     // → rung 1
      E.debugGovInject(HOLD); E.debugGovInject(HOLD);     // → rung 2, LOCK
      const locked = E.debugGov();
      // good evidence must no longer re-promote the locked pair
      E.debugGovInject(GOOD); E.debugGovInject(GOOD);
      const afterGoodWhileLocked = E.debugGov().rung;
      // bad still degrades — the lock blocks promotions only
      E.debugGovInject(BAD);
      const afterBadWhileLocked = E.debugGov().rung;
      const hist = E.debugGovHistory();
      return { afterPromo1, strike1rung: strike1.rung, strike1lock: strike1.rungLockAt,
               lockAt: locked.rungLockAt, lockedRung: locked.rung,
               afterGoodWhileLocked, afterBadWhileLocked,
               lockLogged: hist.some(e => e.event === 'rung-lock' && e.at === 2) };
    }, [BAD, GOOD]);
    check('runglock:first-bounce-no-lock', r.afterPromo1 === 1 && r.strike1rung === 2 && r.strike1lock === 0, JSON.stringify(r));
    check('runglock:second-bounce-locks', r.lockAt === 2 && r.lockedRung === 2 && r.lockLogged, JSON.stringify(r));
    check('runglock:good-evidence-cannot-repromote', r.afterGoodWhileLocked === 2, 'rung=' + r.afterGoodWhileLocked);
    check('runglock:bad-still-degrades-while-locked', r.afterBadWhileLocked === 3, 'rung=' + r.afterBadWhileLocked);
    // a viewport change moves the fill-rate landscape → lock re-arms
    await page.setViewportSize({ width: 1100, height: 700 });
    await page.waitForTimeout(600);
    const cleared = await page.evaluate(() => window.DMDS_GL2.debugGov().rungLockAt);
    check('runglock:cleared-on-viewport-change', cleared === 0, 'lockAt=' + cleared);
    await page.close();
  }

  // ── 22b. strike attribution is CONTAMINATION-aware, not severity-
  //        gated: a CLEAN failure strikes at any severity (a rung that
  //        fails cleanly at 27ms must not void its own trial forever);
  //        an interacted window degrades but voids the trial ──
  {
    const page = await readyPage(browser, '?debug=1&gl2n=64&govoff=1');
    const r = await page.evaluate(async ([BAD, GOOD]) => {
      const E = window.DMDS_GL2;
      E.setFormation = function () {}; E.setMorphPair = function () {};
      const HOLD = Array(70).fill(20);
      E.debugGovInject(BAD); E.debugGovInject(BAD);     // → rung 2
      // clean severe bad after a promotion: STRIKE 1
      E.debugGovInject(GOOD); E.debugGovInject(GOOD);   // → rung 1 (trial)
      E.debugGovInject(BAD);                            // clean bad → strike 1
      const afterCleanBad = E.debugGov().rungLockAt;    // one strike ≠ lock
      // contaminated bad: degrades but VOIDS the trial (no strike 2)
      E.debugGovInject(GOOD); E.debugGovInject(GOOD);   // → rung 1
      E.debugGovInject(BAD, { interacting: true });     // → rung 2, voided
      const afterDirtyBad = E.debugGov().rungLockAt;
      // contaminated sustained-hold: voids too
      E.debugGovInject(GOOD); E.debugGovInject(GOOD);   // → rung 1
      E.debugGovInject(HOLD, { interacting: true });
      E.debugGovInject(HOLD, { interacting: true });    // → rung 2, voided
      const afterDirtyHold = E.debugGov().rungLockAt;
      // clean hold bounce: STRIKE 2 → LOCK (proves the clean bad counted)
      E.debugGovInject(GOOD); E.debugGovInject(GOOD);   // → rung 1
      E.debugGovInject(HOLD); E.debugGovInject(HOLD);   // → rung 2 → LOCK
      const locked = E.debugGov().rungLockAt;
      const intLogged = E.debugGovHistory().some(e => e.event === 'window' && e.int === true);
      return { afterCleanBad, afterDirtyBad, afterDirtyHold, locked, intLogged };
    }, [BAD, GOOD]);
    check('strike:clean-bad-counts-one-strike-no-lock', r.afterCleanBad === 0, 'lockAt=' + r.afterCleanBad);
    check('strike:contaminated-bad-voids-trial', r.afterDirtyBad === 0, 'lockAt=' + r.afterDirtyBad);
    check('strike:contaminated-hold-voids-trial', r.afterDirtyHold === 0, 'lockAt=' + r.afterDirtyHold);
    check('strike:second-clean-failure-locks', r.locked === 2, 'lockAt=' + r.locked);
    check('strike:contamination-recorded-in-history', r.intLogged === true);
    await page.close();
  }

  // ── 22f. contamination through the REAL collector: winDirty
  //        accumulates per frame while a grab is held, reaches
  //        govEvaluate at window rollover (int:true in history), and
  //        clears at the boundary — injection bypasses this path ──
  {
    const page = await readyPage(browser, '?debug=1&gl2n=64&govoff=1');
    await page.waitForTimeout(2500);
    const r = await page.evaluate(async () => {
      const E = window.DMDS_GL2;
      E.setFormation = function () {};
      // block the above-baseline promotion so good windows stay
      // action-free (no trial cooldown noise, no mid-test reinit)
      E.debugGovInject(null, { allocFail: 128 });
      // hold a REAL grab → state.grab.active true for the collector
      window.dispatchEvent(new PointerEvent('pointerdown', { clientX: 720, clientY: 396, button: 0, pointerType: 'mouse' }));
      await new Promise(r2 => setTimeout(r2, 800));
      // drive the PRODUCTION govFrame synchronously: warm-up, then enough
      // frames that at least one fully-populated valid window closes while
      // the grab is held (the first partial window is invalid by design)
      let t = 1000;
      for (let i = 0; i < 35; i++) { t += 0.016; E.debugGovFrame(16, t); }   // warm-up
      t += 3.1; // past fastUntil → standard 5s windows
      for (let i = 0; i < 160; i++) { t += 0.08; E.debugGovFrame(16, t); }
      const dirtyWin = E.debugGovHistory().filter(e => e.event === 'window').pop();
      const dirtyLen = E.debugGovHistory().length;
      // release, let excitement decay, then clean windows
      window.dispatchEvent(new PointerEvent('pointerup', { pointerType: 'mouse' }));
      for (let i = 0; i < 60 && E.status().excite >= 0.1; i++) await new Promise(r2 => setTimeout(r2, 500));
      const exciteLow = E.status().excite < 0.1;
      for (let i = 0; i < 160; i++) { t += 0.08; E.debugGovFrame(16, t); }
      const after = E.debugGovHistory().slice(dirtyLen).filter(e => e.event === 'window');
      const cleanWin = after.pop();
      return { dirtyWin, exciteLow, cleanWin };
    });
    check('collector:grab-contaminates-window', r.dirtyWin && r.dirtyWin.int === true, JSON.stringify(r.dirtyWin));
    check('collector:contamination-clears-at-boundary', r.exciteLow && r.cleanWin && r.cleanWin.int !== true, JSON.stringify(r.cleanWin));
    await page.close();
  }

  // ── 22e. degradation SKIPS a poisoned intermediate size and lands on
  //        the deeper viable one (512 → 256 when 384 is alloc-failed) ──
  {
    const page = await readyPage(browser, '?debug=1&govoff=1'); // default ladder, 512² baseline
    const r = await page.evaluate(async ([BAD]) => {
      const E = window.DMDS_GL2;
      E.setFormation = function () {}; E.setMorphPair = function () {};
      E.debugGovInject(null, { allocFail: 384 });
      E.debugGovInject(BAD); E.debugGovInject(BAD); E.debugGovInject(BAD); // rungs 1..3
      E.debugGovInject(BAD);                    // request: must target 256, skipping 384
      const pending = E.debugGov().pending;
      E.debugGovInject(BAD);                    // sustained bad → force
      let applied = null;
      for (let i = 0; i < 60; i++) {
        await new Promise(r2 => setTimeout(r2, 500));
        if (E.status().count === 65536) { applied = 65536; break; }
      }
      const hist = E.debugGovHistory();
      return { pending, applied,
               never384: !hist.some(e => (e.event === 'resize-request' || e.event === 'resize-commit') && e.to === 384),
               commit256: hist.some(e => e.event === 'resize-commit' && e.to === 256) };
    }, [BAD]);
    check('skip:request-targets-deeper-viable-size', r.pending && r.pending.idx === 0 && r.pending.dir === 'degrade', JSON.stringify(r.pending));
    check('skip:poisoned-384-never-requested-or-committed', r.never384 === true);
    check('skip:commits-512-to-256-directly', r.applied === 65536 && r.commit256 === true, 'count=' + (r.applied || 'never'));
    await page.close();
  }

  // ── 22c. degradation never retries an alloc-failed size: the size axis
  //        is exhausted past poisoned targets, descent continues ──
  {
    const page = await readyPage(browser, '?debug=1&gl2n=64&govoff=1');
    const r = await page.evaluate(async ([BAD]) => {
      const E = window.DMDS_GL2;
      E.setFormation = function () {}; E.setMorphPair = function () {};
      let demoteCalled = 0;
      E.onDemote(() => demoteCalled++);
      E.debugGovInject(null, { allocFail: 32 });          // the only lower size is poisoned
      E.debugGovInject(BAD); E.debugGovInject(BAD); E.debugGovInject(BAD); // rungs 1..3
      E.debugGovInject(BAD);                              // size axis exhausted → post off
      const afterExhausted = E.debugGov();
      E.debugGovInject(BAD);                              // → demote (still at baseline n)
      const hist = E.debugGovHistory();
      return {
        rung: afterExhausted.rung, post: afterExhausted.post, demoteCalled,
        noRequest: !hist.some(e => e.event === 'resize-request'),
        demoteEntry: hist.filter(e => e.event === 'demote')[0],
      };
    }, [BAD]);
    check('allocskip:exhausted-axis-goes-post-off', r.rung === 5 && r.post === false, JSON.stringify({ rung: r.rung, post: r.post }));
    check('allocskip:poisoned-size-never-requested', r.noRequest === true);
    check('allocskip:demotes-at-baseline', r.demoteCalled >= 1 && r.demoteEntry && r.demoteEntry.n === 64, JSON.stringify(r.demoteEntry));
    await page.close();
  }

  // ── 22d. forced resize during an ACTIVE GRAB: released through the
  //        standard path, no stuck clump survives the rebuilt engine ──
  {
    const page = await readyPage(browser, '?debug=1&gl2n=64&govoff=1');
    await page.waitForTimeout(2500); // excitement decay before grabbing
    const r = await page.evaluate(async ([BAD]) => {
      const E = window.DMDS_GL2;
      E.setFormation = function () {};
      const grabCount = () => {
        const s = E.debugReadState();
        let n = 0;
        for (let i = 0; i < s.velocities.length / 4; i++) if (s.velocities[i * 4 + 3] === 1) n++;
        return n;
      };
      window.dispatchEvent(new PointerEvent('pointerdown', { clientX: 720, clientY: 396, button: 0, pointerType: 'mouse' }));
      await new Promise(r2 => setTimeout(r2, 800)); // live frames apply the capture
      const heldBefore = grabCount();
      const releasesBefore = E.debugGov().grabReleases;
      // ladder to a forced downsize while the grab is HELD
      E.debugGovInject(BAD); E.debugGovInject(BAD); E.debugGovInject(BAD);
      E.debugGovInject(BAD);                        // request floor
      E.debugGovInject(BAD);                        // sustained bad → force
      let applied = null;
      for (let i = 0; i < 40; i++) {
        await new Promise(r2 => setTimeout(r2, 250));
        if (E.status().count === 1024) { applied = 1024; break; }
      }
      const heldAfter = grabCount();
      // CAUSALITY: the standard release path ran exactly once (effective
      // releases are counted only when a grab was actually active — a
      // reinit merely clearing GPU flags would not move this counter)
      const releasesAfter = E.debugGov().grabReleases;
      // post-reinit pointer traffic must be coherent (no stuck capture);
      // this pointerup hits an inactive grab and must NOT count a release
      window.dispatchEvent(new PointerEvent('pointermove', { clientX: 700, clientY: 380, pointerType: 'mouse' }));
      window.dispatchEvent(new PointerEvent('pointerup', { pointerType: 'mouse' }));
      await new Promise(r2 => setTimeout(r2, 400));
      const releasesAfterUp = E.debugGov().grabReleases;
      // a FRESH grab must work on the rebuilt engine
      window.dispatchEvent(new PointerEvent('pointerdown', { clientX: 720, clientY: 396, button: 0, pointerType: 'mouse' }));
      await new Promise(r2 => setTimeout(r2, 800));
      const heldAgain = grabCount();
      window.dispatchEvent(new PointerEvent('pointerup', { pointerType: 'mouse' }));
      return { heldBefore, applied, heldAfter, releasesBefore, releasesAfter, releasesAfterUp, heldAgain };
    }, [BAD]);
    check('forcegrab:grab-held-before-resize', r.heldBefore > 0, 'held=' + r.heldBefore);
    check('forcegrab:resize-applies-during-grab', r.applied === 1024, 'count=' + (r.applied || 'never'));
    check('forcegrab:no-stuck-clump-after-reinit', r.heldAfter === 0, 'held=' + r.heldAfter);
    check('forcegrab:released-via-standard-path-exactly-once',
      r.releasesAfter === r.releasesBefore + 1 && r.releasesAfterUp === r.releasesAfter,
      JSON.stringify({ before: r.releasesBefore, after: r.releasesAfter, afterUp: r.releasesAfterUp }));
    check('forcegrab:fresh-grab-works-after-reinit', r.heldAgain > 0, 'held=' + r.heldAgain);
    check('forcegrab:no-page-errors', page.errs.length === 0, page.errs.join('; '));
    await page.close();
  }

  // ── 23. sustained bad forces a starved idle-deferred downsize (real-
  //        hardware finding: a continuously-interacted machine demoted
  //        from 512² having never actually run a smaller size) ──
  {
    const page = await readyPage(browser, '?debug=1&gl2n=64&govoff=1');
    const r = await page.evaluate(async ([BAD]) => {
      const E = window.DMDS_GL2;
      E.setFormation = function () {}; // stop choreography; keep real setMorphPair
      // hold the field permanently non-idle: scrub-park a morph at mix 0.5
      E.setMorphPair('logo', 'device', 0.5);
      E.debugGovInject(BAD); E.debugGovInject(BAD); E.debugGovInject(BAD); // rungs 1..3
      E.debugGovInject(BAD);                                              // request floor size
      // an UNFORCED pending must starve while the field is non-idle
      await new Promise(r2 => setTimeout(r2, 3000));
      const starved = { count: E.status().count, pending: E.debugGov().pending, mix: E.status().mix };
      E.debugGovInject(BAD);                                              // sustained bad → force
      let executed = null;
      for (let i = 0; i < 40; i++) {
        await new Promise(r2 => setTimeout(r2, 250));
        if (E.status().count === 1024) { executed = 1024; break; }
      }
      // DURESS POLICY (explicit, tested): a mid-morph forced resize
      // reseeds at the CURRENT formation side and completes normally —
      // formation defined, mix reaches 1, no limbo state
      let settledFormation = null;
      for (let i = 0; i < 40; i++) {
        await new Promise(r2 => setTimeout(r2, 500));
        const s = E.status();
        if (s.mix === 1) { settledFormation = s.formation; break; }
      }
      // the abandoned size carries a PERF rejection (expiring), not a
      // hard alloc failure — and tab revisit clears it
      const marks = { perf: E.debugGov().perfRejected, alloc: E.debugGov().allocFailed };
      Object.defineProperty(document, 'hidden', { get: () => true, configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
      Object.defineProperty(document, 'hidden', { get: () => false, configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
      const marksAfterRevisit = E.debugGov().perfRejected;
      return { starved, executed, marks, marksAfterRevisit, settledFormation };
    }, [BAD]);
    check('force:unforced-pending-starves-while-non-idle',
      r.starved.count === 4096 && r.starved.pending && r.starved.pending.idx === 0 && !r.starved.pending.forced && r.starved.mix === 0.5,
      JSON.stringify(r.starved));
    check('force:sustained-bad-overrides-idle-deferral', r.executed === 1024, 'count=' + (r.executed || 'never'));
    check('force:duress-is-perf-rejection-not-alloc',
      r.marks.perf.indexOf('64') >= 0 && r.marks.alloc.length === 0, JSON.stringify(r.marks));
    check('force:perf-rejection-clears-on-revisit', r.marksAfterRevisit.length === 0, JSON.stringify(r.marksAfterRevisit));
    check('force:mid-morph-duress-policy-defined',
      r.settledFormation === 'device', 'formation=' + r.settledFormation);
    await page.close();
  }

  // ── 23b. duress side-selection RULE (not one handpicked point):
  //        mix < 0.5 reseeds at the SOURCE formation; the 0.5 tie goes
  //        to the destination (23 above). Fling velocities are
  //        structurally discarded — velT is recreated null-backed
  //        (zero-initialized per WebGL2 spec) at reinit ──
  {
    const page = await readyPage(browser, '?debug=1&gl2n=64&govoff=1');
    const r = await page.evaluate(async ([BAD]) => {
      const E = window.DMDS_GL2;
      E.setFormation = function () {};
      E.setMorphPair('logo', 'device', 0.25);              // source side
      E.debugGovInject(BAD); E.debugGovInject(BAD); E.debugGovInject(BAD);
      E.debugGovInject(BAD); E.debugGovInject(BAD);        // request + force
      let settled = null;
      for (let i = 0; i < 40; i++) {
        await new Promise(r2 => setTimeout(r2, 500));
        const s = E.status();
        if (s.count === 1024 && s.mix === 1) { settled = s.formation; break; }
      }
      return { settled };
    }, [BAD]);
    check('force:mix-below-half-reseeds-at-source', r.settled === 'logo', 'formation=' + r.settled);
    await page.close();
  }

  // ── 21. ?telemetry=1 differential: measured evidence for "zero behavior
  //        change" — identical production config at ready-instant, read
  //        paths open, write/instrument paths closed, live governor armed ──
  {
    const snapAtReady = async (query) => {
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      await page.goto(DIST + query);
      // snapshot in the same frame isReady first reads true — before the
      // governor can have taken any size/DPR action (warm-up + cooldowns
      // put those tens of seconds away)
      const snap = await page.evaluate(() => new Promise(res => {
        (function poll() {
          const E = window.DMDS_GL2;
          if (E && E.isReady()) {
            const s = E.status();
            const c = document.querySelector('canvas');
            res({ count: s.count, baseline: s.baseline, ceiling: s.ceiling,
                  degraded: s.degraded, sleeping: s.sleeping, cw: c.width, ch: c.height });
          } else requestAnimationFrame(poll);
        })();
      }));
      const gates = await page.evaluate(() => {
        const E = window.DMDS_GL2;
        const probe = (name, args) => { try { E[name].apply(null, args || []); return 'open'; } catch (e) { return 'closed'; } };
        return {
          gov: probe('debugGov'), hist: probe('debugGovHistory'),
          step: probe('debugStep', [1, 1 / 60]), poke: probe('debugPoke', [0, 0, 0, 0]),
          inject: probe('debugGovInject', [[10]]), readback: probe('debugReadState', [1]),
          liveOff: (() => { try { return E.debugGov().liveOff; } catch (e) { return 'n/a'; } })(),
        };
      });
      await page.close();
      return { snap, gates };
    };
    const plain = await snapAtReady('');
    const telem = await snapAtReady('?telemetry=1');
    const g1 = plain.gates, g2 = telem.gates;
    check('telemetry:config-identical-to-production',
      JSON.stringify(plain.snap) === JSON.stringify(telem.snap),
      JSON.stringify({ plain: plain.snap, telem: telem.snap }));
    check('telemetry:plain-page-fully-gated',
      g1.gov === 'closed' && g1.hist === 'closed' && g1.step === 'closed'
      && g1.poke === 'closed' && g1.inject === 'closed' && g1.readback === 'closed',
      JSON.stringify(g1));
    check('telemetry:read-paths-open', g2.gov === 'open' && g2.hist === 'open', JSON.stringify(g2));
    check('telemetry:write-and-instrument-paths-closed',
      g2.step === 'closed' && g2.poke === 'closed' && g2.inject === 'closed' && g2.readback === 'closed',
      JSON.stringify(g2));
    check('telemetry:live-governor-armed', g2.liveOff === false, String(g2.liveOff));
  }

  await browser.close();
  const pass = results.every(r => r.ok);
  results.forEach(r => console.log((r.ok ? '  ok  ' : '  FAIL'), r.name, r.detail));
  console.log(pass ? 'M4 GOVERNOR: PASS (' + results.length + ' checks)' : 'M4 GOVERNOR: FAIL');
  process.exit(pass ? 0 : 1);
})().catch(e => { console.error('M4 RUN FAILED', e); process.exit(2); });
