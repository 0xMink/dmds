/* M5 verification — DMDS/OS terminal, slice 1: shell lifecycle,
   keyboard precedence router (all six paths), a11y contract, command
   truthfulness (help/status/boot/build/clear/exit), unavailable
   states, no-JS absence.
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

  // ── 1. API surface + markup contract ──
  {
    const page = await readyPage(browser);
    const api = await page.evaluate(() => ({
      type: typeof window.DMDS_TERM,
      fns: window.DMDS_TERM ? ['open', 'close', 'exec', 'setContext'].map(f => typeof window.DMDS_TERM[f]) : [],
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
    check('markup:toggle-revealed', api.toggleHidden === false, 'hidden=' + api.toggleHidden);
    check('markup:aria-expanded-false', api.ariaExpanded === 'false');
    check('markup:aria-controls', api.ariaControls === 'term');
    check('markup:dialog-labelled', api.dlgLabel === 'DMDS/OS terminal');
    check('markup:output-role-log', api.outRole === 'log');
    check('markup:input-labelled', !!api.inputLabel);
    check('markup:closed-at-boot', api.open === false);

    // ── 2. exec truthfulness (pure surface, no DOM needed) ──
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
    check('exec:status-tier-truthful', ex.engineTier === 'gl2' ? ex.status[0].includes('TIER 1') : ex.status[0].includes('TIER 2') || ex.status[0].includes('STATIC'), ex.status[0]);
    check('exec:status-count-matches-engine', ex.engineCount === null || ex.status.join(' ').includes(ex.engineCount.toLocaleString('en-US')), ex.status[1]);
    check('exec:boot-equals-buffer', JSON.stringify(ex.boot) === JSON.stringify(ex.bootlog.length ? ex.bootlog : ['boot log empty']), JSON.stringify(ex.boot));
    check('exec:boot-has-seed-line', ex.boot.some(l => /SEED particles/.test(l)), JSON.stringify(ex.boot));
    check('exec:build-carries-stamp', ex.build[0].includes(ex.stamp), ex.build[0] + ' vs ' + ex.stamp);
    check('exec:build-names-attestation', ex.build.join(' ').includes('attestation'), '');
    check('exec:unknown-honest', ex.bad.length === 1 && /^unknown command: warpdrive/.test(ex.bad[0]), JSON.stringify(ex.bad));
    check('exec:empty-line-silent', Array.isArray(ex.empty) && ex.empty.length === 0);

    // ── 3. unavailable states: the real static-tier path via the real setter ──
    const staticOut = await page.evaluate(() => {
      window.DMDS_TERM.setContext({ gl: null, fps: null });
      const s = window.DMDS_TERM.exec('status');
      return s;
    });
    check('exec:static-tier-honest', staticOut.length === 1 && /STATIC · CONTENT NOMINAL/.test(staticOut[0]), JSON.stringify(staticOut));
    const tier2Out = await page.evaluate(() => {
      // real tier-2 handle: gl.js is loaded (fallback module) — its status()
      // is the same object the footer would read after a demotion
      window.DMDS_TERM.setContext({ gl: function () { return window.DMDS_GL; } });
      return window.DMDS_TERM.exec('status');
    });
    check('exec:tier2-honest', /TIER 2/.test(tier2Out[0]) && tier2Out.join(' ').includes('OF 42,000'), JSON.stringify(tier2Out));
    await page.evaluate(() => {
      // restore the live tier-1 accessor for the remaining checks
      window.DMDS_TERM.setContext({ gl: function () { return window.DMDS_GL2; } });
    });

    // ── 4. keyboard precedence router: all six paths ──
    // path 5: bare backtick over the page opens
    await page.keyboard.press('`');
    await poll(page, () => document.getElementById('term').open === true);
    check('kbd:backtick-opens', true);
    const focusIn = await page.evaluate(() => document.activeElement === document.getElementById('term-in'));
    check('a11y:initial-focus-input', focusIn);
    await poll(page, () => document.getElementById('term-toggle').getAttribute('aria-expanded') === 'true');
    check('a11y:aria-expanded-syncs-open', true);

    // path 3 (terminal's own input is a form control): backtick types literally
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

    // history: ArrowUp restores the last command
    await page.keyboard.press('ArrowUp');
    check('shell:history-up', await page.evaluate(() => document.getElementById('term-in').value === 'status'));
    await page.evaluate(() => { document.getElementById('term-in').value = ''; });

    // tab completion
    await page.type('#term-in', 'bu');
    await page.keyboard.press('Tab');
    check('shell:tab-completes', await page.evaluate(() => document.getElementById('term-in').value === 'build'));
    await page.evaluate(() => { document.getElementById('term-in').value = ''; });

    // clear empties the scrollback
    await page.type('#term-in', 'clear');
    await page.keyboard.press('Enter');
    await poll(page, () => document.getElementById('term-out').textContent === '');
    check('shell:clear-empties', true);

    // exit closes via the command path
    await page.type('#term-in', 'exit');
    await page.keyboard.press('Enter');
    await poll(page, () => document.getElementById('term').open === false);
    check('shell:exit-closes', true);
    await poll(page, () => document.getElementById('term-toggle').getAttribute('aria-expanded') === 'false');
    check('a11y:aria-expanded-syncs-close', true);

    // Escape closes + focus returns to the opener (toggle-button open path)
    await page.evaluate(() => { document.getElementById('term-toggle').focus(); });
    await page.click('#term-toggle');
    await poll(page, () => document.getElementById('term').open === true);
    check('shell:toggle-opens', true);
    await page.keyboard.press('Escape');
    await poll(page, () => document.getElementById('term').open === false);
    check('kbd:escape-closes', true);
    await poll(page, () => document.activeElement === document.getElementById('term-toggle'));
    check('a11y:focus-restored-to-opener', true);

    // path 1/2/3/4 guards: none of these may open the terminal
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

    await page.keyboard.down('Control');
    await page.keyboard.press('`');
    await page.keyboard.up('Control');
    check('kbd:guard-modifier', await page.evaluate(() => document.getElementById('term').open === false));

    await page.evaluate(() => { document.querySelector('.nav__links a').focus(); });
    await page.keyboard.press('`');
    check('kbd:guard-link-focus', await page.evaluate(() => document.getElementById('term').open === false));
    await page.evaluate(() => document.activeElement.blur());

    await page.keyboard.press('a'); // path 4: non-backtick keys never touch the router
    check('kbd:guard-other-keys', await page.evaluate(() => document.getElementById('term').open === false));

    // scrollback survives close/reopen (clear is the only eraser)
    await page.evaluate(() => window.DMDS_TERM.open());
    await poll(page, () => document.getElementById('term').open === true);
    check('shell:scrollback-persists', await page.evaluate(() => document.getElementById('term-out').textContent.length > 0));
    await page.evaluate(() => window.DMDS_TERM.close());

    check('page:no-exceptions', page.errs.length === 0, page.errs.join(' | '));
    await page.close();
  }

  // ── 5. reduced motion: terminal fully functional ──
  {
    const page = await readyPage(browser, '', { reducedMotion: 'reduce' });
    await page.keyboard.press('`');
    await poll(page, () => document.getElementById('term').open === true);
    const lines = await page.evaluate(() => window.DMDS_TERM.exec('status'));
    check('rm:opens-and-reads', lines.length > 0, JSON.stringify(lines[0]));
    check('rm:no-exceptions', page.errs.length === 0, page.errs.join(' | '));
    await page.close();
  }

  // ── 6. no-JS: no dead control, no dialog, content unaffected ──
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
