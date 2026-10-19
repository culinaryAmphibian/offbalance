import test from 'node:test';
import assert from 'node:assert/strict';
import { get, type RequestOptions } from 'node:https';
import type { AddressInfo } from 'node:net';
import { createHttpsServer, httpsOptions } from '../https.ts';
import { testCertificates } from '../agent-manager/test/certificates.js';

function read(url: string, options: RequestOptions = {}): Promise<number | undefined> {
  return new Promise((resolve, reject) => {
    get(url, options, response => { response.resume(); response.once('end', () => resolve(response.statusCode)); })
      .once('error', reject);
  });
}

test('HTTPS requires a trusted certificate, valid hostname, and encrypted requests', async () => {
  const certificates = testCertificates();
  const server = createHttpsServer((_req, res) => { res.end('ok'); }, { key: certificates.key, cert: certificates.cert });
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const url = `https://127.0.0.1:${port}`;
    assert.equal(await read(url, { ca: certificates.cert }), 200);
    await assert.rejects(read(url), { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' });
    await assert.rejects(read(url, { ca: certificates.cert, servername: 'unrelated.invalid' }), { code: 'ERR_TLS_CERT_ALTNAME_INVALID' });
    await assert.rejects(fetch(`http://127.0.0.1:${port}`));
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    certificates.close();
  }
});

test('HTTPS startup reports missing certificate configuration and never falls back to HTTP', async () => {
  await assert.rejects(httpsOptions({ keyFile: '/offbalance-no-key', certFile: '/offbalance-no-cert' }), /npm run cert:dev/);
  assert.throws(() => createHttpsServer((_req, res) => res.end(), { key: 'invalid', cert: 'invalid' }));
});
