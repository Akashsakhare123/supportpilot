import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests (T14): the real dashboard, API, worker and widget started by `pnpm dev`
 * (reused when already running locally). Locally the installed Microsoft Edge is used, so no
 * browser download is needed; CI installs Playwright's Chromium.
 */
export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/wait-for-servers.ts',
  timeout: 120_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL: 'http://localhost:3000',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], channel: process.env.CI ? undefined : 'msedge' },
    },
  ],
  webServer: {
    command: 'pnpm dev',
    url: 'http://localhost:3000/login',
    reuseExistingServer: !process.env.CI,
    timeout: 300_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
