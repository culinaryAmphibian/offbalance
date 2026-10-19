const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const root = process.env.BROWSER_ARTIFACTS || require('node:path').join(require('node:os').tmpdir(), 'offbalance-browser');
const done = [];
const errors = [];
async function check(name, fn) { await fn(); done.push(name); console.log('PASS', name); }
(async () => {
  await fs.mkdir(root, {recursive:true});
  const browser = await chromium.launch({ ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}), headless:true, args:['--no-sandbox'] });
  try {
    const context = await browser.newContext({ viewport:{width:1280,height:960}, acceptDownloads:true });
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    page.on('pageerror', e => errors.push(e.message));
    await check('demo sign-in, buyer/provider navigation and overview', async () => {
      await page.goto('http://127.0.0.1:5173');
      await page.getByRole('button',{name:'Enter demo'}).click();
      await page.getByRole('heading',{name:'Overview',exact:true}).waitFor();
      await page.getByRole('link',{name:'Matrix computation'}).waitFor();
      await page.screenshot({path:`${root}/overview.png`,fullPage:true});
      await page.getByRole('button',{name:'Provider',exact:true}).click();
      await page.getByRole('heading',{name:'Assigned jobs'}).waitFor();
      assert.equal(await page.getByRole('link',{name:'Submit job',exact:true}).count(),0);
      await page.getByRole('button',{name:'Buyer',exact:true}).click();
    });
    await check('validation, hardware disclosure and successful job creation', async () => {
      await page.getByRole('link',{name:'Submit job',exact:true}).click();
      await page.getByRole('button',{name:'Save job',exact:true}).click();
      await page.getByText('Enter a job name.',{exact:true}).waitFor();
      await page.getByLabel('Job name',{exact:true}).fill('Browser workload');
      await page.getByLabel('Container image',{exact:true}).fill('ghcr.io/team/workload:latest');
      await page.getByLabel('Hourly cap per provider (ETH)',{exact:true}).fill('0.005');
      assert.equal(await page.getByLabel('Container image',{exact:true}).getAttribute('placeholder'),null);
      assert.equal(await page.getByLabel('Execution window (minutes)',{exact:true}).inputValue(),'60');
      await page.getByLabel('Execution window (minutes)',{exact:true}).fill('10');
      await page.getByLabel('Required matching results',{exact:true}).fill('4');
      await page.getByRole('button',{name:'Save job',exact:true}).click();
      await page.getByText('Agreement cannot exceed the provider count.',{exact:true}).waitFor();
      await page.getByLabel('Required matching results',{exact:true}).fill('2');
      await page.getByText('Minimum hardware scores',{exact:true}).click();
      await page.getByLabel('CPU score',{exact:true}).fill('100');
      await page.screenshot({path:`${root}/submit-desktop.png`,fullPage:true});
      await page.getByRole('button',{name:'Save job',exact:true}).click();
      await page.getByRole('heading',{name:'Browser workload',exact:true}).waitFor();
      await page.getByText('Job saved.',{exact:true}).waitFor();
      await page.getByText('10 minutes',{exact:true}).waitFor();
      assert.equal(await page.getByRole('button',{name:'Download result'}).count(),0);
      await page.getByRole('link',{name:'← Overview',exact:true}).click();
      await page.getByRole('link',{name:'Browser workload',exact:true}).waitFor();
    });
    await check('provider delivery metadata and browser history', async () => {
      await page.getByRole('link',{name:'Matrix computation',exact:true}).click();
      await page.getByRole('button',{name:'Load delivery records',exact:true}).click();
      await page.getByRole('link',{name:'Open provider output',exact:true}).waitFor();
      await page.getByText('Verified on chain',{exact:true}).waitFor();
      assert.equal(await page.getByRole('link',{name:'Open provider output',exact:true}).getAttribute('href'),'https://example.com/offbalance-demo-output');
      assert.equal(await page.getByRole('button',{name:'Download result',exact:true}).count(),0);
      await page.screenshot({path:`${root}/details-desktop.png`,fullPage:true});
      await page.goBack();
      await page.getByRole('heading',{name:'Overview',exact:true}).waitFor();
      await page.goForward();
      await page.getByRole('heading',{name:'Matrix computation',exact:true}).waitFor();
    });
    await check('320px/375px layouts do not overflow; mobile form remains usable', async () => {
      for (const width of [320,375]) {
        await page.setViewportSize({width,height:900});
        assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth > window.innerWidth),false);
        await page.getByRole('link',{name:'← Overview',exact:true}).click();
        await page.getByRole('link',{name:'Submit job',exact:true}).click();
        await page.getByLabel('Job name',{exact:true}).fill('Mobile workload');
        await page.getByLabel('Container image',{exact:true}).fill('ghcr.io/team/mobile:latest');
        await page.getByLabel('Hourly cap per provider (ETH)',{exact:true}).fill('0.01');
        assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth > window.innerWidth),false);
        await page.screenshot({path:`${root}/submit-${width}.png`,fullPage:true});
        await page.getByRole('link',{name:'Cancel',exact:true}).click();
        assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth > window.innerWidth),false);
        await page.getByRole('link',{name:'Matrix computation',exact:true}).click();
        await page.getByRole('heading',{name:'Matrix computation',exact:true}).waitFor();
      }
    });
    await page.getByRole('button',{name:'Sign out',exact:true}).click();
    await page.getByRole('button',{name:'Enter demo',exact:true}).waitFor();
    await context.close();

    await check('USD quotes expire before first submission and refresh restores submission',async()=>{
      const currencyContext=await browser.newContext();
      const currencyPage=await currencyContext.newPage();
      currencyPage.setDefaultTimeout(10000);
      currencyPage.on('pageerror',error=>errors.push(error.message));
      await currencyPage.clock.install({time:new Date('2026-10-18T12:00:00Z')});
      await currencyPage.route('https://api.coinbase.com/v2/prices/ETH-USD/spot',route=>route.fulfill({contentType:'application/json',body:JSON.stringify({data:{base:'ETH',currency:'USD',amount:'2500'}})}));
      await currencyPage.goto('http://127.0.0.1:5173');
      await currencyPage.getByRole('button',{name:'Enter demo',exact:true}).click();
      await currencyPage.getByRole('link',{name:'Submit job',exact:true}).click();
      await currencyPage.getByLabel('Job name',{exact:true}).fill('USD expiry fixture');
      await currencyPage.getByLabel('Container image',{exact:true}).fill('example/workload:latest');
      await currencyPage.getByLabel('Hourly cap currency',{exact:true}).selectOption('USD');
      await currencyPage.getByLabel('Hourly cap per provider (USD)',{exact:true}).fill('25');
      await currencyPage.getByText(/≈ 0\.01 ETH/).waitFor();
      assert.ok(!(await currencyPage.locator('#budget-conversion').innerText()).includes('$$'));
      // Move wall time without firing the expiry timer: submit must recheck the clock.
      await currencyPage.clock.setFixedTime(new Date(await currencyPage.evaluate(()=>Date.now())+60001));
      await currencyPage.getByRole('button',{name:'Save job',exact:true}).click();
      await currencyPage.getByText('Refresh the ETH/USD rate to continue.',{exact:true}).waitFor();
      await currencyPage.getByText(/Rate expired/).waitFor();
      await currencyPage.getByRole('button',{name:'Refresh rate',exact:true}).click();
      await currencyPage.getByText(/Rate expired/).waitFor({state:'hidden'});
      await currencyPage.getByText(/≈ 0\.01 ETH/).waitFor();
      await currencyPage.getByRole('button',{name:'Save job',exact:true}).click();
      await currencyPage.getByRole('heading',{name:'USD expiry fixture',exact:true}).waitFor();
      await currencyPage.getByText('60 minutes',{exact:true}).waitFor();
      await currencyContext.close();
    });
    assert.deepEqual(errors,[]);
    console.log(JSON.stringify({checks:done.length,pageErrors:errors,screenshots:root},null,2));
  } finally { await browser.close(); }
})().catch(error=>{console.error(error);process.exitCode=1});
