import { request as apiRequest, test as warm } from '@playwright/test';
import { storageStatePath, type Role } from './helpers';

/**
 * Touch every route the suite uses, once, before any test runs.
 *
 * This exists because of an application bug, not to hide one: the FIRST request
 * to a freshly compiled route returns 500. `defineRoute` calls
 * `ensureBootstrapped()`, whose `bootstrap()` reaches `registerNotificationHandlers()`,
 * which emits a log line — and in the bundled server graph pino cannot resolve
 * the `pino-pretty` transport that `LOG_PRETTY=true` asks for, so it throws:
 *
 *   Error: unable to determine transport target for "pino-pretty"
 *
 * `bootstrap()` sets its `done` flag before the throw, so the second request
 * gets through. Without this warm-up every screen the suite opens for the first
 * time renders "Something went wrong", and the report is a list of 500s rather
 * than a statement about the workflows.
 *
 * Anything that needs more than one attempt is printed, so the bug stays
 * visible in every run.
 */
const PAGES: Array<[Role, string]> = [
  ['resident', '/dashboard'],
  ['resident', '/my/visitors'],
  ['resident', '/my/exit-passes'],
  ['resident', '/my/payments'],
  ['resident', '/my/id'],
  ['officer', '/security'],
  ['officer', '/security/scan'],
  ['officer', '/security/passes'],
  ['officer', '/security/emergencies'],
  ['admin', '/admin/residents'],
];

const ENDPOINTS: Array<[Role, string]> = [
  ['resident', '/api/v1/me/profile'],
  ['resident', '/api/v1/me/visitors?limit=1'],
  ['resident', '/api/v1/me/invoices?limit=1'],
  ['resident', '/api/v1/exit-passes?limit=1'],
  ['resident', '/api/v1/notifications?limit=1'],
  ['officer', '/api/v1/gates'],
  ['officer', '/api/v1/security/inside'],
  ['officer', '/api/v1/security/activity?limit=1'],
  ['officer', '/api/v1/emergencies'],
  ['officer', '/api/v1/temporary-passes?limit=1'],
  ['admin', '/api/v1/estate'],
  ['admin', '/api/v1/residents?limit=1'],
  ['admin', '/api/v1/invoices?limit=1'],
  ['admin', '/api/v1/audit?limit=1'],
  ['admin', '/api/v1/search?q=aa'],
  ['admin', '/api/v1/dashboard'],
];

warm('warm every route the suite touches', async ({ baseURL }) => {
  // Cold-compiling two dozen routes in `next dev` is slow, and this runs once.
  warm.setTimeout(900_000);

  const roles = ['admin', 'resident', 'officer'] as Role[];
  const all = [...PAGES, ...ENDPOINTS];

  // One role at a time within a role, all three roles at once: the routes are
  // independent, and compiling them serially would take three times as long.
  await Promise.all(
    roles.map(async (role) => {
      const context = await apiRequest.newContext({
        storageState: storageStatePath(role),
        ...(baseURL ? { baseURL } : {}),
      });

      for (const [owner, path] of all) {
        if (owner !== role) continue;

        let attempts = 0;
        let status = 0;

        while (attempts < 4) {
          attempts += 1;
          status = (await context.get(path)).status();
          if (status < 500) break;
        }

        if (attempts > 1 || status >= 500) {
          console.log(`  ${status} after ${attempts} attempt(s): ${role} ${path}`);
        }
      }

      await context.dispose();
    }),
  );
});
