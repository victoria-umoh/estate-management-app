/**
 * Drive every screen and every API route as a real signed-in user.
 *
 * This exists because the unit suite went green for ten phases while most of
 * the app was unreachable: the tests exercised services directly, so a screen
 * that 404s, an endpoint nobody wired up, and a page whose fetch shape was
 * wrong all passed unnoticed. Anything that renders HTML or answers JSON is
 * checked here against a running server, signed in, per role.
 *
 *   pnpm smoke                    # against http://localhost:3800
 *   BASE_URL=... pnpm smoke
 */
const BASE = process.env.BASE_URL ?? 'http://localhost:3800';
const PASSWORD = process.env.DEMO_PASSWORD ?? 'DemoPass123!';

const ACCOUNTS = {
  admin: 'admin@example.com',
  resident: 'resident@example.com',
  officer: 'officer@example.com',
};

/**
 * Screens: path, the role that uses it, and a string that must appear in the
 * rendered HTML.
 *
 * The text matters. A 200 proves the route resolved, not that it rendered
 * anything — a page whose component threw during render can still return a
 * shell. Asserting the heading is the cheapest way to tell a working screen
 * from an empty one.
 */
const SCREENS = [
  ['/dashboard', 'resident', 'Dashboard'],
  ['/my/id', 'resident', 'ID'],
  ['/my/payments', 'resident', 'My payments'],
  ['/my/visitors', 'resident', 'isitor'],
  ['/my/household', 'resident', 'ousehold'],
  ['/my/property', 'resident', 'roperty'],
  ['/my/vehicles', 'resident', 'ehicle'],
  ['/security', 'officer', 'Security desk'],
  ['/security/scan', 'officer', 'can'],
  ['/security/activity', 'officer', 'ctivity'],
  ['/security/emergencies', 'officer', 'mergenc'],
  ['/admin/residents', 'admin', 'esident'],
  ['/admin/properties', 'admin', 'ropert'],
  ['/admin/vehicles', 'admin', 'ehicle'],
  ['/admin/incidents', 'admin', 'ncident'],
  ['/admin/requests', 'admin', 'equest'],
  ['/admin/finance', 'admin', 'Finance'],
  ['/admin/audit', 'admin', 'udit'],
  ['/admin/roles', 'admin', 'ole'],
  ['/admin/settings', 'admin', 'etting'],
];

/**
 * Detail screens, resolved from a live id.
 *
 * Kept separate because the id has to be fetched first — a hardcoded one would
 * rot at the next reseed, and a detail page is exactly where a shape mismatch
 * between the list projection and the detail projection shows up.
 */
const DETAIL_SCREENS = [
  ['/residents', '/admin/residents', 'admin', 'membershipId'],
  ['/properties', '/admin/properties', 'admin', 'id'],
  ['/incidents', '/admin/incidents', 'admin', 'id'],
];

/** GET endpoints, with the role that should be allowed. */
const ENDPOINTS = [
  ['/me/profile', 'resident'],
  ['/me/property', 'resident'],
  ['/me/vehicles', 'resident'],
  ['/me/household', 'resident'],
  ['/me/visitors', 'resident'],
  ['/me/invoices', 'resident'],
  ['/residents', 'admin'],
  ['/properties', 'admin'],
  ['/vehicles', 'admin'],
  ['/incidents', 'admin'],
  ['/service-requests', 'admin'],
  ['/emergencies', 'officer'],
  ['/security/activity', 'officer'],
  ['/security/inside', 'officer'],
  ['/gates', 'officer'],
  ['/invoices', 'admin'],
  ['/fees', 'admin'],
  ['/ledger', 'admin'],
  ['/audit', 'admin'],
  ['/roles', 'admin'],
  ['/estate', 'admin'],
  ['/notifications', 'resident'],
  ['/notifications/preferences', 'resident'],
  ['/announcements', 'resident'],
  ['/exit-passes', 'resident'],
  ['/temporary-passes', 'officer'],
  ['/search?q=Ada', 'admin'],
  ['/subscription', 'admin'],
  ['/dashboard', 'resident'],
];

/**
 * Reads a resident must never be allowed.
 *
 * This is the regression guard for the permission leak found in the finance
 * phase, where `invoice.view` was doing double duty and every household's
 * billing history was readable by any resident.
 */
const MUST_REFUSE = [
  ['/invoices', 'resident'],
  ['/ledger', 'resident'],
  ['/fees', 'resident'],
  ['/audit', 'resident'],
];

/**
 * Fields that must never appear in a resident-visible list.
 *
 * Residents can read the estate directory by design — names and unit numbers.
 * This guards the boundary of that decision: a projection that quietly grows a
 * phone number or an identity field turns a directory into a contact dump.
 */
const DIRECTORY_FORBIDDEN = ['phone', 'email', 'nin', 'ninMasked', 'dateOfBirth', 'address'];

let failures = 0;

function report(ok, label, detail = '') {
  if (!ok) failures++;
  const mark = ok ? '  ok  ' : ' FAIL ';
  console.log(`${mark} ${label}${detail ? `  ${detail}` : ''}`);
}

