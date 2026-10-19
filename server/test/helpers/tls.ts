import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';

/** An isolated CA and localhost server certificate; clients must trust this CA explicitly. */
export function testCertificates(directory: string): { ca: string; key: string; cert: string } {
  const file = (name: string) => path.join(directory, name);
  const openssl = (...args: string[]) => execFileSync('openssl', args, { stdio: 'pipe' });
  const ca = file('ca.pem');
  const key = file('key.pem');
  const cert = file('cert.pem');
  openssl('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-subj', '/CN=OffBalance integration test CA', '-keyout', file('ca-key.pem'), '-out', ca,
    '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign');
  openssl('req', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=localhost',
    '-keyout', key, '-out', file('server.csr'));
  writeFileSync(file('server.ext'), [
    'subjectAltName=DNS:localhost,IP:127.0.0.1',
    'basicConstraints=critical,CA:FALSE',
    'keyUsage=critical,digitalSignature,keyEncipherment',
    'extendedKeyUsage=serverAuth',
  ].join('\n'));
  openssl('x509', '-req', '-in', file('server.csr'), '-CA', ca, '-CAkey', file('ca-key.pem'),
    '-CAcreateserial', '-days', '1', '-extfile', file('server.ext'), '-out', cert);
  return { ca, key, cert };
}
