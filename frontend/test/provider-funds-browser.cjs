const assert = require('node:assert/strict');

// The coordinator funds routes are fixtures; no wallet transfer is performed.
module.exports = async function providerFundsChecks({ browser, check, errors }) {
  const { createServer } = await import('vite');
  const vite = await createServer({ mode: 'development', logLevel: 'error',
    define: { 'import.meta.env.VITE_API_MODE': JSON.stringify('api') },
    server: { host: '127.0.0.1', port: 0, open: false } });
  let context;
  try {
    await vite.listen();
    context = await browser.newContext();
    await context.addInitScript(() => {
      const wallet = '0x71C0000000000000000000000000000000009A2F';
      window.ethereum = { request: async ({ method }) => {
        if (['eth_accounts', 'eth_requestAccounts'].includes(method)) return [wallet];
        if (method === 'eth_chainId') return '0x1';
        if (method === 'personal_sign') return '0xtest-signature';
        throw new Error('Unexpected wallet request: ' + method);
      }, on() {}, removeListener() {} };
    });
    const apiPage = await context.newPage();
    apiPage.setDefaultTimeout(10000);
    apiPage.on('pageerror', error => errors.push(error.message));
    let funds = { available: '0.003', currency: 'ETH', collectionEnabled: true };
    let latestCollection = null;
    let fundsFailure = false;
    let collectMode = 'success';
    let releaseCollection;
    const collections = [];
    const collectionResults = new Map();
    await apiPage.route('**/api/**', async route => {
      const request = route.request();
      const url = new URL(request.url());
      const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
      const wallet = '0x71C0000000000000000000000000000000009A2F';
      if (url.pathname === '/api/auth/nonce') return json({ wallet, message: `Sign in to OffBalance\n\nWallet: ${wallet}\nNonce: ${'a'.repeat(32)}` });
      if (url.pathname === '/api/auth') return json({ token: 'test-token', accountId: 'provider-account', wallet }, 201);
      assert.equal(request.headers().authorization, 'Bearer test-token');
      if (url.pathname === '/api/jobs') return json({ jobs: [] });
      if (url.pathname === '/api/account/me/dashboard') return json({ account: {}, buyer: {}, provider: {} });
      if (url.pathname === '/api/provider/funds') return fundsFailure ? json({ error: 'Funds service unavailable.' }, 503) : json({ funds, collection: latestCollection });
      if (url.pathname === '/api/provider/funds/collect') {
        const key = request.headers()['idempotency-key'];
        assert.equal(request.method(), 'POST');
        assert.ok(key);
        collections.push(key);
        if (collectionResults.has(key)) return json(collectionResults.get(key));
        if (collectMode === 'hold') await new Promise(resolve => { releaseCollection = resolve; });
        latestCollection = { status: ['pending', 'lost-pending'].includes(collectMode) ? 'PENDING' : 'COLLECTED', amount: funds.available };
        funds = { ...funds, available: '0' };
        const result = { funds, collection: latestCollection };
        collectionResults.set(key, result);
        if (collectMode.startsWith('lost')) return json({ error: 'Confirmation unavailable. Retry collection.' }, 503);
        return json(result);
      }
      throw new Error('Unexpected API request: ' + request.url());
    });
    await apiPage.goto(vite.resolvedUrls.local[0]);
    await apiPage.getByRole('button', { name: 'Connect wallet & sign in', exact: true }).click();
    await apiPage.getByRole('heading', { name: 'Overview', exact: true }).waitFor();
    await check('funds failures, unsupported collection and invalid balances disable collection',async()=>{
      await apiPage.getByRole('button',{name:'Provider',exact:true}).click();
      const panel=apiPage.getByRole('region',{name:'Available funds',exact:true});
      const collect=panel.getByRole('button',{name:'Collect funds',exact:true});
      await panel.locator('.funds-amount').filter({hasText:/^0\.003ETH$/}).waitFor();
      fundsFailure=true;
      await panel.getByRole('button',{name:'Refresh funds',exact:true}).click();
      await panel.getByRole('alert').filter({hasText:'Funds service unavailable.'}).waitFor();
      assert.equal(await collect.isDisabled(),true);
      fundsFailure=false;
      funds={...funds,available:'NaN'};
      await panel.getByRole('button',{name:'Refresh funds',exact:true}).click();
      await panel.getByRole('alert').filter({hasText:'invalid collection information'}).waitFor();
      assert.equal(await collect.isDisabled(),true);
      funds={...funds,available:'0.003',collectionEnabled:false};
      await panel.getByRole('button',{name:'Refresh funds',exact:true}).click();
      await panel.getByText('Fund collection is not configured yet.',{exact:true}).waitFor();
      assert.equal(await collect.isDisabled(),true);
      funds={...funds,collectionEnabled:true};
      await panel.getByRole('button',{name:'Refresh funds',exact:true}).click();
      await collect.waitFor();
      await apiPage.getByRole('button',{name:'Buyer',exact:true}).click();
    });
    await check('uncertain collection retries reuse their key after switching views',async()=>{
      collectMode='lost';
      await apiPage.getByRole('button',{name:'Provider',exact:true}).click();
      const panel=apiPage.getByRole('region',{name:'Available funds',exact:true});
      await panel.locator('.funds-amount').filter({hasText:/^0\.003ETH$/}).waitFor();
      await panel.getByRole('button',{name:'Collect funds',exact:true}).click();
      await panel.getByRole('alert').filter({hasText:'Confirmation unavailable.'}).waitFor();
      assert.equal(collections.length,1);
      await apiPage.getByRole('button',{name:'Buyer',exact:true}).click();
      await apiPage.getByRole('button',{name:'Provider',exact:true}).click();
      await panel.locator('.funds-amount').filter({hasText:/^0ETH$/}).waitFor();
      await panel.getByRole('button',{name:'Retry collection',exact:true}).click();
      await panel.getByRole('status').filter({hasText:'0.003 ETH collected.'}).waitFor();
      assert.equal(collections.length,2);
      assert.equal(collections[0],collections[1]);
      assert.equal(await panel.getByRole('button',{name:'Collect funds',exact:true}).isDisabled(),true);
      await apiPage.getByRole('button',{name:'Buyer',exact:true}).click();
    });
    await check('pending collection blocks duplicate clicks until a read confirms payment',async()=>{
      funds={...funds,available:'0.002'};
      latestCollection=null;
      collectMode='hold';
      await apiPage.getByRole('button',{name:'Provider',exact:true}).click();
      const panel=apiPage.getByRole('region',{name:'Available funds',exact:true});
      await panel.locator('.funds-amount').filter({hasText:/^0\.002ETH$/}).waitFor();
      await panel.getByRole('button',{name:'Collect funds',exact:true}).click();
      const collecting=panel.getByRole('button',{name:'Collecting…',exact:true});
      assert.equal(await collecting.isDisabled(),true);
      await collecting.dispatchEvent('click');
      collectMode='pending';
      releaseCollection();
      await panel.getByRole('status').filter({hasText:'Collection of 0.002 ETH is pending.'}).waitFor();
      assert.equal(collections.length,3);
      assert.notEqual(collections[2],collections[0]);
      assert.equal(await panel.getByRole('button',{name:'Collect funds',exact:true}).isDisabled(),true);
      await apiPage.getByRole('button',{name:'Buyer',exact:true}).click();
      await apiPage.getByRole('button',{name:'Provider',exact:true}).click();
      await panel.getByRole('status').filter({hasText:'Collection of 0.002 ETH is pending.'}).waitFor();
      latestCollection={...latestCollection,status:'COLLECTED'};
      await panel.getByRole('button',{name:'Refresh funds',exact:true}).click();
      await panel.getByRole('status').filter({hasText:'0.002 ETH collected.'}).waitFor();
      assert.equal(collections.length,3);
      await apiPage.getByRole('button',{name:'Buyer',exact:true}).click();
    });
    await check('pending funds reads block retries after an uncertain collection response',async()=>{
      funds={...funds,available:'0.001'};
      latestCollection=null;
      collectMode='lost-pending';
      await apiPage.getByRole('button',{name:'Provider',exact:true}).click();
      const panel=apiPage.getByRole('region',{name:'Available funds',exact:true});
      await panel.locator('.funds-amount').filter({hasText:/^0\.001ETH$/}).waitFor();
      await panel.getByRole('button',{name:'Collect funds',exact:true}).click();
      await panel.getByRole('alert').filter({hasText:'Confirmation unavailable.'}).waitFor();
      await panel.getByRole('button',{name:'Refresh funds',exact:true}).click();
      await panel.getByRole('status').filter({hasText:'Collection of 0.001 ETH is pending.'}).waitFor();
      assert.equal(await panel.getByRole('button',{name:'Retry collection',exact:true}).isDisabled(),true);
      assert.equal(collections.length,4);
      latestCollection={...latestCollection,status:'COLLECTED'};
      collectionResults.set(collections[3],{funds,collection:latestCollection});
      await panel.getByRole('button',{name:'Refresh funds',exact:true}).click();
      await panel.getByRole('button',{name:'Retry collection',exact:true}).click();
      await panel.getByRole('status').filter({hasText:'0.001 ETH collected.'}).waitFor();
      assert.equal(collections.length,5);
      assert.equal(collections[3],collections[4]);
      await apiPage.getByRole('button',{name:'Buyer',exact:true}).click();
    });
  } finally {
    await context?.close();
    await vite.close();
  }
};
