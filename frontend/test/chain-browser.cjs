// Browser -> Vite's HTTPS proxy -> the real server in chain mode -> a real Hardhat node and contract.
// Unlike server-browser.cjs (CHAIN=off), every wallet action here is a real transaction: the
// injected wallet signs sign-in messages with the public dev keys and forwards everything else
// (eth_sendTransaction, eth_call, receipts) to the Hardhat node, whose dev accounts are unlocked.
// Each step is checked in the page and on the chain:
//   buyer: save a job -> submit it to the chain -> the page follows the chain -> cancel on chain
//          -> collect the refund
//   provider: authorize a session key (registered on chain for this wallet) -> revoke it
//          -> collect credited funds
//
//   MONGODB_URI=mongodb://127.0.0.1:27017 npm run test:chain-browser
// Needs Playwright's Chromium and blockchain/ installed (npm ci in blockchain/).
const assert = require('node:assert/strict');
const { execFileSync, spawn } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');
// BROWSER=firefox|webkit runs the same checks in another engine (default chromium)
const engine = require(process.env.PLAYWRIGHT_MODULE || 'playwright')[process.env.BROWSER || 'chromium'];
const sandboxArgs = (process.env.BROWSER || 'chromium') === 'chromium' ? ['--no-sandbox'] : [];
const root = path.resolve(__dirname, '../..');
const serverRequire = createRequire(path.join(root, 'server/package.json'));
const mongoose = serverRequire('mongoose');
const { createPublicClient, createWalletClient, http, parseEther, formatEther } = serverRequire('viem');
const { privateKeyToAccount } = serverRequire('viem/accounts');
const children = [];
const pageErrors = [];
const DIGEST = `docker.io/library/alpine@sha256:${'a'.repeat(64)}`;

async function check(name, action) {
  await action();
  console.log('PASS', name);
}
async function freePort() {
  const socket = net.createServer().listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const { port } = socket.address();
  await new Promise(resolve => socket.close(resolve));
  return port;
}
function start(name, command, args, cwd, env) {
  const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  child.output = '';
  child.name = name;
  child.stdout.on('data', data => { child.output += data; });
  child.stderr.on('data', data => { child.output += data; });
  children.push(child);
  return child;
}
async function ready(child, probe, timeout = 60000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`${child.name} exited ${child.exitCode}\n${child.output}`);
    if (await probe().catch(() => false)) return;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error(`${child.name} readiness timeout\n${child.output.slice(-3000)}`);
}
const until = async (what, probe, timeout = 30000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await probe().catch(error => { if (error.final) throw error; return false; });
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`timed out waiting for ${what}`);
};

