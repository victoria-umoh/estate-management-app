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
  /**
   * Two, not "as many as there are cores".
   *
   * Against `next dev` a wider fan-out compiles a dozen routes at once, and the
   * requests waiting behind that compile hit Mongoose's 10s buffering timeout
   * and come back as 500s — failures that read like product bugs and are not.
   * The specs are still independent and parallel-safe.
   */
  workers: process.env.CI ? 1 : 2,
  reporter: [['html', { open: 'never' }], ['list']],
  /**
   * Generous, because these run against `next dev`: the first visit to a route
   * compiles it, which can take tens of seconds, and a timeout there reports as
   * a product failure rather than as a cold cache.
   */
  timeout: 120_000,
  expect: { timeout: 20_000 },
  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    /**
     * Signs in once per role and saves the session.
     *
     * Login is rate limited to ten attempts per IP in five minutes, so the
     * suite cannot afford a sign-in per test — every other project depends on
     * this one and replays its storage state.
     */
    { name: 'setup', testMatch: /auth\.setup\.ts/ },
    /** See tests/e2e/warm.setup.ts — it documents the bug this works around. */
    { name: 'warmup', testMatch: /warm\.setup\.ts/, dependencies: ['setup'] },
    {
      name: 'desktop-chrome',
      use: { ...devices['Desktop Chrome'] },
      dependencies: ['setup', 'warmup'],
    },
    { name: 'tablet', use: { ...devices['iPad (gen 7)'] }, dependencies: ['setup', 'warmup'] },
    { name: 'mobile', use: { ...devices['iPhone 13'] }, dependencies: ['setup', 'warmup'] },
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
