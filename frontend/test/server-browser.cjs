// Browser -> Vite's verified HTTPS proxy -> production server -> isolated MongoDB.
// Only the browser wallet is a fixture; it signs real challenges with public dev keys.
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const { once } = require('node:events');
const fs = require('node:fs/promises');
const https = require('node:https');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '../..');
const serverRequire = createRequire(path.join(root, 'server/package.json'));
const mongoose = serverRequire('mongoose');
const { privateKeyToAccount } = serverRequire('viem/accounts');
const children = [];
const checks = [];
const pageErrors = [];

async function check(name, action) {
  await action();
  checks.push(name);
  console.log('PASS', name);
}
async function freePort() {
  const socket = net.createServer();
  socket.listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  return port;
}
function start(name, args, cwd, env) {
  const child = spawn(process.execPath, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.output = '';
  child.name = name;
  child.stdout.on('data', data => { child.output += data; });
  child.stderr.on('data', data => { child.output += data; });
  child.on('error', error => { child.output += error.stack; });
  children.push(child);
  return child;
}
async function ready(child, probe) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`${child.name} exited ${child.exitCode}\n${child.output}`);
    if (await probe().catch(() => false)) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`${child.name} readiness timeout\n${child.output}`);
}
async function stop(child) {
  if (child.exitCode !== null) return;
  const exit = once(child, 'exit');
  const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
  child.kill('SIGTERM');
  await exit;
  clearTimeout(timer);
}

