/**
 * Every navigation link must resolve to a page that exists.
 *
 * This exists because the app once offered twenty-four menu items against six
 * screens. Eighteen links went to 404s, and nothing caught it: the tests
 * exercised services, the build only compiles what is imported, and a menu
 * entry imports nothing.
 *
 * Static, so it runs without a server or a database — `pnpm build` can gate on
 * it. `pnpm smoke` separately proves those pages actually render; this proves
 * they exist at all.
 *
 *   pnpm nav:check
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const NAV = join(ROOT, 'src/components/layout/navigation.ts');
const APP = join(ROOT, 'src/app');

/**
 * Route groups are invisible in a URL, so a link to `/dashboard` may live at
 * `(app)/dashboard` — every group has to be tried.
 */
const GROUPS = ['', '(app)', '(marketing)', '(auth)'];

const source = readFileSync(NAV, 'utf8');

/**
 * Each nav item, with whether it is flagged `planned`.
 *
 * A flagged item is deliberately absent — `visibleNavigation()` filters it out,
 * so it cannot be clicked. It is checked in reverse: if the page now exists,
 * the flag is stale and should be removed, or the menu hides a screen that was
 * built.
 */
const items = [...source.matchAll(/\{[^{}]*href:\s*'([^']+)'[^{}]*\}/g)].map((match) => ({
  href: match[1],
  planned: /planned:\s*true/.test(match[0]),
}));

if (items.length === 0) {
  console.error('No navigation items found — has navigation.ts moved?');
  process.exit(1);
}

function pageExists(href) {
  const relative = href.replace(/^\//, '');

  return GROUPS.some((group) =>
    ['page.tsx', 'page.ts'].some((file) => existsSync(join(APP, group, relative, file))),
  );
}

const missing = [];
const staleFlags = [];

for (const { href, planned } of items) {
  const exists = pageExists(href);

  if (!planned && !exists) missing.push(href);
  if (planned && exists) staleFlags.push(href);
}

for (const href of missing) {
  console.error(`  MISSING  ${href}  — offered in the menu, no page file`);
}
for (const href of staleFlags) {
  console.error(`  STALE    ${href}  — flagged 'planned' but the page exists; drop the flag`);
}

const planned = items.filter((item) => item.planned).length;

if (missing.length === 0 && staleFlags.length === 0) {
  console.log(
    `Navigation: ${items.length - planned} live links all resolve` +
      (planned > 0 ? `, ${planned} flagged as planned` : '') +
      '.',
  );
  process.exit(0);
}

console.error(`\n${missing.length + staleFlags.length} navigation problem(s).`);
process.exit(1);
