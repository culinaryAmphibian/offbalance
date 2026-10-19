import { readFile } from 'node:fs/promises';
import { createServer, type ServerOptions } from 'node:https';
import type { RequestListener } from 'node:http';
import { createSecureContext } from 'node:tls';
import path from 'node:path';

export type CertificatePaths = { keyFile: string; certFile: string };

export function certificatePaths(): CertificatePaths {
  const keyFile = process.env.TLS_KEY_FILE;
  const certFile = process.env.TLS_CERT_FILE;
  if (Boolean(keyFile) !== Boolean(certFile)) throw new Error('Set both TLS_KEY_FILE and TLS_CERT_FILE.');
  const directory = path.join(import.meta.dirname, '.local', 'tls');
  return { keyFile: keyFile ?? path.join(directory, 'key.pem'), certFile: certFile ?? path.join(directory, 'cert.pem') };
}

export async function httpsOptions(paths = certificatePaths()): Promise<ServerOptions> {
  try {
    const [key, cert] = await Promise.all([readFile(paths.keyFile), readFile(paths.certFile)]);
    const options: ServerOptions = { key, cert, minVersion: 'TLSv1.2' };
    createSecureContext(options);
    return options;
  } catch (error) {
    throw new Error('Cannot load HTTPS certificates. Run `npm run cert:dev` for local development, or set TLS_KEY_FILE and TLS_CERT_FILE.', { cause: error });
  }
}

export function createHttpsServer(app: RequestListener, options: ServerOptions) {
  // Certificate/key validation happens before opening the listener.
  return createServer(options, app);
}
