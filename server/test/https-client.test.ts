// Starts the production entrypoint against an isolated MongoDB and verifies both
// Sergey's unchanged contract suite and the actual Python ServerManager over TLS.
// Requires openssl, and Python with requests (TEST_PYTHON overrides python3).
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:https';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import mongoose from 'mongoose';
import { connectDB, disconnectDB } from '../db.ts';
import { HardwareModel } from '../models/index.ts';
import { testCertificates } from './helpers/tls.ts';

const serverDirectory = path.join(import.meta.dirname, '..');
const mongodbUri = process.env.MONGODB_URI;

describe('real HTTPS server and provider client', { skip: !mongodbUri && 'set MONGODB_URI to run' }, () => {
  let directory: string;
  let child: ChildProcess | undefined;
  let output = '';
  let base: string;
  let ca: string;
  let environment: NodeJS.ProcessEnv;

  function run(command: string, args: string[], env = environment): Promise<string> {
    return new Promise((resolve, reject) => {
      const process = spawn(command, args, { cwd: serverDirectory, env, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      process.stdout.on('data', data => { output += data; });
      process.stderr.on('data', data => { output += data; });
      const timeout = setTimeout(() => process.kill('SIGKILL'), 30_000);
      process.once('error', error => { clearTimeout(timeout); reject(error); });
      process.once('close', code => {
        clearTimeout(timeout);
        if (code === 0) resolve(output);
        else reject(new Error(`${command} ${args[0]} exited ${code}\n${output}`));
      });
    });
  }

  function httpsStatus(trustCertificate: boolean): Promise<number> {
    return new Promise((resolve, reject) => {
      const req = request(`${base}/contract_address`, {
        ...(trustCertificate ? { ca: readFileSync(ca) } : {}),
      }, response => { response.resume(); resolve(response.statusCode!); });
      req.on('error', reject);
      req.setTimeout(1000, () => req.destroy(new Error('HTTPS readiness timeout')));
      req.end();
    });
  }

  before(async () => {
    directory = mkdtempSync(path.join(tmpdir(), 'offbalance-https-'));
    const certificates = testCertificates(directory);
    ca = certificates.ca;
    const uri = new URL(mongodbUri!);
    uri.pathname = `/offbalance-https-${process.pid}-${Date.now()}`;
    const deployment = path.join(directory, 'deployment.json');
    writeFileSync(deployment, JSON.stringify({ chainId: 31337,
      address: '0x5FbDB2315678afecb367f032d93F642f64180aa3', abi: [],
      eventMock: { address: '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512', abi: [] } }));
    const port = await new Promise<number>((resolve, reject) => {
      const socket = createServer();
      socket.once('error', reject);
      socket.listen(0, '127.0.0.1', () => {
        const port = (socket.address() as { port: number }).port;
        socket.close(() => resolve(port));
      });
    });
    base = `https://localhost:${port}`;
    environment = { ...process.env, MONGODB_URI: uri.toString(), CHAIN: 'off', PORT: String(port),
      TLS_KEY_FILE: certificates.key, TLS_CERT_FILE: certificates.cert,
      DEPLOYMENT_FILE: deployment, REGISTRY_NAMESPACE: '', NODE_EXTRA_CA_CERTS: ca };
    delete environment.NODE_TEST_CONTEXT;
    delete environment.NODE_TLS_REJECT_UNAUTHORIZED;
    await run(process.execPath, ['seed.ts']);
    await connectDB(uri.toString());
    child = spawn(process.execPath, ['server.ts'], {
      cwd: serverDirectory, env: environment, stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout!.on('data', data => { output += data; });
    child.stderr!.on('data', data => { output += data; });
    child.once('error', error => { output += error.message; });
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`HTTPS server exited ${child.exitCode}\n${output}`);
      if (await httpsStatus(true).catch(() => 0)) return;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error(`HTTPS server did not start\n${output}`);
  });

  after(async () => {
    try {
      if (child && child.exitCode === null) {
        const exited = once(child, 'exit');
        const timeout = setTimeout(() => child!.kill('SIGKILL'), 5000);
        child.kill('SIGTERM');
        await exited;
        clearTimeout(timeout);
        assert.equal(child.exitCode, 0, output);
      }
    } finally {
      if (mongoose.connection.readyState === 1) await mongoose.connection.dropDatabase();
      await disconnectDB();
      if (directory) rmSync(directory, { recursive: true, force: true });
    }
  });

  test('requires a trusted certificate and rejects unauthenticated requests over HTTPS', async () => {
    await assert.rejects(httpsStatus(false), /certificate|self.signed|issuer/i);
    assert.equal(await httpsStatus(true), 401);
  });

  test("passes Sergey's unchanged nine provider contract tests over verified HTTPS", async () => {
    const result = await run(process.execPath, ['--test', '--test-reporter=tap', 'test/client-contract.test.ts'],
      { ...environment, SERVER_URL: base, TEST_API_KEY: 'dev', TEST_JOB_ID: '1' });
    assert.match(result, /# tests 9\b/, result);
    assert.match(result, /# pass 9\b/, result);
    assert.match(result, /# fail 0\b/, result);
  });

  test('the actual Python client posts benchmarks and fetches its manifest with certificate verification', async () => {
    const result = await run(process.env.TEST_PYTHON ?? 'python3', ['-c', `
import os, sys
sys.path.insert(0, os.environ['CLIENT_DIRECTORY'])
import requests
from benchmark.Scores import Scores
from server.ServerManager import ServerManager

client = ServerManager(os.environ['SERVER_URL'], 'dev')
try:
    assert client.session.verify is True
    client.post_benchmark(Scores(cpu=234567.5, gpu=None, memory=8192.25))
    manifest = client.getDockerManifest(1)
    assert manifest['jobId'] == 1
    assert manifest['image'].startswith('docker.io/library/alpine@sha256:')
    assert manifest['command'] == ['sh', '-c', 'echo "result for job 1" > /output/result.txt']
    assert manifest['cpu_limit'] == 1
    assert manifest['mem_limit_mb'] == 256
    client.request('POST', '/provider/heartbeat')
    client.set_access_token('invalid-token')
    try:
        client.getDockerManifest(1)
    except requests.HTTPError as error:
        assert error.response.status_code == 401
    else:
        raise AssertionError('invalid token was accepted')
    print('PYTHON_HTTPS_CLIENT_OK')
finally:
    client.close()
`], { ...environment, SERVER_URL: base, REQUESTS_CA_BUNDLE: ca,
      CLIENT_DIRECTORY: path.join(serverDirectory, '..', 'client'), PYTHONDONTWRITEBYTECODE: '1',
      NO_PROXY: 'localhost,127.0.0.1', no_proxy: 'localhost,127.0.0.1' });
    assert.match(result, /PYTHON_HTTPS_CLIENT_OK/);
    const hardware = await HardwareModel.findOne({ cpuScore: 234567.5 });
    assert.ok(hardware, 'Python benchmark must be persisted by the real MongoDB-backed route');
    assert.equal(hardware.memoryScore, 8192.25);
    assert.equal(hardware.gpuScore, null);
  });
});