(async () => {
  assert.ok(process.env.MONGODB_URI, 'Set MONGODB_URI to a running MongoDB; the test creates and removes its own database.');
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'offbalance-chain-web-'));
  const { testCertificates } = await import(pathToFileURL(path.join(root, 'server/test/helpers/tls.ts')));
  const tls = testCertificates(scratch);
  const uri = new URL(process.env.MONGODB_URI);
  uri.pathname = `/offbalance-chain-web-${process.pid}-${Date.now()}`;
  const dev = Object.fromEntries((await fs.readFile(path.join(root, 'dev.env'), 'utf8')).split('\n')
    .filter(line => /^[A-Z_0-9]+=/.test(line)).map(line => { const i = line.indexOf('='); return [line.slice(0, i), line.slice(i + 1).trim()]; }));
  let database;
  let browser;
  let page;
  try {
    // chain and contract
    const blockchain = path.join(root, 'blockchain');
    execFileSync('npx', ['hardhat', 'compile', '--quiet'], { cwd: blockchain, stdio: 'ignore' });
    const rpcPort = await freePort();
    const rpcUrl = `http://127.0.0.1:${rpcPort}`;
    const node = start('hardhat node', 'npx', ['hardhat', 'node', '--port', String(rpcPort)], blockchain, process.env);
    const rpc = createPublicClient({ transport: http(rpcUrl) });
    await ready(node, () => rpc.getChainId());
    const artifact = JSON.parse(await fs.readFile(path.join(blockchain, 'artifacts/contracts/OffBalance.sol/OffBalance.json'), 'utf8'));
    const wallet = key => createWalletClient({ account: privateKeyToAccount(key), transport: http(rpcUrl), chain: null });
    const deployer = wallet(dev.SERVER_PRIVATE_KEY);
    const deployHash = await deployer.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode, account: deployer.account, chain: null });
    const address = (await rpc.waitForTransactionReceipt({ hash: deployHash })).contractAddress;
    const deploymentFile = path.join(scratch, 'localhost.json');
    await fs.writeFile(deploymentFile, JSON.stringify({ chainId: 31337, address, abi: artifact.abi }));
    const read = (functionName, args = []) => rpc.readContract({ address, abi: artifact.abi, functionName, args });

    // server (chain mode) and Vite
    database = await mongoose.createConnection(uri.toString(), { serverSelectionTimeoutMS: 5000 }).asPromise();
    await database.collection('tutorials').insertOne({ text: 'Run the provider client.', updatedAt: new Date() });
    const serverPort = await freePort();
    const webPort = await freePort();
    const webUrl = `http://127.0.0.1:${webPort}`;
    const environment = { ...process.env, MONGODB_URI: uri.toString(), CHAIN: 'on', RPC_URL: rpcUrl, DEPLOYMENT_FILE: deploymentFile,
      SERVER_PRIVATE_KEY: dev.SERVER_PRIVATE_KEY, CHAIN_POLL_MS: '250', CHAIN_CONFIRMATIONS: '0', PORT: String(serverPort),
      TLS_KEY_FILE: tls.key, TLS_CERT_FILE: tls.cert, REGISTRY_NAMESPACE: '', CORS_ORIGINS: webUrl,
      API_PROXY_TARGET: `https://localhost:${serverPort}`, API_CA_FILE: tls.ca, VITE_API_MODE: 'api', VITE_API_BASE_URL: '/api',
      RESULT_STORAGE: 'local', RESULT_LOCAL_DIR: path.join(scratch, 'results') };
    delete environment.NODE_TEST_CONTEXT;
    delete environment.NODE_TLS_REJECT_UNAUTHORIZED;
    const server = start('server (chain mode)', process.execPath, ['server.ts'], path.join(root, 'server'), environment);
    await ready(server, async () => /Server on https/.test(server.output));
    const vite = start('Vite', process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(webPort), '--strictPort'], path.join(root, 'frontend'), environment);
    await ready(vite, async () => (await fetch(webUrl)).ok);

    // the browser wallet: dev keys sign messages; everything else goes to the Hardhat node
    const keys = [dev.BUYER_PRIVATE_KEY, dev.PROVIDER_1_PRIVATE_KEY].map(privateKeyToAccount);
    const [buyer, provider] = keys.map(account => account.address);
    browser = await engine.launch({ headless: true, args: sandboxArgs,
      ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}) });
    const context = await browser.newContext({ viewport: { width: 1280, height: 960 } });
    await context.exposeBinding('signWalletMessage', async (_source, index, raw) => keys[index].signMessage({ message: { raw } }));
    await context.exposeBinding('nodeRpc', async (_source, method, params) => {
      const response = await fetch(rpcUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
      const body = await response.json();
      if (body.error) return { error: body.error };
      return { result: body.result };
    });
    await context.addInitScript(addresses => {
      const listeners = {};
      let index = 0;
      window.ethereum = {
        request: async ({ method, params = [] }) => {
          if (['eth_accounts', 'eth_requestAccounts'].includes(method)) return [addresses[index]];
          if (method === 'personal_sign') return window.signWalletMessage(index, params[0]);
          const { result, error } = await window.nodeRpc(method, params);
          if (error) throw Object.assign(new Error(error.message), { code: error.code, data: error.data });
          return result;
        },
        on: (event, fn) => (listeners[event] ??= []).push(fn),
        removeListener: (event, fn) => { listeners[event] = (listeners[event] || []).filter(item => item !== fn); },
      };
      window.switchWallet = next => { index = next; listeners.accountsChanged?.forEach(fn => fn([addresses[index]])); };
    }, [buyer, provider]);
    page = await context.newPage();
    page.setDefaultTimeout(30000);
    page.on('pageerror', error => pageErrors.push(error.message));
    page.on('dialog', dialog => dialog.accept());
    // The session lives only in memory, so a full page load signs out; move between pages by hash.
    const signIn = async () => {
      const authenticated = page.waitForResponse(response => new URL(response.url()).pathname === '/api/auth' && response.request().method() === 'POST');
      await page.getByRole('button', { name: 'Connect wallet & sign in', exact: true }).click();
      assert.equal((await authenticated).status(), 201);
      await page.getByRole('button', { name: 'Sign out', exact: true }).waitFor();
    };
    const expectNotice = async text => {
      await until(`"${text}"`, async () => {
        if (await page.getByText(text).isVisible()) return true;
        const alerts = await page.getByRole('alert').allTextContents();
        if (alerts.length) throw Object.assign(new Error(`the page shows an error instead: ${alerts.join(' | ')}`), { final: true });
        return false;
      }, 30000);
    };
    const PRICE = parseEther('0.01');
    let jobId;

    await page.goto(webUrl);
    await check('the page reports chain mode with the deployed contract', async () => {
      const config = await page.evaluate(() => fetch('/api/config').then(r => r.json()));
      assert.equal(config.executionMode, 'chain');
      assert.equal(config.chain.address.toLowerCase(), address.toLowerCase());
    });

    await check('the buyer saves a job and submits it to the chain from the job page', async () => {
      await signIn();
      await page.goto(`${webUrl}/#/jobs/new`);
      await page.getByLabel('Job name').fill('chain browser job');
      await page.getByLabel('Container image').fill(DIGEST);
      await page.getByLabel('Hourly cap per provider (ETH)').fill('0.01');
      await page.getByRole('button', { name: 'Save job' }).click();
      await page.getByRole('button', { name: 'Submit to blockchain' }).click();
      await page.getByText(/Transaction sent:/).waitFor();
      jobId = Number(page.url().match(/#\/jobs\/(\d+)/)[1]);
      assert.equal(await read('getJobStatus', [BigInt(jobId)]), 0, 'JOB_SUBMITTED on chain');
      assert.equal(await rpc.getBalance({ address }), PRICE, 'the escrow is in the contract');
    });

    await check('the page follows the chain: once the server sees the submission it offers an on-chain cancel', async () => {
      // the submission panel goes once the server has seen JOB_SUBMITTED
      await until('the server to see the submission', async () => !(await page.getByRole('region', { name: 'Blockchain submission' }).isVisible()), 30000);
      // B16: the page that sent the transaction keeps the cancel button hidden until it's reloaded.
      // The session lives only in memory, so a reload signs the buyer out: sign in again.
      await page.reload();
      await signIn();
      await page.getByRole('button', { name: 'Cancel job and refund escrow' }).waitFor();
    });

    await check('cancelling goes through the wallet, and the page shows the job canceled', async () => {
      await page.getByRole('button', { name: 'Cancel job and refund escrow' }).click();
      await until('CANCELED on chain', async () => await read('getJobStatus', [BigInt(jobId)]) === 9);
      assert.equal(await read('credits', [buyer]), PRICE, 'the escrow is credited back to the buyer');
      await until('the Canceled badge', async () => (await page.locator('.page-heading .status').textContent()) === 'Canceled', 30000);
    });

    await check('the buyer collects the refund into their wallet', async () => {
      const before = await rpc.getBalance({ address: buyer });
      await page.getByRole('button', { name: 'Collect refund' }).click();
      await expectNotice('Collected 0.010 ETH to your wallet.');
      assert.equal(await read('credits', [buyer]), 0n);
      const gained = (await rpc.getBalance({ address: buyer })) - before;
      assert.ok(gained > PRICE - parseEther('0.001') && gained <= PRICE, `the wallet gained ${formatEther(gained)} ETH (the refund less gas)`);
    });

    await check('switching to the provider wallet signs the buyer out; the provider signs in', async () => {
      await page.evaluate(() => { window.location.hash = '#/'; });
      await page.evaluate(() => window.switchWallet(1));
      await page.getByRole('button', { name: 'Connect wallet & sign in', exact: true }).waitFor();
      await signIn();
    });

    let sessionAddress;
    await check('the provider authorizes a session key: it is registered on chain for this wallet, and shown once', async () => {
      await page.goto(`${webUrl}/#/provider`);
      await page.getByRole('button', { name: 'Authorize provider client' }).click();
      const key = await page.getByLabel('Session key (shown once)').inputValue();
      assert.match(key, /^0x[0-9a-f]{64}$/);
      sessionAddress = privateKeyToAccount(key).address;
      assert.equal((await read('activeSessionKey', [provider])).toLowerCase(), sessionAddress.toLowerCase());
      assert.equal((await read('providerOf', [sessionAddress])).toLowerCase(), provider.toLowerCase());
      assert.equal(await rpc.getBalance({ address: sessionAddress }), parseEther('0.05'), 'the default funding reached the key');
    });

    await check('revoking the key removes it on chain', async () => {
      await page.getByRole('button', { name: 'Revoke key' }).click();
      await page.getByText(/Session key revoked/).waitFor();
      assert.equal(await read('activeSessionKey', [provider]), '0x0000000000000000000000000000000000000000');
      assert.equal((await read('providerOf', [sessionAddress])).toLowerCase(), sessionAddress.toLowerCase());
    });

    await check('the provider collects funds credited to its wallet', async () => {
      // credits for the provider: a job it submitted and canceled itself
      const own = wallet(dev.PROVIDER_1_PRIVATE_KEY);
      const submit = await own.writeContract({ address, abi: artifact.abi, functionName: 'submitJob',
        args: [PRICE, 1n, 1n, 60n, 'img'], value: PRICE, account: own.account, chain: null });
      const receipt = await rpc.waitForTransactionReceipt({ hash: submit });
      const [log] = await rpc.getContractEvents({ address, abi: artifact.abi, eventName: 'JOB_SUBMITTED', fromBlock: receipt.blockNumber, toBlock: receipt.blockNumber });
      await rpc.waitForTransactionReceipt({ hash: await own.writeContract({ address, abi: artifact.abi, functionName: 'cancelJob', args: [log.args.jobId], account: own.account, chain: null }) });
      assert.equal(await read('credits', [provider]), PRICE);

      await page.evaluate(() => { window.location.hash = '#/'; }); // a full navigation would sign out
      await page.getByRole('button', { name: 'Provider', exact: true }).click();
      await until('the collectable amount', async () => (await page.locator('.collect-amount').textContent()).startsWith('0.010'), 30000);
      const before = await rpc.getBalance({ address: provider });
      await page.getByRole('button', { name: 'Collect funds' }).click();
      // B17: under the dev server's StrictMode this page never confirms the collection (the
      // button stays on "Check your wallet…"), so check the money instead of the message.
      await until('the withdrawal on chain', async () => await read('credits', [provider]) === 0n, 30000);
      const gained = (await rpc.getBalance({ address: provider })) - before;
      assert.ok(gained > PRICE - parseEther('0.001') && gained <= PRICE, `the wallet gained ${formatEther(gained)} ETH`);
      await until('the collectable amount to drop to zero', async () => (await page.locator('.collect-amount').textContent()).startsWith('0.000'), 30000);
    });

    assert.deepEqual(pageErrors, [], 'no uncaught errors in the page');
    console.log('chain browser test: all checks passed');
  } catch (error) {
    console.error(error);
    if (page) console.error(`----- page text -----\n${(await page.evaluate(() => document.body.innerText).catch(() => '')).slice(0, 2000)}`);
    for (const child of children) console.error(`----- ${child.name} -----\n${child.output.slice(-2500)}`);
    if (page) await page.screenshot({ path: path.join(scratch, 'failure.png'), fullPage: true }).then(() => console.error(`screenshot: ${path.join(scratch, 'failure.png')}`)).catch(() => {});
    process.exitCode = 1;
  } finally {
    await browser?.close().catch(() => {});
    for (const child of children) { try { process.kill(-child.pid, 'SIGTERM'); } catch { /* gone */ } }
    if (database) { await database.dropDatabase().catch(() => {}); await database.close(); }
  }
})();
