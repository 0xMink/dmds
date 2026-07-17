const { chromium } = require('playwright-core');
(async () => {
  const browser = await chromium.launch({
    executablePath: '/root/.cache/ms-playwright/chromium_headless_shell-1228/chrome-headless-shell-linux64/chrome-headless-shell',
    args: ['--no-sandbox', '--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
  });
  const page = await browser.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(String(e)));
  await page.goto('file://' + __dirname + '/m0-probe.html');
  await page.waitForFunction(() => window.M0, { timeout: 15000 });
  const m0 = await page.evaluate(() => window.M0);
  console.log(JSON.stringify(m0, null, 2));
  if (errs.length) { console.log('PAGE ERRORS:'); errs.forEach(e => console.log(e)); }
  await browser.close();
  process.exit(m0.pass ? 0 : 1);
})().catch(e => { console.error('M0 RUN FAILED', e); process.exit(2); });
