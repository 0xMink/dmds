/* M5 verification — DMDS/OS terminal, slice 1: shell lifecycle,
   keyboard precedence router, a11y contract, command truthfulness
   (help/status/boot/build/clear/exit), context-level unavailable
   states (?debug=1 seam), REAL no-WebGL integration, reduced motion,
   forced colors, mobile viewports, no-JS absence.
   Run: node tests/m5-terminal.js  (headless SwiftShader) */
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

// SwiftShader saturates the main thread (~1 fps); queued tasks (e.g. the
// dialog's close event) can lag far past any fixed timeout — poll, never
// wall-clock-wait, for state that arrives via the task queue.
async function poll(page, fn, arg, timeout) {
  await page.waitForFunction(fn, arg, { timeout: timeout || 30000 });
}

async function readyPage(browser, query, opts) {
  const page = await browser.newPage(Object.assign({ viewport: { width: 1440, height: 900 } }, opts || {}));
  page.errs = [];
  page.on('pageerror', e => page.errs.push(String(e)));
  await page.goto(DIST + (query || ''));
  await page.waitForFunction(() => document.documentElement.classList.contains('loaded'), { timeout: 120000 });
  return page;
}

(async () => {
  const browser = await chromium.launch({
    executablePath: resolveChromium(),
    args: ['--no-sandbox', '--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
  });

  // ── 1. production page: API surface + markup contract ──
  {
    const page = await readyPage(browser);
    const api = await page.evaluate(() => ({
      type: typeof window.DMDS_TERM,
      fns: window.DMDS_TERM ? ['open', 'close', 'exec'].map(f => typeof window.DMDS_TERM[f]) : [],
      bridgeConsumed: typeof window.DMDS_TERM._connect,
      noDebugSeam: typeof window.DMDS_TERM.debugSetContext,
      toggleHidden: document.getElementById('term-toggle').hidden,
      ariaExpanded: document.getElementById('term-toggle').getAttribute('aria-expanded'),
      ariaControls: document.getElementById('term-toggle').getAttribute('aria-controls'),
      dlgLabel: document.getElementById('term').getAttribute('aria-label'),
      outRole: document.getElementById('term-out').getAttribute('role'),
      inputLabel: document.getElementById('term-in').getAttribute('aria-label'),
      open: document.getElementById('term').open,
    }));
    check('api:object', api.type === 'object');
    check('api:functions', api.fns.every(t => t === 'function'), api.fns.join(','));
    check('api:bridge-consumed', api.bridgeConsumed === 'undefined', '_connect=' + api.bridgeConsumed);
    check('api:no-mutation-channel-in-prod', api.noDebugSeam === 'undefined', 'debugSetContext=' + api.noDebugSeam);
    check('markup:toggle-revealed', api.toggleHidden === false, 'hidden=' + api.toggleHidden);
    check('markup:aria-expanded-false', api.ariaExpanded === 'false');
    check('markup:aria-controls', api.ariaControls === 'term');
    check('markup:dialog-labelled', api.dlgLabel === 'DMDS/OS terminal');
    check('markup:output-role-log', api.outRole === 'log');
    check('markup:input-labelled', !!api.inputLabel);
    check('markup:closed-at-boot', api.open === false);

    // ── 2. exec truthfulness (against the REAL wired context) ──
    const ex = await page.evaluate(() => {
      const help = window.DMDS_TERM.exec('help');
      const status = window.DMDS_TERM.exec('status');
      const boot = window.DMDS_TERM.exec('boot');
      const build = window.DMDS_TERM.exec('build');
      const bad = window.DMDS_TERM.exec('warpdrive');
      const empty = window.DMDS_TERM.exec('   ');
      const s = (window.DMDS_GL2 && window.DMDS_GL2.status) ? window.DMDS_GL2.status() : null;
      return {
        help, status, boot, build, bad, empty,
        engineCount: s ? s.count : null,
        engineTier: s ? s.tier : null,
        bootlog: (window.DMDS_BOOTLOG || []).slice(),
        stamp: document.querySelector('meta[name="dmds-build"]').content,
      };
    });
    const helpText = ex.help.join('\n');
    check('exec:help-lists-all', ['help', 'status', 'boot', 'build', 'clear', 'exit'].every(c => helpText.includes(c)), helpText);
    // every command row's description column starts at the same index
    const descCols = ex.help.slice(1, 7).map(l => {
      const m = l.match(/^ {2}(\S+)( +)/);
      return m ? 2 + m[1].length + m[2].length : -1;
    });
    check('exec:help-aligned-all-rows', descCols.every(c => c > 0 && c === descCols[0]), JSON.stringify(descCols));
    check('exec:status-tier-truthful', ex.engineTier === 'gl2' ? ex.status[0].includes('TIER 1') : ex.status[0].includes('TIER 2') || ex.status[0].includes('STATIC'), ex.status[0]);
    check('exec:status-count-matches-engine', ex.engineCount === null || ex.status.join(' ').includes(ex.engineCount.toLocaleString('en-US')), ex.status[1]);
    check('exec:boot-equals-buffer', JSON.stringify(ex.boot) === JSON.stringify(ex.bootlog.length ? ex.bootlog : ['boot log empty']), JSON.stringify(ex.boot));
    check('exec:boot-has-seed-line', ex.boot.some(l => /SEED particles/.test(l)), JSON.stringify(ex.boot));
    check('exec:build-carries-stamp', ex.build[0].includes(ex.stamp), ex.build[0] + ' vs ' + ex.stamp);
    check('exec:build-names-attestation', ex.build.join(' ').includes('attestation'), '');
    check('exec:unknown-honest', ex.bad.length === 1 && /^unknown command: warpdrive/.test(ex.bad[0]), JSON.stringify(ex.bad));
    check('exec:empty-line-silent', Array.isArray(ex.empty) && ex.empty.length === 0);

    // ── 3. keyboard precedence router ──
    // open path: bare backtick over the page
    await page.keyboard.press('`');
    await poll(page, () => document.getElementById('term').open === true);
    check('kbd:backtick-opens', true);
    const focusIn = await page.evaluate(() => document.activeElement === document.getElementById('term-in'));
    check('a11y:initial-focus-input', focusIn);
    await poll(page, () => document.getElementById('term-toggle').getAttribute('aria-expanded') === 'true');
    check('a11y:aria-expanded-syncs-open', true);

    // guard 3 via the terminal's own input: backtick types literally
    await page.keyboard.press('`');
    const literal = await page.evaluate(() => ({
      v: document.getElementById('term-in').value,
      open: document.getElementById('term').open,
    }));
    check('kbd:backtick-literal-in-terminal', literal.v === '`' && literal.open === true, JSON.stringify(literal));
    await page.evaluate(() => { document.getElementById('term-in').value = ''; });

    // typed command through the real input reaches the real scrollback
    await page.type('#term-in', 'status');
    await page.keyboard.press('Enter');
    await poll(page, () => {
      const out = document.getElementById('term-out');
      return out && /FORMATION|STATIC|TIER/.test(out.textContent);
    });
    check('shell:typed-command-executes', true);
    const echoed = await page.evaluate(() => document.getElementById('term-out').textContent.includes('dmds://$ status'));
    check('shell:command-echoed', echoed);

    await page.keyboard.press('ArrowUp');
    check('shell:history-up', await page.evaluate(() => document.getElementById('term-in').value === 'status'));
    await page.evaluate(() => { document.getElementById('term-in').value = ''; });

    await page.type('#term-in', 'bu');
    await page.keyboard.press('Tab');
    check('shell:tab-completes', await page.evaluate(() => document.getElementById('term-in').value === 'build'));
    await page.evaluate(() => { document.getElementById('term-in').value = ''; });

    await page.type('#term-in', 'clear');
    await page.keyboard.press('Enter');
    await poll(page, () => document.getElementById('term-out').textContent === '');
    check('shell:clear-empties', true);

    // in-dialog CLOSE button — the reachable pointer path while modal
    // (showModal makes the page inert, so the nav toggle is a launcher)
    await page.click('#term-close');
    await poll(page, () => document.getElementById('term').open === false);
    check('shell:close-button-closes', true);
    await poll(page, () => document.getElementById('term-toggle').getAttribute('aria-expanded') === 'false');
    check('a11y:aria-expanded-syncs-close', true);

    // exit command closes
    await page.evaluate(() => window.DMDS_TERM.open());
    await poll(page, () => document.getElementById('term').open === true);
    await page.type('#term-in', 'exit');
    await page.keyboard.press('Enter');
    await poll(page, () => document.getElementById('term').open === false);
    check('shell:exit-closes', true);

    // Escape closes + focus returns to the opener (toggle-launch path)
    await page.evaluate(() => { document.getElementById('term-toggle').focus(); });
    await page.click('#term-toggle');
    await poll(page, () => document.getElementById('term').open === true);
    check('shell:toggle-launches', true);
    await page.keyboard.press('Escape');
    await poll(page, () => document.getElementById('term').open === false);
    check('kbd:escape-closes', true);
    await poll(page, () => document.activeElement === document.getElementById('term-toggle'));
    check('a11y:focus-restored-to-opener', true);

    // guard 1 — IME composition. NOTE: synthetic dispatch (KeyboardEventInit
    // isComposing) exercises the router's guard branch; it is not a real IME
    // session (headless has no input method) — labeled accordingly.
    await page.evaluate(() => {
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: '`', isComposing: true, bubbles: true, cancelable: true }));
    });
    check('kbd:guard-ime-synthetic', await page.evaluate(() => document.getElementById('term').open === false));

    // guard 3 — form field focused: backtick stays literal, no open
    await page.evaluate(() => { document.querySelector('#transmit input[name="name"]').focus(); });
    await page.keyboard.press('`');
    let g = await page.evaluate(() => {
      const el = document.querySelector('#transmit input[name="name"]');
      return { open: document.getElementById('term').open, v: el.value };
    });
    check('kbd:guard-form-field', g.open === false && g.v === '`', JSON.stringify(g));
    await page.evaluate(() => {
      const el = document.querySelector('#transmit input[name="name"]');
      el.value = ''; el.blur();
    });

    // guard 2 — modifier held
    await page.keyboard.down('Control');
    await page.keyboard.press('`');
    await page.keyboard.up('Control');
    check('kbd:guard-modifier', await page.evaluate(() => document.getElementById('term').open === false));

    // guard 3 — link focused
    await page.evaluate(() => { document.querySelector('.nav__links a').focus(); });
    await page.keyboard.press('`');
    check('kbd:guard-link-focus', await page.evaluate(() => document.getElementById('term').open === false));
    await page.evaluate(() => document.activeElement.blur());

    // guard 4 — non-backtick keys never touch the router
    await page.keyboard.press('a');
    check('kbd:guard-other-keys', await page.evaluate(() => document.getElementById('term').open === false));

    // scrollback survives close/reopen (clear is the only eraser)
    await page.evaluate(() => window.DMDS_TERM.open());
    await poll(page, () => document.getElementById('term').open === true);
    check('shell:scrollback-persists', await page.evaluate(() => document.getElementById('term-out').textContent.length > 0));
    await page.evaluate(() => window.DMDS_TERM.close());

    check('page:no-exceptions', page.errs.length === 0, page.errs.join(' | '));
    await page.close();
  }

  // ── 4. context-level unavailable states (?debug=1 seam — these verify
  //       output for supplied contexts, not engine-selection integration;
  //       section 5 covers the real path) ──
  {
    const page = await readyPage(browser, '?debug=1');
    const seam = await page.evaluate(() => typeof window.DMDS_TERM.debugSetContext);
    check('context:debug-seam-present', seam === 'function', seam);
    const staticOut = await page.evaluate(() => {
      window.DMDS_TERM.debugSetContext({ gl: null, fps: null });
      return window.DMDS_TERM.exec('status');
    });
    check('context:static-honest', staticOut.length === 1 && /STATIC · CONTENT NOMINAL/.test(staticOut[0]), JSON.stringify(staticOut));
    const tier2Out = await page.evaluate(() => {
      // real tier-2 module handle — same status() the footer reads post-demotion
      window.DMDS_TERM.debugSetContext({ gl: function () { return window.DMDS_GL; } });
      return window.DMDS_TERM.exec('status');
    });
    check('context:tier2-honest', /TIER 2/.test(tier2Out[0]) && tier2Out.join(' ').includes('OF 42,000'), JSON.stringify(tier2Out));
    await page.close();
  }

  // ── 5. REAL static-tier integration: WebGL genuinely unavailable ──
  {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.errs = [];
    page.on('pageerror', e => page.errs.push(String(e)));
    await page.addInitScript(() => {
      const orig = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (t, o) {
        return (t === 'webgl2' || t === 'webgl') ? null : orig.call(this, t, o);
      };
    });
    await page.goto(DIST);
    await page.waitForFunction(() => document.documentElement.classList.contains('loaded'), { timeout: 120000 });
    const r = await page.evaluate(() => ({
      status: window.DMDS_TERM.exec('status'),
      boot: window.DMDS_TERM.exec('boot'),
      toggleUsable: !document.getElementById('term-toggle').hidden,
    }));
    check('integration:real-static-status', r.status.length === 1 && /STATIC · CONTENT NOMINAL/.test(r.status[0]), JSON.stringify(r.status));
    check('integration:real-static-boot-honest', r.boot.some(l => /FALLBACK static field/.test(l)), JSON.stringify(r.boot));
    check('integration:terminal-survives-no-gl', r.toggleUsable && page.errs.length === 0, page.errs.join(' | '));
    // the one-shot bridge must be consumed on EVERY boot outcome —
    // static fallback included, or the "no mutation channel" claim lies
    check('integration:static-bridge-consumed', await page.evaluate(() => typeof window.DMDS_TERM._connect === 'undefined'));
    await page.close();
  }

  // ── 5b. REAL tier-2 integration: WebGL2 unavailable, WebGL1 boots ──
  {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.errs = [];
    page.on('pageerror', e => page.errs.push(String(e)));
    await page.addInitScript(() => {
      const orig = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (t, o) {
        return t === 'webgl2' ? null : orig.call(this, t, o);
      };
    });
    await page.goto(DIST);
    await page.waitForFunction(() => document.documentElement.classList.contains('loaded'), { timeout: 120000 });
    await page.waitForFunction(() => window.DMDS_GL && window.DMDS_GL.isReady && window.DMDS_GL.isReady(), { timeout: 60000 });
    const t2 = await page.evaluate(() => ({
      status: window.DMDS_TERM.exec('status'),
      bridge: typeof window.DMDS_TERM._connect,
    }));
    check('integration:real-tier2-status', /TIER 2 · WEBGL1/.test(t2.status[0]) && /RUNNING/.test(t2.status[0]), JSON.stringify(t2.status));
    check('integration:real-tier2-count-live', t2.status.join(' ').includes('42,000'), t2.status[1]);
    check('integration:tier2-bridge-consumed', t2.bridge === 'undefined', t2.bridge);
    await page.close();
  }

  // ── 6. reduced motion: functional AND actually unanimated ──
  {
    const page = await readyPage(browser, '', { reducedMotion: 'reduce' });
    await page.keyboard.press('`');
    await poll(page, () => document.getElementById('term').open === true);
    const rm = await page.evaluate(() => {
      const cs = getComputedStyle(document.getElementById('term'));
      return {
        lines: window.DMDS_TERM.exec('status').length,
        transition: cs.transitionDuration,
        animation: cs.animationName,
      };
    });
    check('rm:opens-and-reads', rm.lines > 0);
    check('rm:no-transition', rm.transition === '0s', rm.transition);
    check('rm:no-animation', rm.animation === 'none', rm.animation);
    check('rm:no-exceptions', page.errs.length === 0, page.errs.join(' | '));
    await page.close();
  }

  // ── 7. forced colors: panel boundary + focus indicator stay visible ──
  {
    const page = await readyPage(browser, '', { forcedColors: 'active' });
    await page.keyboard.press('`');
    await poll(page, () => document.getElementById('term').open === true);
    // produce an error line so error text is also under test
    await page.type('#term-in', 'nope');
    await page.keyboard.press('Enter');
    await poll(page, () => document.querySelector('#term-out .t-err') !== null);
    const fc = await page.evaluate(() => {
      const dlgEl = document.getElementById('term');
      const dlg = getComputedStyle(dlgEl);
      const input = document.getElementById('term-in');
      input.focus();
      const ics = getComputedStyle(input);
      const vis = sel => {
        const el = document.querySelector(sel);
        const cs = getComputedStyle(el);
        return cs.color !== dlg.backgroundColor && cs.display !== 'none' && cs.visibility !== 'hidden';
      };
      return {
        borderTop: dlg.borderTopWidth + ' ' + dlg.borderTopStyle,
        outlineStyle: ics.outlineStyle,
        outlineWidth: ics.outlineWidth,
        closeVisible: vis('#term-close'),
        promptVisible: vis('.term__prompt'),
        errVisible: vis('#term-out .t-err'),
        outVisible: vis('#term-out'),
      };
    });
    check('fc:panel-boundary', fc.borderTop === '1px solid', fc.borderTop);
    check('fc:focus-visible-indicator', fc.outlineStyle !== 'none' && parseFloat(fc.outlineWidth) >= 1, JSON.stringify(fc));
    check('fc:close-button-visible', fc.closeVisible);
    check('fc:prompt-visible', fc.promptVisible);
    check('fc:error-text-visible', fc.errVisible);
    check('fc:output-visible', fc.outVisible);
    await page.close();
  }

  // ── 8. mobile viewports: the terminal has a DOOR on phones — the TRM
  //       launcher stays visible ≤560 (soft keyboards have no backtick),
  //       opens by real touch tap, panel fits, no overflow.
  //       NOTE: env(safe-area-inset-*) is 0 in headless emulation — the
  //       padding check verifies base padding only; device-inset behavior
  //       is a real-phone item.
  for (const vp of [{ width: 320, height: 568 }, { width: 375, height: 667 }, { width: 667, height: 375 }]) {
    const page = await readyPage(browser, '', { viewport: vp, hasTouch: true });
    const tag = vp.width + 'x' + vp.height;
    const pre = await page.evaluate(() => {
      const toggle = document.getElementById('term-toggle');
      const r = toggle.getBoundingClientRect();
      return { display: getComputedStyle(toggle).display, h: r.height, w: r.width };
    });
    check('mobile:' + tag + ':launcher-visible', pre.display !== 'none', pre.display);
    if (vp.width <= 560) check('mobile:' + tag + ':launcher-tap-target', pre.h >= 40 && pre.w >= 40, 'h=' + pre.h.toFixed(1) + ' w=' + pre.w.toFixed(1));
    await page.tap('#term-toggle');
    await poll(page, () => document.getElementById('term').open === true);
    check('mobile:' + tag + ':tap-opens', true);
    const m = await page.evaluate(() => {
      const dlg = document.getElementById('term');
      const cs = getComputedStyle(dlg);
      return {
        panelW: dlg.getBoundingClientRect().width,
        innerW: window.innerWidth,
        scrollW: document.documentElement.scrollWidth,
        padBottom: parseFloat(cs.paddingBottom),
        inputVisible: document.getElementById('term-in').getBoundingClientRect().bottom <= window.innerHeight,
        inputFont: parseFloat(getComputedStyle(document.getElementById('term-in')).fontSize),
      };
    });
    check('mobile:' + tag + ':opens-full-width', Math.abs(m.panelW - m.innerW) <= 1, 'panel=' + m.panelW + ' inner=' + m.innerW);
    check('mobile:' + tag + ':no-horizontal-overflow', m.scrollW <= m.innerW + 1, 'scrollW=' + m.scrollW);
    check('mobile:' + tag + ':input-on-screen-base-pad', m.inputVisible && m.padBottom >= 22, 'padBottom=' + m.padBottom);
    check('mobile:' + tag + ':input-no-ios-zoom', m.inputFont >= 16, 'font=' + m.inputFont);
    await page.close();
  }

  // ── 9. no-JS: no dead control, no dialog, content unaffected ──
  {
    const ctx2 = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 1440, height: 900 } });
    const page = await ctx2.newPage();
    await page.goto(DIST);
    await page.waitForTimeout(1500);
    const nojs = await page.evaluate(() => ({
      toggleHidden: document.getElementById('term-toggle').hidden,
      open: document.getElementById('term').open,
      contactVisible: !!document.querySelector('#contact'),
    }));
    check('nojs:toggle-stays-hidden', nojs.toggleHidden === true);
    check('nojs:dialog-closed', nojs.open === false);
    check('nojs:content-unaffected', nojs.contactVisible);
    await ctx2.close();
  }

  await browser.close();
  const pass = results.every(r => r.ok);
  results.forEach(r => console.log((r.ok ? '  ok  ' : '  FAIL'), r.name, r.detail));
  console.log(pass ? 'M5 TERMINAL: PASS (' + results.length + ' checks)' : 'M5 TERMINAL: FAIL');
  process.exit(pass ? 0 : 1);
})().catch(e => { console.error('M5 RUN FAILED', e); process.exit(2); });
