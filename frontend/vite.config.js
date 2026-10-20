import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync, existsSync } from 'node:fs';
import https from 'node:https';
import { fileURLToPath } from 'node:url';

export default defineConfig(({ mode }) => {
  const environment = { ...loadEnv(mode, import.meta.dirname, ''), ...process.env };
  const target = environment.API_PROXY_TARGET || 'https://localhost:5000';
  const certificate = environment.API_CA_FILE || fileURLToPath(new URL('../server/.local/tls/cert.pem', import.meta.url));
  if (!target.startsWith('https://')) throw new Error('API_PROXY_TARGET must use HTTPS.');
  const agent = new https.Agent(existsSync(certificate) ? { ca: readFileSync(certificate) } : {});
  return {
    plugins: [react()],
    server: { proxy: { '/api': { target, agent, secure: true, rewrite: path => path.replace(/^\/api(?=\/|$)/, '') || '/' } } },
  };
});
