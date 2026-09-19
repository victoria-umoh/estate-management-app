/**
 * Enforce JavaScript bundle budgets.
 *
 * Reads the production build manifest, gzips each emitted chunk, and fails when
 * a budget in bundle-budget.json is exceeded.
 *
 * The shared budget is the important one: every route pays it, so anything that
 * leaks into the shared chunk is charged to the gate scanner — the screen that
 * has to stay fast on a cheap tablet over a poor connection. A number nobody
 * checks will drift, so this runs as part of `pnpm build`.
 *
 *   pnpm budget
 */
import { gzipSync } from 'node:zlib';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const NEXT_DIR = '.next';
const MANIFEST = join(NEXT_DIR, 'app-build-manifest.json');
const BUDGET_FILE = 'bundle-budget.json';

if (!existsSync(MANIFEST)) {
  console.error(`No build manifest at ${MANIFEST}. Run "pnpm build" first.`);
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
const budgets = JSON.parse(readFileSync(BUDGET_FILE, 'utf8'));

/** Gzipped size of an emitted asset, in bytes. Cached across routes. */
const sizeCache = new Map();

function gzippedSize(file) {
  if (sizeCache.has(file)) return sizeCache.get(file);

  const path = join(NEXT_DIR, file);
  // CSS is budgeted separately; this guard is about JavaScript, which is what
  // blocks interactivity.
  const size = existsSync(path) && file.endsWith('.js') ? gzipSync(readFileSync(path)).length : 0;

  sizeCache.set(file, size);
  return size;
}

const kb = (bytes) => Math.round((bytes / 1024) * 10) / 10;

// A route's entry is the union of its own chunks and the layout chunks it
// inherits, which is what the browser actually downloads on first load.
const layoutFiles = new Set(manifest.pages['/layout'] ?? []);

const routes = Object.entries(manifest.pages)
  .filter(([route]) => route !== '/layout')
  .map(([route, files]) => {
    const all = new Set([...layoutFiles, ...files]);
    return {
      route: route.replace(/\/page$/, '') || '/',
      files: all,
      bytes: [...all].reduce((total, file) => total + gzippedSize(file), 0),
    };
  });

if (routes.length === 0) {
  console.error('Build manifest contains no routes. Did the build succeed?');
  process.exit(1);
}

// Shared = the files every route loads. This is the figure that must not drift.
const sharedFiles = [...routes[0].files].filter((file) =>
  routes.every((route) => route.files.has(file)),
);
const sharedBytes = sharedFiles.reduce((total, file) => total + gzippedSize(file), 0);

const failures = [];

console.log('\nBundle budget (gzipped JavaScript)\n');
console.log(
  `  shared by all routes   ${String(kb(sharedBytes)).padStart(7)} kB  / ${budgets.shared} kB`,
);

if (kb(sharedBytes) > budgets.shared) {
  failures.push(
    `Shared bundle is ${kb(sharedBytes)} kB, over the ${budgets.shared} kB budget.\n` +
      `    Every route pays this, including the gate scanner.\n` +
      `    Largest shared chunks:\n` +
      sharedFiles
        .map((file) => ({ file, size: gzippedSize(file) }))
        .sort((a, b) => b.size - a.size)
        .slice(0, 5)
        .map((entry) => `      ${kb(entry.size).toString().padStart(7)} kB  ${entry.file}`)
        .join('\n'),
  );
}

console.log('');
for (const { route, bytes } of routes.sort((a, b) => b.bytes - a.bytes)) {
  const budget = budgets.routes[route] ?? budgets.routes.default;
  const over = kb(bytes) > budget;

  console.log(
    `  ${over ? 'FAIL' : '  ok'}  ${String(kb(bytes)).padStart(7)} kB / ${String(budget).padStart(4)} kB  ${route}`,
  );

  if (over) {
    failures.push(`Route ${route} is ${kb(bytes)} kB, over its ${budget} kB budget.`);
  }
}

if (failures.length > 0) {
  console.error('\nBudget exceeded:\n');
  for (const failure of failures) console.error(`  - ${failure}\n`);
  console.error(
    'Either move the offending import behind a dynamic() boundary, or raise the\n' +
      'budget in bundle-budget.json with a reason recorded in docs/OUTPUT_LOGS.md.\n',
  );
  process.exit(1);
}

console.log('\nAll bundles within budget.\n');