async function login(email) {
  const response = await fetch(`${BASE}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    // `client: 'web'` is what makes the route set session cookies; without it
    // only the bearer tokens come back and every screen bounces to /login.
    body: JSON.stringify({ email, password: PASSWORD, client: 'web' }),
  });

  if (!response.ok) throw new Error(`login failed for ${email}: ${response.status}`);

  const cookie = (response.headers.getSetCookie?.() ?? [])
    .map((c) => c.split(';')[0])
    .join('; ');

  if (!cookie) throw new Error(`no session cookie set for ${email}`);

  // Native clients get a bearer token instead, so that is fetched separately.
  // Screens are checked by cookie and endpoints by bearer, which is how each
  // is actually reached in production.
  const native = await fetch(`${BASE}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  const body = await native.json();

  // Login is rate limited per IP. Without this check an exhausted limit gives
  // every later request an undefined token, and the run reports a dozen
  // plausible-looking permission failures instead of the one real cause.
  if (!native.ok || !body?.data?.tokens?.accessToken) {
    const reason = body?.error?.code ?? native.status;
    throw new Error(
      native.status === 429
        ? `Login rate limit hit (${reason}). Wait for the window to clear and re-run.`
        : `Could not get a bearer token for ${email}: ${reason}`,
    );
  }

  return { token: body.data.tokens.accessToken, cookie };
}

async function main() {
  console.log(`\nSmoke test against ${BASE}\n`);

  const sessions = {};
  for (const [role, email] of Object.entries(ACCOUNTS)) {
    sessions[role] = await login(email);
    report(true, `signed in as ${role.padEnd(9)}`, email);
  }

  console.log('\nPublic pages (no session)');
  for (const [path, expected] of [
    ['/', 'PrimeEstate'],
    ['/pricing', 'Professional'],
    ['/login', 'ign in'],
  ]) {
    const response = await fetch(`${BASE}${path}`, { redirect: 'manual' });
    const html = response.ok ? await response.text() : '';
    report(
      response.status === 200 && html.includes(expected),
      path.padEnd(24),
      `${response.status}${html.includes(expected) ? '' : ` missing "${expected}"`}`,
    );
  }

  console.log('\nScreens (server-rendered, as the role that uses them)');
  for (const [path, role, expected] of SCREENS) {
    const response = await fetch(`${BASE}${path}`, {
      headers: { cookie: sessions[role].cookie },
      redirect: 'manual',
    });

    const html = response.ok ? await response.text() : '';
    // A 200 that redirected to login, or that rendered Next's error boundary,
    // is not a working screen.
    const bounced = response.status >= 300 && response.status < 400;
    const errored = html.includes('__next_error__') || html.includes('Application error');
    const hasContent = html.includes(expected);

    const why = bounced
      ? 'redirected'
      : errored
        ? 'render error'
        : !hasContent
          ? `missing "${expected}"`
          : '';

    report(
      response.status === 200 && !bounced && !errored && hasContent,
      path.padEnd(24),
      `${response.status} ${why} (${role})`.replace('  ', ' '),
    );
  }

  console.log('\nDetail screens (id resolved live)');
  for (const [listPath, screenBase, role, idField] of DETAIL_SCREENS) {
    const list = await fetch(`${BASE}/api/v1${listPath}?limit=1`, {
      headers: { authorization: `Bearer ${sessions[role].token}` },
    }).then((r) => r.json());

    const first = Array.isArray(list?.data) ? list.data[0] : undefined;
    if (!first) {
      report(true, `${screenBase}/:id`.padEnd(24), 'nothing seeded to open');
      continue;
    }

    const path = `${screenBase}/${first[idField]}`;
    const response = await fetch(`${BASE}${path}`, {
      headers: { cookie: sessions[role].cookie },
      redirect: 'manual',
    });
    const html = response.ok ? await response.text() : '';
    const errored = html.includes('__next_error__') || html.includes('Application error');

    report(
      response.status === 200 && !errored,
      `${screenBase}/:id`.padEnd(24),
      `${response.status}${errored ? ' render error' : ''}`,
    );
  }

  console.log('\nEndpoints');
  for (const [path, role] of ENDPOINTS) {
    const response = await fetch(`${BASE}/api/v1${path}`, {
      headers: { authorization: `Bearer ${sessions[role].token}` },
    });
    const body = await response.json().catch(() => null);

    report(
      response.ok && body?.success === true,
      path.padEnd(24),
      `${response.status} ${body?.error?.code ?? ''} (${role})`,
    );
  }

  console.log('\nMust be refused (permission regression guard)');
  for (const [path, role] of MUST_REFUSE) {
    const response = await fetch(`${BASE}/api/v1${path}`, {
      headers: { authorization: `Bearer ${sessions[role].token}` },
    });
    const body = await response.json().catch(() => null);

    report(
      response.status === 403 || response.status === 404,
      `${role} → ${path}`.padEnd(24),
      `${response.status} ${body?.error?.code ?? 'ALLOWED — LEAK'}`,
    );
  }

  console.log('\nAccess tokens are short-lived');
  {
    // The context resolver performs no database lookup on the strength of this
    // bound. `setExpirationTime` once received milliseconds where it wanted
    // seconds, and every token expired in the year 58699 — unbounded, and
    // therefore unrevocable.
    const [, payload] = sessions.admin.token.split('.');
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    const minutes = (claims.exp - claims.iat) / 60;

    report(
      minutes > 0 && minutes <= 24 * 60,
      'token lifetime'.padEnd(24),
      `${Math.round(minutes)} minutes`,
    );
  }

  console.log('\nA resident cannot read another household\u2019s full record');
  {
    const all = await fetch(`${BASE}/api/v1/residents?limit=25`, {
      headers: { authorization: `Bearer ${sessions.admin.token}` },
    }).then((r) => r.json());

    const mine = await fetch(`${BASE}/api/v1/me/profile`, {
      headers: { authorization: `Bearer ${sessions.resident.token}` },
    }).then((r) => r.json());

    const stranger = (Array.isArray(all?.data) ? all.data : []).find(
      (row) => row.membershipId !== mine?.data?.membershipId,
    );

    if (!stranger) {
      report(true, 'stranger detail'.padEnd(24), 'only one resident seeded');
    } else {
      const response = await fetch(`${BASE}/api/v1/residents/${stranger.membershipId}`, {
        headers: { authorization: `Bearer ${sessions.resident.token}` },
      });

      // 404 rather than 403: confirming the membership exists is itself a
      // disclosure in a directory of this kind.
      report(response.status === 404, 'stranger detail 404'.padEnd(24), String(response.status));
    }
  }

  console.log('\nIncidents are narrowed to the caller without incident.viewAll');
  {
    const asAdmin = await fetch(`${BASE}/api/v1/incidents?limit=50`, {
      headers: { authorization: `Bearer ${sessions.admin.token}` },
    }).then((r) => r.json());
    const asResident = await fetch(`${BASE}/api/v1/incidents?limit=50`, {
      headers: { authorization: `Bearer ${sessions.resident.token}` },
    }).then((r) => r.json());

    const all = Array.isArray(asAdmin?.data) ? asAdmin.data : [];
    const mine = Array.isArray(asResident?.data) ? asResident.data : [];

    report(
      mine.length <= all.length,
      'resident sees fewer'.padEnd(24),
      `resident ${mine.length} of ${all.length}`,
    );

    // The detail of an incident a resident had no part in must 404, not 403 —
    // confirming it exists still tells them it happened.
    const foreign = all.find((incident) => !mine.some((own) => own.id === incident.id));
    if (foreign) {
      const detail = await fetch(`${BASE}/api/v1/incidents/${foreign.id}`, {
        headers: { authorization: `Bearer ${sessions.resident.token}` },
      });
      report(detail.status === 404, 'foreign detail 404'.padEnd(24), String(detail.status));
    } else {
      report(true, 'foreign detail 404'.padEnd(24), 'no foreign incident seeded');
    }
  }

  console.log('\nDashboard blocks are scoped to the caller');
  for (const [role, allowed, forbidden] of [
    ['resident', ['resident'], ['estate', 'finance', 'security']],
    ['officer', ['security'], ['estate', 'finance']],
    ['admin', ['estate', 'finance', 'security'], []],
  ]) {
    const response = await fetch(`${BASE}/api/v1/dashboard`, {
      headers: { authorization: `Bearer ${sessions[role].token}` },
    });
    const body = await response.json().catch(() => null);
    const blocks = Object.keys(body?.data ?? {});

    const missing = allowed.filter((b) => !blocks.includes(b));
    const leaked = forbidden.filter((b) => blocks.includes(b));

    report(
      missing.length === 0 && leaked.length === 0,
      `${role} dashboard`.padEnd(24),
      leaked.length ? `LEAKED ${leaked.join(',')}` : missing.length ? `missing ${missing.join(',')}` : blocks.join(','),
    );
  }

  console.log('\nResident directory exposes no contact details');
  {
    const response = await fetch(`${BASE}/api/v1/residents?limit=5`, {
      headers: { authorization: `Bearer ${sessions.resident.token}` },
    });
    const body = await response.json().catch(() => null);
    const rows = Array.isArray(body?.data) ? body.data : [];
    const leaked = DIRECTORY_FORBIDDEN.filter((field) =>
      rows.some((row) => row[field] !== undefined && row[field] !== null),
    );
    report(leaked.length === 0, 'no contact fields', leaked.join(', ') || `${rows.length} rows`);
  }

  console.log('\nWebhook signature');
  for (const [label, headers] of [
    ['unsigned', {}],
    ['forged  ', { 'x-paystack-signature': 'f'.repeat(128) }],
  ]) {
    const response = await fetch(`${BASE}/api/webhooks/paystack`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ event: 'charge.success', data: { id: 1, reference: 'X' } }),
    });
    report(response.status === 401, `${label} rejected`, String(response.status));
  }

  console.log(
    failures === 0
      ? '\nAll checks passed.\n'
      : `\n${failures} check(s) failed.\n`,
  );

  process.exit(failures === 0 ? 0 : 1);
}

await main();
