// Component tests (React in jsdom): `npm run test:components`. The plain-module tests in
// test/*.test.js stay on node --test (`npm test`); only test/components/*.spec.jsx run here.
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    include: ['test/components/**/*.spec.jsx'],
  },
});