(async () => {
  assert.ok(process.env.MONGODB_URI, 'Set MONGODB_URI to a running MongoDB; the test creates and removes its own database.');
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'offbalance-web-'));
  const artifacts = process.env.BROWSER_ARTIFACTS || path.join(root, 'frontend/.local/screens');
  const { testCertificates } = await import(pathToFileURL(path.join(root, 'server/test/helpers/tls.ts')));
  const tls = testCertificates(scratch);
  const ca = await fs.readFile(tls.ca);
  const uri = new URL(process.env.MONGODB_URI);
  uri.pathname = `/offbalance-web-${process.pid}-${Date.now()}`;
  let database;
  let browser;
  let page;
  try {
    database = await mongoose.createConnection(uri.toString(), { serverSelectionTimeoutMS: 5000 }).asPromise();
    // Tutorial content is ordinary fixture data, not a replacement HTTP handler.
    await database.collection('tutorials').insertOne({ text: 'Run the provider client to benchmark your machine.', updatedAt: new Date() });
    const serverPort = await freePort();
    const webPort = await freePort();
    const serverUrl = `https://localhost:${serverPort}`;
    const webUrl = `http://127.0.0.1:${webPort}`;
    const environment = { ...process.env, MONGODB_URI: uri.toString(), CHAIN: 'off', PORT: String(serverPort),
      TLS_KEY_FILE: tls.key, TLS_CERT_FILE: tls.cert, REGISTRY_NAMESPACE: '', CORS_ORIGINS: webUrl,
      API_PROXY_TARGET: serverUrl, API_CA_FILE: tls.ca, VITE_API_MODE: 'api', VITE_API_BASE_URL: '/api' };
    delete environment.NODE_TEST_CONTEXT;
    delete environment.NODE_TLS_REJECT_UNAUTHORIZED;
    const request = (pathname, { token, method = 'GET', body } = {}) => new Promise((resolve, reject) => {
      const req = https.request(`${serverUrl}${pathname}`, { ca, rejectUnauthorized: true, method,
        headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) } }, response => {
        let text = '';
        response.on('data', data => { text += data; });
        response.on('end', () => resolve({ status: response.statusCode, body: text ? JSON.parse(text) : null }));
      });
      req.on('error', reject);
      req.setTimeout(2000, () => req.destroy(new Error('HTTPS timeout')));
      req.end(body ? JSON.stringify(body) : undefined);
    });
    const server = start('production HTTPS server', ['server.ts'], path.join(root, 'server'), environment);
    await ready(server, async () => (await request('/provider/tutorial')).status === 200);
    const vite = start('Vite', ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(webPort), '--strictPort'], path.join(root, 'frontend'), environment);
    await ready(vite, async () => (await fetch(webUrl)).ok);
    const dev = Object.fromEntries((await fs.readFile(path.join(root, 'dev.env'), 'utf8')).split('\n')
      .filter(line => /^[A-Z_0-9]+=/.test(line)).map(line => { const i = line.indexOf('='); return [line.slice(0, i), line.slice(i + 1)]; }));
    const accounts = [dev.BUYER_PRIVATE_KEY, dev.PROVIDER_1_PRIVATE_KEY].map(privateKeyToAccount);
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox'],
      ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}) });
    const context = await browser.newContext({ viewport: { width: 1280, height: 960 } });
    await context.exposeBinding('signWalletMessage', async (_source, index, raw) => accounts[index].signMessage({ message: { raw } }));
    await context.addInitScript(addresses => {
      const listeners = {};
      let index = 0;
      window.ethereum = {
        request: async ({ method, params }) => {
          if (['eth_accounts', 'eth_requestAccounts'].includes(method)) return [addresses[index]];
          if (method === 'eth_chainId') return '0x7a69';
          if (method === 'personal_sign') {
            if (window.rejectWalletSignature) throw { code: 4001, message: 'User rejected signature' };
            const signature = await window.signWalletMessage(index, params[0]);
            if (window.changeWalletDuringSign) { window.changeWalletDuringSign = false; window.switchWallet(1); }
            return signature;
          }
          throw new Error(`Unexpected wallet RPC ${method}`);
        },
        on: (event, fn) => (listeners[event] ??= []).push(fn),
        removeListener: (event, fn) => { listeners[event] = (listeners[event] || []).filter(item => item !== fn); },
      };
      window.switchWallet = next => { index = next; listeners.accountsChanged?.forEach(fn => fn([addresses[index]])); };
    }, accounts.map(account => account.address));
    page = await context.newPage();
    page.setDefaultTimeout(15000);
    page.on('pageerror', error => pageErrors.push(error.message));
    const apiCalls = [];
    page.on('request', request => { if (new URL(request.url()).pathname.startsWith('/api/')) apiCalls.push(request); });
    const signIn = async () => {
      const authenticated = page.waitForResponse(response => /\/api\/auth(?:\/verify)?$/.test(new URL(response.url()).pathname) && response.request().method() === 'POST');
      const [response] = await Promise.all([authenticated, page.getByRole('button', { name: 'Connect wallet & sign in', exact: true }).click()]);
      assert.equal(response.status(), 201, await response.text());
      const session = await response.json();
      await page.getByRole('button', { name: 'Sign out', exact: true }).waitFor();
      return session;
    };
    const shot = async name => { await fs.mkdir(artifacts, { recursive: true }); await page.screenshot({ path: path.join(artifacts, `${name}.png`), fullPage: true }); };
    let buyer;
    let provider;
    let job;
    const name = 'Persisted browser workload';
    await check('missing wallets, signature rejection and wallet changes during sign-in leave no authenticated session', async () => {
      const noWallet = await browser.newPage();
      await noWallet.goto(webUrl);
      await noWallet.getByRole('button', { name: 'Connect wallet & sign in', exact: true }).click();
      await noWallet.getByRole('alert').filter({ hasText: 'No Ethereum wallet found.' }).waitFor();
      await noWallet.close();
      await page.goto(webUrl);
      await page.evaluate(() => { window.rejectWalletSignature = true; });
      await page.getByRole('button', { name: 'Connect wallet & sign in', exact: true }).click();
      await page.getByRole('alert').filter({ hasText: 'Wallet request declined.' }).waitFor();
      assert.equal(await database.collection('authtokens').countDocuments(), 0);
      await page.evaluate(() => { window.rejectWalletSignature = false; window.changeWalletDuringSign = true; });
      await page.getByRole('button', { name: 'Connect wallet & sign in', exact: true }).click();
      await page.getByRole('alert').filter({ hasText: 'Your wallet changed.' }).waitFor();
      assert.equal(await page.getByRole('button', { name: 'Sign out', exact: true }).count(), 0);
      assert.equal(await database.collection('authtokens').countDocuments(), 0);
      await page.evaluate(() => window.switchWallet(0));
    });
    await check('a real wallet signature authenticates through Vite and verified HTTPS against an empty database', async () => {
      await assert.rejects(new Promise((resolve, reject) => {
        const request = https.get(`${serverUrl}/provider/tutorial`, { rejectUnauthorized: true }, response => { response.resume(); resolve(response.statusCode); });
        request.on('error', reject);
      }), /certificate|issuer|self.signed/i);
      buyer = await signIn();
      await page.getByText('No jobs yet.', { exact: true }).waitFor();
      assert.equal(await database.collection('accounts').countDocuments(), 1);
      assert.equal(await database.collection('authtokens').countDocuments(), 1);
      assert.equal(apiCalls.every(request => new URL(request.url()).origin === webUrl), true);
      await shot('real-empty-dashboard');
    });
    await check('saving a named job persists the actual MongoDB record and survives a browser reload', async () => {
      await page.getByRole('link', { name: /^(Submit|Save) job$/, exact: true }).click();
      await page.getByLabel('Job name', { exact: true }).fill(name);
      await page.getByLabel('Container image', { exact: true }).fill(`docker.io/library/alpine@sha256:${'a'.repeat(64)}`);
      await page.getByLabel('Hourly cap per provider (ETH)', { exact: true }).fill('0.005');
      await page.getByLabel('Execution window (minutes)', { exact: true }).fill('10');
      await page.getByRole('button', { name: 'Save job', exact: true }).click();
      await page.getByRole('heading', { name, exact: true }).waitFor();
      await page.getByText(/Database-backed coordinator mode/).waitFor();
      job = await database.collection('jobs').findOne({ name });
      assert.ok(job);
      assert.equal(job.timeWindow, 600);
      assert.equal(job.maxPrice.toString(), '0.005');
      assert.equal(job.minNodesToRunOn, 3);
      assert.equal(job.minNodesToAgree, 2);
      assert.equal(job.owner.toString(), buyer.accountId || buyer.account.id);
      await page.reload();
      buyer = await signIn();
      await page.getByRole('heading', { name, exact: true }).waitFor();
      await page.getByRole('link', { name: '← Overview', exact: true }).click();
      await page.getByRole('link', { name, exact: true }).waitFor();
      await shot('real-persisted-dashboard');
    });
    await check('wallet changes isolate buyer and provider views, and client benchmarks enable persistent pricing', async () => {
      await page.evaluate(() => window.switchWallet(1));
      await page.getByRole('alert').filter({ hasText: 'Your wallet changed.' }).waitFor();
      provider = await signIn();
      await page.getByText('No jobs yet.', { exact: true }).waitFor();
      await page.getByRole('button', { name: 'Provider', exact: true }).click();
      await page.getByText('No assigned jobs yet.', { exact: true }).waitFor();
      await page.getByRole('link', { name: 'Provider setup', exact: true }).click();
      assert.equal(await page.getByLabel('Client API key', { exact: true }).getAttribute('type'), 'password');
      assert.equal(await page.getByLabel('Client API key', { exact: true }).inputValue(), provider.token);
      await page.getByText('Waiting for hardware scores from the provider client.', { exact: true }).waitFor();
      assert.equal(await page.getByLabel('Price (ETH / hour)', { exact: true }).isDisabled(), true);
      const result = await request('/scores', { token: provider.token, method: 'POST', body: { cpu: 12345, mem: 8192 } });
      assert.equal(result.status, 201);
      await page.getByRole('button', { name: 'Refresh status', exact: true }).click();
      await page.getByText('CPU 12345 · GPU — · Memory 8192', { exact: true }).waitFor();
      await page.getByLabel('Price (ETH / hour)', { exact: true }).fill('0.002');
      await page.getByRole('button', { name: 'Save price', exact: true }).click();
      await page.getByText('Hourly price saved.', { exact: true }).waitFor();
      const machine = await database.collection('hardwares').findOne({ address: accounts[1].address.toLowerCase() });
      assert.equal(machine.price, 0.002);
      await page.getByRole('link', { name: '← Overview', exact: true }).click();
      await page.getByRole('button', { name: 'Provider', exact: true }).click();
      await page.getByRole('link', { name: 'Provider setup', exact: true }).click();
      assert.equal(await page.getByLabel('Client API key', { exact: true }).getAttribute('type'), 'password');
      assert.equal(await page.getByLabel('Client API key', { exact: true }).inputValue(), provider.token);
      await page.waitForFunction(() => document.querySelector('#provider-price')?.value === '0.002');
      await shot('real-provider-pricing');
    });
    await check('actual provider delivery receipts reach the buyer as metadata with no invented download or payment', async () => {
      // External execution/chain fixture: this test does not claim Docker execution or settlement.
      const providerAccount = await database.collection('accounts').findOne({ walletIds: accounts[1].address.toLowerCase() });
      await database.collection('jobs').updateOne({ _id: job._id }, { $set: { status: 'AWAITING_DELIVERY', providers: [providerAccount._id] } });
      const receipt = await request(`/provider/results/${job.onChainJobId}`, { token: provider.token, method: 'POST',
        body: { hash: `0x${'b'.repeat(64)}`, location: 'https://example.com/offbalance-result.txt' } });
      assert.equal(receipt.status, 201);
      assert.equal(receipt.body.results[0].receiptVerified, false);
      await page.getByRole('link', { name: '← Overview', exact: true }).click();
      await page.evaluate(() => window.switchWallet(0));
      buyer = await signIn();
      await page.getByRole('link', { name, exact: true }).click();
      // Result locations are metadata; the UI must not download the JSON envelope as a file.
      await page.getByRole('button', { name: 'Load delivery records', exact: true }).click();
      await page.getByText(`0x${'b'.repeat(64)}`, { exact: true }).waitFor();
      const output = page.getByRole('link', { name: 'Open provider output (unverified receipt)', exact: true });
      assert.equal(await output.getAttribute('href'), 'https://example.com/offbalance-result.txt');
      await page.getByText('Not verified', { exact: true }).waitFor();
      assert.equal(await page.getByRole('button', { name: 'Download result', exact: true }).count(), 0);
      const persisted = await database.collection('jobs').findOne({ _id: job._id });
      assert.equal(persisted.results.length, 1);
      assert.equal(persisted.results[0].location, 'https://example.com/offbalance-result.txt');
      await shot('real-delivery-metadata');
      await page.setViewportSize({ width: 375, height: 900 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
      await shot('real-delivery-mobile');
    });
    await check('a token revoked in MongoDB receives a real 401 and clears the browser session', async () => {
      await database.collection('authtokens').deleteOne({ tokenHash: createHash('sha256').update(buyer.token).digest('hex') });
      await page.getByRole('button', { name: 'Refresh', exact: true }).click();
      await page.getByRole('button', { name: 'Connect wallet & sign in', exact: true }).waitFor();
      await page.getByRole('alert').filter({ hasText: 'Your session expired.' }).waitFor();
    });
    assert.deepEqual(pageErrors, []);
    assert.ok(apiCalls.some(request => /\/api\/jobs/.test(request.url())));
    console.log(JSON.stringify({ checks: checks.length, pageErrors, screenshots: artifacts, transport: 'Browser -> Vite -> verified HTTPS -> production server -> MongoDB' }, null, 2));
  } catch (error) {
    if (page) console.error('Browser state:', await page.locator('body').innerText().catch(() => 'closed'));
    for (const child of children) console.error(`${child.name}:\n${child.output}`);
    throw error;
  } finally {
    await browser?.close();
    await Promise.all(children.map(stop));
    if (database) { await database.dropDatabase(); await database.close(); }
    await fs.rm(scratch, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
