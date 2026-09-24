import {
  expect,
  type APIRequestContext,
  type Browser,
  type BrowserContext,
  type Page,
} from '@playwright/test';

/**
 * Shared machinery for the end-to-end suite.
 *
 * Two rules shape everything here.
 *
 * Sessions are established once, in `auth.setup.ts`, and replayed from a saved
 * storage state. Login is rate limited to ten attempts per IP per five minutes
 * (`auth:login`), and a suite that signed in per test would spend its whole
 * budget on plumbing and then fail with 429s that look like product bugs.
 *
 * Setup data is created through `page.request`, which carries the browser
 * context's session cookies. That costs no extra login, and it keeps the
 * browser assertions about the screen under test rather than about the six
 * records it needed to exist first.
 */

export const PASSWORD = process.env.DEMO_PASSWORD ?? 'DemoPass123!';

export const ACCOUNTS = {
  admin: 'admin@example.com',
  resident: 'resident@example.com',
  officer: 'officer@example.com',
} as const;

export type Role = keyof typeof ACCOUNTS;

export function storageStatePath(role: Role): string {
  return `tests/e2e/.auth/${role}.json`;
}

/**
 * Sign in through the real form.
 *
 * The retry is not flake-hiding. The form has no `action`, so a click that
 * lands before React has hydrated submits it natively: the browser simply
 * reloads /login with the fields cleared, no request reaches the API, and no
 * login attempt is spent. Waiting for the network to settle first makes that
 * rare; the loop makes it harmless.
 */
export async function signIn(page: Page, email: string, password = PASSWORD): Promise<void> {
  await page.goto('/login', { waitUntil: 'networkidle' });

  for (let attempt = 0; attempt < 3; attempt += 1) {
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Password').fill(password);
    const submitted = page
      .waitForResponse((response) => response.url().includes('/api/v1/auth/login'), {
        timeout: 15_000,
      })
      .then(() => true)
      .catch(() => false);

    await page.getByRole('button', { name: 'Sign in' }).click();

    if (await submitted) return;
  }

  throw new Error(`The login form never reached the API for ${email}.`);
}

/**
 * A browser context already holding a role's session.
 *
 * Every failing API call the screens make is printed. A screen that renders
 * "Something went wrong" tells you nothing about which request died; this makes
 * the difference between a product bug and a flaky dev server visible in the
 * run output instead of guessable from a screenshot.
 */
export async function contextFor(browser: Browser, role: Role): Promise<BrowserContext> {
  const context = await browser.newContext({ storageState: storageStatePath(role) });

  context.on('response', (response) => {
    const url = response.url();
    if (url.includes('/api/') && response.status() >= 400) {
      console.log(`  [${role}] ${response.status()} ${response.request().method()} ${url}`);
    }
  });

  return context;
}

/**
 * Thin wrapper over the JSON API using whatever session the given request
 * context carries. Unwraps the `{ success, data }` envelope and fails loudly,
 * so a broken fixture never masquerades as a broken assertion.
 */
export function api(request: APIRequestContext) {
  async function unwrap(
    method: string,
    path: string,
    response: Awaited<ReturnType<APIRequestContext['get']>>,
  ) {
    const body = (await response.json().catch(() => null)) as {
      success?: boolean;
      data?: unknown;
      error?: { code?: string; message?: string };
    } | null;

    if (!response.ok() || body?.success !== true) {
      throw new Error(
        `${method} ${path} → ${response.status()} ${body?.error?.code ?? ''} ${body?.error?.message ?? ''}`.trim(),
      );
    }

    return body.data;
  }

  return {
    async get<T>(path: string): Promise<T> {
      const response = await request.get(`/api/v1${path}`);
      return (await unwrap('GET', path, response)) as T;
    },
    async post<T>(path: string, data: unknown = {}): Promise<T> {
      const response = await request.post(`/api/v1${path}`, { data });
      return (await unwrap('POST', path, response)) as T;
    },
    async patch<T>(path: string, data: unknown = {}): Promise<T> {
      const response = await request.patch(`/api/v1${path}`, { data });
      return (await unwrap('PATCH', path, response)) as T;
    },
    /** For the cases where the failure itself is the thing being asserted. */
    raw: request,
  };
}

/** `datetime-local` inputs take local wall-clock time with no zone, unlike an ISO string. */
export function datetimeLocalValue(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

/**
 * A suffix unique to one test run.
 *
 * The demo data is reseeded freely, so nothing may be matched by a name that
 * happens to be in it today. Every record a test needs is created by that test
 * and found again by this.
 */
export function unique(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

/** The membership id of whoever holds this session. */
export async function myMembershipId(request: APIRequestContext): Promise<string> {
  const profile = await api(request).get<{ membershipId: string }>('/me/profile');
  expect(profile.membershipId, 'the signed-in account has a membership').toBeTruthy();
  return profile.membershipId;
}

/** The first gate, needed by anything that records a movement. */
export async function firstGateId(request: APIRequestContext): Promise<string> {
  const gates = await api(request).get<Array<{ id: string }>>('/gates');
  expect(gates.length, 'the estate has at least one gate configured').toBeGreaterThan(0);
  return gates[0]!.id;
}
