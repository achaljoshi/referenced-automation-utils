import { defineConfig } from '@playwright/test';
import { loadEnv } from './src/config/env';

// This package has no UI/API of its own to point at an environment, but it
// still loads .env.<ENV> the same way every consuming repo will, so its own
// tests exercise the real loadEnv() contract end-to-end.
loadEnv();

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { open: 'never' }], ['junit', { outputFile: 'test-results/junit.xml' }]],
});
