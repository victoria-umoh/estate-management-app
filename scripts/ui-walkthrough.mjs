/**
 * Drive the security screens in a real browser.
 *
 * Compilation proves nothing about whether an officer can actually admit a
 * visitor, so this signs in through the login form, admits a visitor by code on
 * the gate screen, and checks the security desk reflects it.
 */
import { chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';

// Seeded inside the run, not beforehand. A pass admitted by a previous run is
// correctly refused a second check-in, which would otherwise read as a product
// failure when it is the harness repeating itself.
const seedOutput = execFileSync('pnpm', ['seed:ui'], { encoding: 'utf8' });
const seed = JSON.parse(seedOutput.slice(seedOutput.indexOf('{'), seedOutput.lastIndexOf('}') + 1));
const BASE = 'http://localhost:3410';

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 420, height: 900 },
  // The gate screen asks for a camera; granting it avoids a permission prompt
  // blocking the run. The code path being tested is the manual fallback.
  permissions: ['camera'],
});
const page = await context.newPage();

const failures = [];
function check(label, condition, detail = '') {
  console.log(`  ${condition ? '  ok' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!condition) failures.push(label);
}

// --- Sign in ----------------------------------------------------------------
await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
await page.getByLabel('Email').fill(seed.email);
await page.getByLabel('Password').fill(seed.password);
await page.getByRole('button', { name: /sign in/i }).click();

await page.waitForURL(/\/dashboard/, { timeout: 15_000 }).catch(() => {});
check('signs in and reaches the dashboard', page.url().includes('/dashboard'), page.url());

// The session must be an httpOnly cookie the page cannot read.
const cookies = await context.cookies();
const accessCookie = cookies.find((cookie) => cookie.name === 'eos_at');
check('sets an httpOnly session cookie', accessCookie?.httpOnly === true);

const tokenInStorage = await page.evaluate(() =>
  JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }),
);
check(
  'stores no token in browser storage',
  !tokenInStorage.includes('eyJ') && !tokenInStorage.includes(seed.visitorToken.slice(0, 20)),
);

// --- Gate scanner: admit a visitor by code ----------------------------------
await page.goto(`${BASE}/security/scan`, { waitUntil: 'networkidle' });
check('gate scanner loads', page.url().includes('/security/scan'));

await page.getByRole('tab', { name: 'Code' }).click();
await page.getByLabel('Visitor code').fill(seed.visitorCode);
await page.getByRole('button', { name: /check code/i }).click();

await page
  .getByText('Admit.', { exact: true })
  .waitFor({ timeout: 10_000 })
  .catch(() => {});
check('admits a valid visitor code', await page.getByText('Admit.', { exact: true }).isVisible());
check('shows the visitor name', await page.getByText('Chidi Okafor').isVisible());

await page.screenshot({ path: '/tmp/ui-shots/scan-admitted.png', fullPage: true });

// --- A refused scan ---------------------------------------------------------
await page.getByRole('button', { name: 'Next', exact: true }).click();
await page.getByRole('tab', { name: 'Code' }).click();
await page.getByLabel('Visitor code').fill('ZZZZZZ');
await page.getByRole('button', { name: /check code/i }).click();

await page
  .getByText(/not recognised/i)
  .waitFor({ timeout: 10_000 })
  .catch(() => {});
check('refuses an unknown code', await page.getByText(/not recognised/i).isVisible());

await page.screenshot({ path: '/tmp/ui-shots/scan-denied.png', fullPage: true });

// --- Security desk ----------------------------------------------------------
await page.goto(`${BASE}/security`, { waitUntil: 'networkidle' });
await page
  .getByText('Chidi Okafor')
  .first()
  .waitFor({ timeout: 10_000 })
  .catch(() => {});

check(
  'security desk shows the visitor as inside',
  await page.getByText('Chidi Okafor').first().isVisible(),
);
check(
  'security desk shows gate activity',
  await page.getByText(/recent gate activity/i).isVisible(),
);

await page.screenshot({ path: '/tmp/ui-shots/security-desk.png', fullPage: true });

// --- Responsive check -------------------------------------------------------
for (const [label, width] of [
  ['mobile', 320],
  ['tablet', 820],
]) {
  await page.setViewportSize({ width, height: 900 });
  await page.goto(`${BASE}/security/scan`, { waitUntil: 'networkidle' });

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  check(`no horizontal overflow at ${label} (${width}px)`, overflow === 0, `${overflow}px`);

  await page.screenshot({ path: `/tmp/ui-shots/scan-${label}.png`, fullPage: true });
}

await browser.close();

if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed:\n`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log('\nAll UI checks passed.\n');
