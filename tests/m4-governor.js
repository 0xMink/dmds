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
  const page = await browser.newPage(Object.assign({ viewport: { width: 1440, height: 900 } }, opts || {}));
  page.errs = [];
  page.on('pageerror', e => page.errs.push(String(e)));
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
      for (let i = 0; i < 8; i++) {
        E.debugGovInject(BAD);
        seq.push(snap());
      }
      return { seq, demoteCalled, degradedFlag: E.status().degraded };
    }, [BAD]);
    const s = r.seq;
    check('gov:ladder-rungs-first', s[0].rung === 1 && s[1].rung === 2 && s[2].rung === 3, JSON.stringify(s.slice(0, 3)));
    check('gov:ladder-then-size-steps', (s[3].pending && s[3].pending.idx === 0 && s[3].pending.dir === 'degrade') || s[3].sizeIdx === 0, JSON.stringify(s[3]));
    // size is idle-deferred: further bad windows while a resize is pending
    // must not stack extra actions past the ladder's intent
    check('gov:ladder-post-off-at-floor', s.some(x => x.post === false), JSON.stringify(s));
    check('gov:ladder-ends-in-demotion', r.demoteCalled >= 1, 'demote calls=' + r.demoteCalled);
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
      // sleep may only be claimed over a PHYSICALLY settled field
      const conv = E.debugConvergence(0.05, 0.1);
      sf('grid', 0.2); // a real command must wake it
      await new Promise(r2 => setTimeout(r2, 500));
      const awake = E.status();
      const reslept = await waitSleep();
      return {
        slept: { running: slept.running, sleeping: slept.sleeping, excite: slept.excite },
        conv: { nearOut: conv.nearOut, bad: conv.bad, count: conv.count },
        awake: { running: awake.running, formation: awake.formation },
        reslept: { running: reslept.running, sleeping: reslept.sleeping },
      };
    });
    check('rm:stops-after-settle', r.slept.running === false && r.slept.sleeping === true, JSON.stringify(r.slept));
    check('rm:sleep-is-physically-settled', r.conv.nearOut === 0 && r.conv.bad === 0, JSON.stringify(r.conv));
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
    const page = await readyPage(browser, '?debug=1&gl2n=64&govoff=1');
    const r = await page.evaluate(async ([GOOD]) => {
      const E = window.DMDS_GL2;
      E.setFormation = function () {}; E.setMorphPair = function () {};
      window.__DMDS_GL2_BREAK_N__ = [128]; // the promotion target will fail to build
      E.debugGovInject(GOOD); E.debugGovInject(GOOD); // queue promotion
      for (let i = 0; i < 40 && !E.debugGov().trialFailed.length; i++) {
        await new Promise(r2 => setTimeout(r2, 1000));
      }
      window.__DMDS_GL2_BREAK_N__ = null;
      await new Promise(r2 => setTimeout(r2, 1500));
      const g = E.debugGov();
      const s = E.status();
      return { count: s.count, running: s.running, tier: s.tier, trialFailed: g.trialFailed, demoted: g.demoted, sizeIdx: g.sizeIdx };
    }, [GOOD]);
    check('txn:failed-promotion-rolls-back', r.count === 4096 && r.running === true && r.tier === 'gl2' && r.sizeIdx === 1, JSON.stringify(r));
    check('txn:failed-size-marked', r.trialFailed.indexOf('128') > -1, JSON.stringify(r.trialFailed));
    check('txn:no-demotion-on-rollback', r.demoted === false);
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
      // downsize queued (three rungs first, the FOURTH bad queues size),
      // then recovery → downsize cancels
      E.debugGovInject(BAD); E.debugGovInject(BAD); E.debugGovInject(BAD); E.debugGovInject(BAD);
      const queuedDown = (E.debugGov().pending || {}).dir;
      E.debugGovInject(GOOD); E.debugGovInject(GOOD);
      const afterRecover = E.debugGov();
      // give idle machinery a chance — nothing may execute
      await new Promise(r2 => setTimeout(r2, 8000));
      const finalCount = E.status().count;
      return { queuedPromo, promoCancelled: afterBad.pending === null, rungAfterBad: afterBad.rung,
               queuedDown, downCancelled: afterRecover.pending === null, finalCount };
    }, [BAD, GOOD]);
    check('stale:promotion-queued', r.queuedPromo === 'promote');
    check('stale:bad-window-cancels-promotion', r.promoCancelled === true && r.rungAfterBad === 0, JSON.stringify(r));
    check('stale:downsize-queued', r.queuedDown === 'degrade', r.queuedDown);
    check('stale:recovery-cancels-downsize', r.downCancelled === true);
    check('stale:no-spurious-resize', r.finalCount === 4096, 'count=' + r.finalCount);
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
      E.debugGovInject(BAD); E.debugGovInject(BAD); E.debugGovInject(BAD); await wait();
      const g5 = E.debugGov(); // pending size at floor + eventually post off
      // recover fully
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

  await browser.close();
  const pass = results.every(r => r.ok);
  results.forEach(r => console.log((r.ok ? '  ok  ' : '  FAIL'), r.name, r.detail));
  console.log(pass ? 'M4 GOVERNOR: PASS (' + results.length + ' checks)' : 'M4 GOVERNOR: FAIL');
  process.exit(pass ? 0 : 1);
})().catch(e => { console.error('M4 RUN FAILED', e); process.exit(2); });
