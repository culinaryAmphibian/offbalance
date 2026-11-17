// Accessibility of every page in the demo app (no backend needed):
//   - axe-core's WCAG 2.1 A/AA rules on each page: serious and critical violations fail the run;
//     moderate and minor ones are listed
//   - keyboard-only use: the app can be entered, every job-form control is reachable with Tab in
//     order, the focused control is visibly marked, and Enter submits the form
//
//   npm run dev:demo -- --port 5173 --strictPort    (in another terminal)
//   npm run test:a11y                               (BROWSER=firefox|webkit for other engines)
const assert = require('node:assert/strict');
const engine = require(process.env.PLAYWRIGHT_MODULE || 'playwright')[process.env.BROWSER || 'chromium'];
const sandboxArgs = (process.env.BROWSER || 'chromium') === 'chromium' ? ['--no-sandbox'] : [];
const AXE = require.resolve('axe-core/axe.min.js');
const BASE = process.env.DEMO_URL || 'http://127.0.0.1:5173';
const BLOCKING = new Set(['serious', 'critical']);

(async () => {
  const browser = await engine.launch({ headless: true, args: sandboxArgs });
  const blocking = [];
  try {
    const page = await (await browser.newContext({ viewport: { width: 1280, height: 960 } })).newPage();
    page.setDefaultTimeout(10000);

    async function audit(name) {
      await page.addScriptTag({ path: AXE });
      const { violations } = await page.evaluate(() => window.axe.run(document, {
        runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] },
      }));
      for (const v of violations) {
        const where = v.nodes.slice(0, 3).map(n => n.target.join(' ')).join(', ');
        const line = `${name}: [${v.impact}] ${v.id}: ${v.help} (${v.nodes.length}x, e.g. ${where})`;
        if (BLOCKING.has(v.impact)) blocking.push(line);
        console.log(BLOCKING.has(v.impact) ? `FAIL ${line}` : `note ${line}`);
      }
      if (!violations.length) console.log(`PASS ${name}: no WCAG A/AA violations`);
    }

    // ───────────── axe on every page ─────────────
    await page.goto(BASE);
    await page.getByRole('button', { name: 'Enter demo' }).waitFor();
    await audit('sign-in page');
    await page.getByRole('button', { name: 'Enter demo' }).click();
    await page.getByRole('heading', { name: 'Overview', exact: true }).waitFor();
    await audit('overview (buyer)');
    await page.getByRole('link', { name: 'Matrix computation' }).click();
    await page.getByRole('heading', { level: 1 }).waitFor();
    await audit('job details');
    await page.evaluate(() => { window.location.hash = '#/jobs/new'; });
    await page.getByRole('heading', { name: 'Save a job' }).waitFor();
    await audit('job form');
    await page.getByRole('button', { name: 'Save job' }).click(); // the form with its errors showing
    await page.locator('[aria-invalid="true"]').first().waitFor();
    await audit('job form with validation errors');
    await page.evaluate(() => { window.location.hash = '#/'; });
    await page.getByRole('button', { name: 'Provider', exact: true }).click();
    await page.getByRole('heading', { name: 'Assigned jobs' }).waitFor();
    await audit('overview (provider)');
    await page.evaluate(() => { window.location.hash = '#/provider'; });
    await page.getByRole('heading', { name: 'Provider setup' }).waitFor();
    await audit('provider setup');
    await page.evaluate(() => { window.location.hash = '#/nowhere'; });
    await page.waitForTimeout(300);
    await audit('not found');

    // ───────────── keyboard only ─────────────
    const focused = () => page.evaluate(() => {
      const el = document.activeElement;
      const style = getComputedStyle(el);
      const visible = (style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0) || style.boxShadow !== 'none';
      return { id: el.id, tag: el.tagName, text: (el.textContent || '').trim().slice(0, 40), visible };
    });

    await page.goto(BASE);
    await page.getByRole('button', { name: 'Enter demo' }).waitFor();
    let entered = false;
    for (let i = 0; i < 15 && !entered; i++) {
      await page.keyboard.press('Tab');
      const now = await focused();
      if (now.text === 'Enter demo') {
        assert.ok(now.visible, 'the focused "Enter demo" button has a visible focus indicator');
        await page.keyboard.press('Enter');
        entered = true;
      }
    }
    assert.ok(entered, '"Enter demo" can be reached with Tab');
    await page.getByRole('heading', { name: 'Overview', exact: true }).waitFor();
    console.log('PASS keyboard: the app can be entered with Tab and Enter, with a visible focus indicator');

    await page.evaluate(() => { window.location.hash = '#/jobs/new'; });
    await page.getByRole('heading', { name: 'Save a job' }).waitFor();
    const controls = await page.locator('form.job-form input:visible, form.job-form select:visible').evaluateAll(els => els.map(e => e.id));
    await page.locator('#name').focus();
    const order = ['name'];
    for (let i = 0; i < 40 && order.length < controls.length; i++) {
      await page.keyboard.press('Tab');
      const now = await focused();
      if (controls.includes(now.id) && !order.includes(now.id)) {
        assert.ok(now.visible, `#${now.id} has a visible focus indicator`);
        order.push(now.id);
      }
    }
    assert.deepEqual(order, controls, 'Tab visits every job-form control, in page order');
    console.log(`PASS keyboard: Tab reaches all ${controls.length} job-form controls in order`);

    await page.locator('#name').focus();
    await page.keyboard.press('Enter');
    await page.locator('[aria-invalid="true"]').first().waitFor();
    const afterEnter = await focused();
    assert.equal(afterEnter.id, 'name', 'Enter submits, and focus moves to the first invalid field');
    console.log('PASS keyboard: Enter submits the job form and focus moves to the first error');

    assert.deepEqual(blocking, [], `serious or critical accessibility violations:\n${blocking.join('\n')}`);
    console.log('accessibility checks passed');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
})();
