import { defineConfig, devices } from '@playwright/test';

/**
 * Matches the dev server's default port.
 *
 * It pointed at 3000 while `pnpm dev` reads PORT from .env and runs on 3800, so
 * every run started a second server rather than reusing the one already up —
 * and two Next servers sharing one .next directory destroy each other's build
 * output.
 */
const BASE_URL = process.env.E2E_BASE_URL ?? `http://127.0.0.1:${process.env.PORT ?? 3800}`;

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: [['html', { open: 'never' }], ['list']],
  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    { name: 'desktop-chrome', use: { ...devices['Desktop Chrome'] } },
    { name: 'tablet', use: { ...devices['iPad (gen 7)'] } },
    { name: 'mobile', use: { ...devices['iPhone 13'] } },
  ],
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: 'pnpm dev',
        url: BASE_URL,
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
      },
});
