import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { X509Certificate } from 'node:crypto';

const directory = path.join(import.meta.dirname, '..', '.local', 'tls');
const keyFile = path.join(directory, 'key.pem');
const certFile = path.join(directory, 'cert.pem');
const exists = async (file: string) => {
  try { await stat(file); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
};
await mkdir(directory, { recursive: true, mode: 0o700 });
const existing = await Promise.all([exists(keyFile), exists(certFile)]);
if (existing.some(Boolean) && !process.argv.includes('--force')) {
  if (!existing.every(Boolean)) throw new Error('Incomplete development certificate pair; rerun with --force to replace it.');
  console.log('Keeping existing development certificate. Use --force to replace it.');
} else {
  const temporary = await mkdtemp(path.join(directory, '.generate-'));
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', path.join(temporary, 'key.pem'), '-out', path.join(temporary, 'cert.pem'),
      '-days', '30', '-subj', '/CN=localhost',
      '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
      '-addext', 'extendedKeyUsage=serverAuth'], { stdio: 'ignore' });
    await chmod(path.join(temporary, 'key.pem'), 0o600);
    await rename(path.join(temporary, 'key.pem'), keyFile);
    await rename(path.join(temporary, 'cert.pem'), certFile);
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
const certificate = new X509Certificate(await readFile(certFile));
if (!certificate.checkHost('localhost') || !certificate.checkIP('127.0.0.1') || Date.parse(certificate.validTo) <= Date.now()) {
  throw new Error('Development certificate is expired or invalid for localhost; rerun with --force.');
}
console.log(`Certificate: ${certFile}\nPrivate key: ${keyFile}\nTrust this certificate for local clients; certificate verification stays enabled.`);
