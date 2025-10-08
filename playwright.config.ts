import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './packages/demo/e2e',
  workers: 1,
  globalSetup: './packages/demo/e2e/global-setup.ts',
  globalTeardown: './packages/demo/e2e/global-teardown.ts',
  timeout: process.env.CI ? 60 * 1000 : 30 * 1000, // 60s for CI, 30s locally
  expect: {
    timeout: 5000,
  },
  use: {
    headless: true,
    viewport: { width: 1280, height: 720 },
    actionTimeout: 10 * 1000,
    ignoreHTTPSErrors: true,
    video: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { browserName: 'chromium' },
    },
  ],
});