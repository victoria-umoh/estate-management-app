import { existsSync } from 'node:fs';
import { expect, request as apiRequest, test as setup } from '@playwright/test';
import { ACCOUNTS, signIn, storageStatePath, type Role } from './helpers';

/**
 * Sign each role in once and save the session for the rest of the suite.
 *
 * A saved session that still works is reused rather than replaced. Login is
 * capped at ten attempts per IP per five minutes, and re-running the suite
 * while iterating would otherwise exhaust that budget and fill the report with
 * 429s that look like product failures.
 */

// Serial, not parallel: three simultaneous logins against a cold dev server
// produced 500s from /auth/login, and they spend the per-IP budget in one burst
// either way.
setup.describe.configure({ mode: 'serial' });

for (const role of Object.keys(ACCOUNTS) as Role[]) {
  setup(`authenticate as ${role}`, async ({ page, baseURL }) => {
    const path = storageStatePath(role);

    if (existsSync(path)) {
      const saved = await apiRequest.newContext({ storageState: path, ...(baseURL ? { baseURL } : {}) });
      // Only a 401 means the session is gone. A 500 means the server is having
      // a bad day (see warm.setup.ts), and throwing the session away for that
      // spends a login attempt from a budget of ten per five minutes.
      const stillValid = (await saved.get('/api/v1/me/profile')).status() !== 401;
      await saved.dispose();
      if (stillValid) return;
    }

    await signIn(page, ACCOUNTS[role]);

    // The form redirects to /dashboard on success. Waiting on the URL rather
    // than on a spinner means a failed login fails here with the server's own
    // message still on screen.
    await page.waitForURL('**/dashboard', { timeout: 60_000 });
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

    await page.context().storageState({ path });
  });
}
