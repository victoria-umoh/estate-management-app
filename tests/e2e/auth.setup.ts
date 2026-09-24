import { existsSync, statSync } from 'node:fs';
import { expect, request as apiRequest, test as setup } from '@playwright/test';
import { ACCOUNTS, signIn, storageStatePath, type Role } from './helpers';

/**
 * Sign each role in once and save the session for the rest of the suite.
 *
 * Login is capped at ten attempts per IP per five minutes, so a login per test
 * would spend the budget on plumbing and then report 429s that look like
 * product failures. Three roles, once per run, sits comfortably inside it.
 *
 * A saved session is reused only while it has real time left on it. Access
 * tokens last fifteen minutes; they used to last until the year 58699, because
 * `setExpirationTime` was being handed milliseconds where it wanted seconds,
 * and a state saved once worked for the rest of the day. With that fixed, a
 * state that merely answers a request *now* can still expire midway through a
 * four-minute spec — which is what it did, and the run ended on the sign-in
 * screen with a timeout that said nothing about why.
 */
const REUSE_WITHIN_MS = 5 * 60 * 1000;

// Serial, not parallel: three simultaneous logins against a cold dev server
// produced 500s from /auth/login, and they spend the per-IP budget in one burst
// either way.
setup.describe.configure({ mode: 'serial' });

for (const role of Object.keys(ACCOUNTS) as Role[]) {
  setup(`authenticate as ${role}`, async ({ page, baseURL }) => {
    const path = storageStatePath(role);

    // Old enough that it could lapse mid-run, so replace it now rather than
    // halfway through a spec.
    const savedRecently =
      existsSync(path) && Date.now() - statSync(path).mtimeMs < REUSE_WITHIN_MS;

    if (savedRecently) {
      const saved = await apiRequest.newContext({
        storageState: path,
        ...(baseURL ? { baseURL } : {}),
      });
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
