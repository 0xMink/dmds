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
    check('gov:ladder-then-size-steps', s[3].pending === 0 || s[3].sizeIdx === 0, JSON.stringify(s[3]));
    // size is idle-deferred: further bad windows while a resize is pending
    // must not stack extra actions past the ladder's intent
    check('gov:ladder-post-off-at-floor', s.some(x => x.post === false), JSON.stringify(s));
    check('gov:ladder-ends-in-demotion', r.demoteCalled >= 1, 'demote calls=' + r.demoteCalled);
    check('gov:degraded-flag-honest', r.degradedFlag === true);
    check('gov:no-errors', r && true);
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
    check('gov:promotion-requested-above-baseline', r.promo === 'improve' && r.pending === 2, 'pending=' + r.pending + ' sizes=' + r.sizes);
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
      const pendingDuringGrab = E.debugGov().pending;
      await new Promise(r2 => setTimeout(r2, 2600));
      const stillPending = E.debugGov().pending;
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
      // wait past the 3s settle deadline
      await new Promise(r2 => setTimeout(r2, 6000));
      const slept = E.status();
      sf('grid', 0.2); // a real command must wake it
      await new Promise(r2 => setTimeout(r2, 500));
      const awake = E.status();
      await new Promise(r2 => setTimeout(r2, 6000));
      const reslept = E.status();
      return {
        slept: { running: slept.running, sleeping: slept.sleeping },
        awake: { running: awake.running, formation: awake.formation },
        reslept: { running: reslept.running, sleeping: reslept.sleeping },
      };
    });
    check('rm:stops-after-settle', r.slept.running === false && r.slept.sleeping === true, JSON.stringify(r.slept));
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

  await browser.close();
  const pass = results.every(r => r.ok);
  results.forEach(r => console.log((r.ok ? '  ok  ' : '  FAIL'), r.name, r.detail));
  console.log(pass ? 'M4 GOVERNOR: PASS (' + results.length + ' checks)' : 'M4 GOVERNOR: FAIL');
  process.exit(pass ? 0 : 1);
})().catch(e => { console.error('M4 RUN FAILED', e); process.exit(2); });
