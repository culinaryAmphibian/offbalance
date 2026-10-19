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
      await page.getByRole('button',{name:'Submit job',exact:true}).click();
      await page.getByText('Enter a job name.',{exact:true}).waitFor();
      await page.getByLabel('Job name',{exact:true}).fill('Browser workload');
      await page.getByLabel('Container image',{exact:true}).fill('ghcr.io/team/workload:latest');
      await page.getByLabel('Maximum budget (ETH)',{exact:true}).fill('0.005');
      await page.getByLabel('Required matching results',{exact:true}).fill('4');
      await page.getByRole('button',{name:'Submit job',exact:true}).click();
      await page.getByText('Agreement cannot exceed the provider count.',{exact:true}).waitFor();
      await page.getByLabel('Required matching results',{exact:true}).fill('2');
      await page.getByText('Minimum hardware scores',{exact:true}).click();
      await page.getByLabel('CPU score',{exact:true}).fill('100');
      await page.screenshot({path:`${root}/submit-desktop.png`,fullPage:true});
      await page.getByRole('button',{name:'Submit job',exact:true}).click();
      await page.getByRole('heading',{name:'Browser workload',exact:true}).waitFor();
      await page.getByText('Job submitted.',{exact:true}).waitFor();
      assert.equal(await page.getByRole('button',{name:'Download result'}).count(),0);
      await page.getByRole('link',{name:'← Overview',exact:true}).click();
      await page.getByRole('link',{name:'Browser workload',exact:true}).waitFor();
    });
    await check('completed result download and browser history', async () => {
      await page.getByRole('link',{name:'Matrix computation',exact:true}).click();
      await page.getByRole('button',{name:'Download result',exact:true}).waitFor();
      await page.screenshot({path:`${root}/details-desktop.png`,fullPage:true});
      const downloadPromise=page.waitForEvent('download');
      await page.getByRole('button',{name:'Download result',exact:true}).click();
      const download=await downloadPromise;
      assert.equal(download.suggestedFilename(),'matrix-result.json');
      const body=JSON.parse(await fs.readFile(await download.path(),'utf8'));
      assert.deepEqual(body.matrix,[[1,0],[0,1]]);
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
        await page.getByLabel('Maximum budget (ETH)',{exact:true}).fill('0.01');
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

    const apiContext=await browser.newContext({viewport:{width:1280,height:960},acceptDownloads:true});
    await apiContext.addInitScript(()=>{
      const listeners={};
      window.walletCalls=[];
      window.walletReject=false;
      const wallet='0x71C0000000000000000000000000000000009A2F';
      window.ethereum={
        request:async ({method,params})=>{
          window.walletCalls.push({method,params});
          if(window.walletReject && method==='personal_sign') throw {code:4001,message:'declined'};
          if(method==='eth_requestAccounts') { listeners.accountsChanged?.forEach(fn=>fn([wallet])); return [wallet]; }
          if(method==='eth_accounts')return [wallet];
          if(method==='eth_chainId')return '0x1';
          if(method==='personal_sign')return '0xtest-signature';
          throw new Error('unexpected RPC '+method);
        },
        on:(event,fn)=>(listeners[event]??=[]).push(fn),
        removeListener:(event,fn)=>{listeners[event]=(listeners[event]||[]).filter(item=>item!==fn)},
      };
      window.walletEmit=(event,data)=>listeners[event]?.forEach(fn=>fn(data));
    });
    const apiPage=await apiContext.newPage();
    apiPage.setDefaultTimeout(10000);
    apiPage.on('pageerror',e=>errors.push(e.message));
    let job={id:'api-job',name:'API workload',status:'RUNNING',createdAt:new Date().toISOString(),dockerImage:'ghcr.io/team/workload:latest',maxPrice:'0.005',k:3,quorum:2,window:3600,providerCount:3};
    let failSubmission=false;
    let expire=false;
    let listFail=false;
    const submitted=[];
    const routes=[];
    await apiPage.route('**/api/**',async route=>{
      const request=route.request();
      const url=new URL(request.url());
      routes.push({path:url.pathname,headers:request.headers()});
      const json=(body,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
      if(url.pathname==='/api/auth/nonce')return json({nonce:'abc123456789',issuedAt:new Date().toISOString()});
      if(url.pathname==='/api/auth/verify') {
        const {message,signature}=request.postDataJSON();
        assert.ok(message.startsWith('127.0.0.1:5174 wants you to sign in'));
        assert.ok(message.includes('Chain ID: 1'));
        assert.equal(signature,'0xtest-signature');
        return json({token:'test-token',expiresAt:new Date(Date.now()+600000).toISOString(),account:{id:'account',wallet:'0x71C0000000000000000000000000000000009A2F'}});
      }
      assert.equal(request.headers().authorization,'Bearer test-token');
      if(expire)return json({message:'Expired'},401);
      if(url.pathname==='/api/jobs' && request.method()==='POST') {
        submitted.push({body:request.postDataJSON(),key:request.headers()['idempotency-key']});
        if(failSubmission)return json({message:'Submission unavailable. Try again.'},503);
        job={...job,...request.postDataJSON(),status:'PENDING'};
        return json({job},201);
      }
      if(url.pathname==='/api/jobs') {
        if(listFail)return json({message:'Could not load jobs.'},503);
        return json({jobs:url.searchParams.get('view')==='provider'?[]:[job],summary:{activeJobs:1,completedJobs:0,totalSpent:'0',totalEarned:'0'}});
      }
      if(url.pathname==='/api/jobs/api-job/result')return route.fulfill({contentType:'text/plain',body:'verified artifact'});
      if(url.pathname==='/api/jobs/api-job')return json({job});
      throw new Error('unexpected API '+request.url());
    });
    await check('wallet rejection leaves the user signed out',async()=>{
      await apiPage.goto('http://127.0.0.1:5174');
      await apiPage.evaluate(()=>window.walletReject=true);
      await apiPage.getByRole('button',{name:'Connect wallet & sign in',exact:true}).click();
      await apiPage.getByRole('alert').filter({hasText:'Wallet request declined'}).waitFor();
      assert.equal(await apiPage.getByRole('heading',{name:'Overview',exact:true}).count(),0);
    });
    await check('API adapter signs in on first connection and loads authenticated jobs',async()=>{
      await apiPage.evaluate(()=>window.walletReject=false);
      await apiPage.getByRole('button',{name:'Connect wallet & sign in',exact:true}).click();
      await apiPage.getByRole('link',{name:'API workload',exact:true}).waitFor();
      const calls=await apiPage.evaluate(()=>window.walletCalls);
      const signed=calls.find(item=>item.method==='personal_sign');
      assert.ok(signed.params[0].startsWith('0x'));
      assert.ok(Buffer.from(signed.params[0].slice(2),'hex').toString().includes('URI: http://127.0.0.1:5174'));
      assert.equal(await apiPage.getByText('Local demo',{exact:true}).count(),0);
    });
    await check('API errors and empty provider list have working recovery states',async()=>{
      listFail=true;
      await apiPage.getByRole('button',{name:'Refresh',exact:true}).click();
      await apiPage.getByRole('alert').filter({hasText:'Could not load jobs.'}).waitFor();
      listFail=false;
      await apiPage.getByRole('button',{name:'Try again',exact:true}).click();
      await apiPage.getByRole('alert').filter({hasText:'Could not load jobs.'}).waitFor({state:'hidden'});
      await apiPage.getByRole('button',{name:'Provider',exact:true}).click();
      await apiPage.getByText('No assigned jobs yet.',{exact:true}).waitFor();
      await apiPage.getByRole('button',{name:'Buyer',exact:true}).click();
    });
    await check('submission retries preserve values and reuse an idempotency key',async()=>{
      await apiPage.getByRole('link',{name:'Submit job',exact:true}).click();
      await apiPage.getByLabel('Job name',{exact:true}).fill('API submission');
      await apiPage.getByLabel('Container image',{exact:true}).fill('ghcr.io/team/workload:latest');
      await apiPage.getByLabel('Maximum budget (ETH)',{exact:true}).fill('0.000000000000000001');
      failSubmission=true;
      await apiPage.getByRole('button',{name:'Submit job',exact:true}).click();
      await apiPage.getByRole('alert').filter({hasText:'Submission unavailable.'}).waitFor();
      assert.equal(await apiPage.getByLabel('Job name',{exact:true}).inputValue(),'API submission');
      failSubmission=false;
      await apiPage.getByRole('button',{name:'Submit job',exact:true}).click();
      await apiPage.getByRole('heading',{name:'API submission',exact:true}).waitFor();
      assert.equal(submitted.length,2);
      assert.equal(submitted[0].key,submitted[1].key);
      assert.equal(submitted[0].body.maxPrice,'0.000000000000000001');
      assert.equal(submitted[0].body.k,3);
    });
    await check('detail refresh enables authenticated result downloads',async()=>{
      job={...job,status:'COMPLETED',result:{available:true,filename:'artifact.txt'},consensus:{agreeing:3,required:2}};
      await apiPage.getByRole('button',{name:'Refresh',exact:true}).click();
      await apiPage.getByRole('button',{name:'Download result',exact:true}).waitFor();
      const pending=apiPage.waitForEvent('download');
      await apiPage.getByRole('button',{name:'Download result',exact:true}).click();
      const download=await pending;
      assert.equal(await fs.readFile(await download.path(),'utf8'),'verified artifact');
      assert.ok(routes.find(item=>item.path==='/api/jobs/api-job/result').headers.authorization);
    });
    await check('wallet/chain changes and authenticated 401 clear the session',async()=>{
      await apiPage.evaluate(()=>window.walletEmit('chainChanged','0xa'));
      await apiPage.getByRole('button',{name:'Connect wallet & sign in',exact:true}).waitFor();
      await apiPage.getByRole('alert').filter({hasText:'Your wallet changed.'}).waitFor();
      await apiPage.getByRole('button',{name:'Connect wallet & sign in',exact:true}).click();
      await apiPage.getByRole('heading',{name:'API submission',exact:true}).waitFor();
      expire=true;
      await apiPage.getByRole('button',{name:'Refresh',exact:true}).click();
      await apiPage.getByRole('button',{name:'Connect wallet & sign in',exact:true}).waitFor();
      await apiPage.getByRole('alert').filter({hasText:'Your session expired.'}).waitFor();
    });
    await check('missing injected wallet produces an actionable error',async()=>{
      const noWallet=await browser.newPage();
      await noWallet.goto('http://127.0.0.1:5174');
      await noWallet.getByRole('button',{name:'Connect wallet & sign in',exact:true}).click();
      await noWallet.getByRole('alert').filter({hasText:'No Ethereum wallet found.'}).waitFor();
      await noWallet.close();
    });
    const lateContext=await browser.newContext();
    const latePage=await lateContext.newPage();
    latePage.setDefaultTimeout(10000);
    latePage.on('pageerror',error=>errors.push(error.message));
    const clockStart=new Date('2026-10-18T12:00:00Z');
    const day=24*60*60*1000;
    await latePage.clock.install({time:clockStart});
    await latePage.route('**/api/**',async route=>{
      const request=route.request();
      const path=new URL(request.url()).pathname;
      const json=(body,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
      if(path==='/api/auth/nonce')return json({nonce:'latewallet123',issuedAt:clockStart.toISOString()});
      if(path==='/api/auth/verify')return json({token:'late-token',expiresAt:new Date(+clockStart+30*day).toISOString(),account:{id:'late-account',wallet:'0x71C0000000000000000000000000000000009A2F'}});
      // A poll due on the expiry tick can race React's unmount; the API rejects it.
      if(!request.headers().authorization)return json({message:'Session expired.'},401);
      assert.equal(request.headers().authorization,'Bearer late-token');
      if(path==='/api/jobs')return json({jobs:[job],summary:{activeJobs:0,completedJobs:1,totalSpent:'0.005'}});
      throw new Error('unexpected late-wallet API '+request.url());
    });
    await check('a wallet injected after mount registers account and disconnect listeners',async()=>{
      await latePage.goto('http://127.0.0.1:5174');
      await latePage.getByRole('button',{name:'Connect wallet & sign in',exact:true}).waitFor();
      assert.equal(await latePage.evaluate(()=>typeof window.ethereum),'undefined');
      await latePage.evaluate(()=>{
        const listeners={};
        const address='0x71C0000000000000000000000000000000009A2F';
        window.ethereum={
          request:async({method})=>{
            if(['eth_requestAccounts','eth_accounts'].includes(method))return [address];
            if(method==='eth_chainId')return '0x1';
            if(method==='personal_sign')return '0xlate-signature';
            throw new Error('unexpected RPC '+method);
          },
          on:(event,fn)=>(listeners[event]??=[]).push(fn),
          removeListener:(event,fn)=>{listeners[event]=(listeners[event]||[]).filter(item=>item!==fn)},
        };
        window.walletEmit=(event,data)=>listeners[event]?.forEach(fn=>fn(data));
      });
      for(const event of ['accountsChanged','disconnect']) {
        await latePage.getByRole('button',{name:'Connect wallet & sign in',exact:true}).click();
        await latePage.getByRole('link',{name:'API submission',exact:true}).waitFor();
        await latePage.evaluate(event=>window.walletEmit(event,[]),event);
        await latePage.getByRole('button',{name:'Connect wallet & sign in',exact:true}).waitFor();
        await latePage.getByRole('alert').filter({hasText:'Your wallet changed.'}).waitFor();
      }
    });
    await check('30-day sessions survive the timer limit and expire at their actual deadline',async()=>{
      await latePage.getByRole('button',{name:'Connect wallet & sign in',exact:true}).click();
      await latePage.getByRole('link',{name:'API submission',exact:true}).waitFor();
      // Playwright's clock also limits each fast-forward to a signed 32-bit duration.
      await latePage.clock.fastForward(24*day);
      await latePage.clock.fastForward(day);
      await latePage.getByRole('heading',{name:'Overview',exact:true}).waitFor();
      assert.equal(await latePage.getByRole('button',{name:'Sign out',exact:true}).count(),1);
      assert.equal(await latePage.getByRole('button',{name:'Connect wallet & sign in',exact:true}).count(),0);
      await latePage.clock.fastForward(5*day);
      await latePage.getByRole('button',{name:'Connect wallet & sign in',exact:true}).waitFor();
      await latePage.getByRole('alert').filter({hasText:'Your session expired.'}).waitFor();
      assert.equal(await latePage.getByRole('heading',{name:'Overview',exact:true}).count(),0);
    });
    await lateContext.close();
    assert.deepEqual(errors,[]);
    console.log(JSON.stringify({checks:done.length,pageErrors:errors,screenshots:root},null,2));
  } finally { await browser.close(); }
})().catch(error=>{console.error(error);process.exitCode=1});
