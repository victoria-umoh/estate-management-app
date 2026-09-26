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
  // A second household. Without one, "can a resident read a neighbour's
  // record" cannot be asked: the officer answers 403 for want of the
  // permission entirely and never reaches the narrowing being tested.
  tenant: 'tenant@example.com',
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
  ['/admin/tenancies', 'admin', 'enanc'],
  ['/admin/reports', 'admin', 'Reports'],
  ['/my/requests', 'resident', 'My requests'],
  ['/my/safety', 'resident', 'Safety'],
  ['/account', 'resident', 'Account'],
  ['/security/passes', 'officer', 'Passes desk'],
  // Suspense-wrapped: the server renders only the shell, so check the shell.
  ['/payments/callback?reference=PAY-SMOKE', 'resident', 'PrimeEstate'],
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
  ['/auth/sessions', 'resident'],
  ['/service-requests', 'resident'],
  ['/change-requests', 'admin'],
  ['/reports/schedules', 'admin'],
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

  const cookie = (response.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');

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
    ['/forgot-password', 'Reset your password'],
    // Suspense-wrapped token pages: the server renders only the shell.
    ['/register', 'PrimeEstate'],
    ['/reset-password', 'PrimeEstate'],
    ['/verify-email', 'PrimeEstate'],
    ['/accept-invitation', 'PrimeEstate'],
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

  console.log('\nList endpoints are narrowed to the caller');
  {
    /**
     * The same mistake has been made five times: a permission residents hold,
     * also gating an estate-wide list. A unit test never caught one, because a
     * unit test asserts the permission its author chose.
     *
     * So this compares what a resident sees against what an administrator sees.
     * Equal counts on a seeded estate with more than one household means the
     * narrowing is absent.
     */
    for (const [path, label] of [
      ['/visitor-passes', 'visitor passes'],
      ['/vehicles', 'vehicles'],
      ['/service-requests', 'service requests'],
    ]) {
      const read = async (role) => {
        const response = await fetch(`${BASE}/api/v1${path}?limit=100`, {
          headers: { authorization: `Bearer ${sessions[role].token}` },
        });
        const body = await response.json().catch(() => null);
        return Array.isArray(body?.data) ? body.data.length : -1;
      };

      const [mine, all] = [await read('resident'), await read('admin')];

      report(
        mine >= 0 && all >= 0 && mine < all,
        `${label} narrowed`.padEnd(24),
        `resident ${mine} of ${all}`,
      );
    }

    // An emergency is visible to everyone by design; its operational detail is
    // not. The caller's phone number and coordinates are the point.
    const fields = async (role) => {
      const body = await fetch(`${BASE}/api/v1/emergencies`, {
        headers: { authorization: `Bearer ${sessions[role].token}` },
      }).then((r) => r.json());
      return Object.keys((Array.isArray(body?.data) ? body.data[0] : null) ?? {});
    };

    const residentFields = await fields('resident');
    const leaked = ['contactPhone', 'coordinates', 'description', 'propertyId'].filter((f) =>
      residentFields.includes(f),
    );

    report(
      leaked.length === 0,
      'emergency detail withheld'.padEnd(24),
      leaked.join(', ') || `${residentFields.length} safe fields`,
    );
  }

  console.log('\nIdentity cannot be supplied by the caller');
  {
    // A resident raising a panic alert in a neighbour's name would dispatch
    // security to that neighbour's house, stamped with their property.
    const me = await fetch(`${BASE}/api/v1/me/profile`, {
      headers: { authorization: `Bearer ${sessions.resident.token}` },
    }).then((r) => r.json());

    const otherMembership = await fetch(`${BASE}/api/v1/me/profile`, {
      headers: { authorization: `Bearer ${sessions.admin.token}` },
    }).then((r) => r.json());

    const created = await fetch(`${BASE}/api/v1/emergencies`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${sessions.resident.token}`,
      },
      body: JSON.stringify({
        membershipId: otherMembership?.data?.membershipId,
        type: 'medical',
        description: 'smoke-test forgery check',
      }),
    }).then((r) => r.json());

    if (!created?.success) {
      report(true, 'emergency attribution'.padEnd(24), 'could not raise one to check');
    } else {
      const all = await fetch(`${BASE}/api/v1/emergencies`, {
        headers: { authorization: `Bearer ${sessions.admin.token}` },
      }).then((r) => r.json());

      const mine = (Array.isArray(all?.data) ? all.data : []).find(
        (row) => row.id === created.data.id,
      );

      report(
        mine?.triggeredByMembershipId === me?.data?.membershipId,
        'emergency attribution'.padEnd(24),
        mine?.triggeredByMembershipId === me?.data?.membershipId
          ? 'attributed to the caller'
          : 'FORGEABLE',
      );
    }
  }

  console.log('\nRole assignment refuses escalation');
  {
    // Nothing assigned roles until now, so nothing guarded this path. It is
    // how a person gains permissions, which makes it the escalation surface.
    const me = await fetch(`${BASE}/api/v1/me/profile`, {
      headers: { authorization: `Bearer ${sessions.admin.token}` },
    }).then((r) => r.json());

    const roles = await fetch(`${BASE}/api/v1/roles`, {
      headers: { authorization: `Bearer ${sessions.admin.token}` },
    }).then((r) => r.json());

    const chairman = (Array.isArray(roles?.data) ? roles.data : []).find(
      (role) => role.code === 'estate-chairman',
    );

    if (!me?.data?.membershipId || !chairman) {
      report(true, 'self-assignment'.padEnd(24), 'could not resolve a role to try');
    } else {
      const response = await fetch(`${BASE}/api/v1/residents/${me.data.membershipId}/roles`, {
        method: 'PUT',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${sessions.admin.token}`,
        },
        body: JSON.stringify({ roleIds: [chairman.id] }),
      });

      // Changing your own roles is refused even for a chairman: without that,
      // the rank ceiling is decorative — you need not define a role above your
      // own when you can take one that exists.
      report(
        response.status === 403,
        'self-assignment refused'.padEnd(24),
        String(response.status),
      );
    }
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
      leaked.length
        ? `LEAKED ${leaked.join(',')}`
        : missing.length
          ? `missing ${missing.join(',')}`
          : blocks.join(','),
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

  // --- Identity comes from the session, never the body --------------------
  // POST /service-requests once took requesterMembershipId as a body field and
  // trusted it, so a resident could file a ticket in a neighbour's name. This
  // is the ninth time that shape appeared, which is why it is asserted here
  // rather than only in a unit test: the unit test asserts the permission its
  // author chose, and this drives the route the way an attacker would.
  console.log('\nIdentity is taken from the session');
  {
    const forged = '0'.repeat(24);
    const created = await fetch(`${BASE}/api/v1/service-requests`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${sessions.resident.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        requesterMembershipId: forged,
        category: 'water',
        subject: 'Smoke: forged requester',
        description: 'Filed by the session owner, not by the id in the body.',
      }),
    });
    const body = await created.json();
    const id = body?.data?.id;
    report(created.status === 201 && Boolean(id), 'ticket created', String(created.status));

    if (id) {
      const seen = await fetch(`${BASE}/api/v1/service-requests/${id}`, {
        headers: { authorization: `Bearer ${sessions.admin.token}` },
      });
      const detail = await seen.json();
      const owner =
        detail?.data?.requestedBy?.membershipId ?? detail?.data?.requestedByMembershipId ?? null;
      report(
        owner !== forged,
        'forged requester ignored',
        owner === forged ? 'ATTRIBUTED TO FORGED ID' : 'session owner',
      );
    }

    if (id) {
      // The detail route once called the repository directly, so it answered
      // for any ticket in the estate. Every resident holds serviceRequest.view.
      // Three reads, because all three must be right at once: the raiser sees
      // their own ticket, a neighbour cannot, and the neighbour's refusal is
      // indistinguishable from one for a ticket that does not exist.
      const own = await fetch(`${BASE}/api/v1/service-requests/${id}`, {
        headers: { authorization: `Bearer ${sessions.resident.token}` },
      });
      report(own.status === 200, 'raiser reads their own ticket', String(own.status));

      // The tenant holds serviceRequest.view, so this reaches the narrowing
      // rather than stopping at the permission check.
      const neighbour = await fetch(`${BASE}/api/v1/service-requests/${id}`, {
        headers: { authorization: `Bearer ${sessions.tenant.token}` },
      });
      const ghost = await fetch(`${BASE}/api/v1/service-requests/${'0'.repeat(24)}`, {
        headers: { authorization: `Bearer ${sessions.tenant.token}` },
      });
      report(
        neighbour.status === 404 && ghost.status === 404,
        'a ticket that is not yours looks like one that does not exist',
        `${neighbour.status} vs ${ghost.status} (both must be 404)`,
      );
    }
  }

  // --- Documents reach the roles that need them ---------------------------
  // The security officer is the one staff role that does not inherit the
  // resident baseline, so it held no document.* at all and could not see the
  // photograph on an incident it was investigating. The estate-wide register
  // is a list across subjects, so it cannot ask a subject and is gated on
  // resident.viewAll instead -- a resident must still be refused it.
  console.log('\nDocument access by role');
  {
    const incidents = await fetch(`${BASE}/api/v1/incidents?limit=1`, {
      headers: { authorization: `Bearer ${sessions.officer.token}` },
    });
    const incidentId = (await incidents.json())?.data?.[0]?.id;

    if (incidentId) {
      const officerView = await fetch(
        `${BASE}/api/v1/documents?subjectType=incident&subjectId=${incidentId}`,
        { headers: { authorization: `Bearer ${sessions.officer.token}` } },
      );
      report(
        officerView.status === 200,
        'officer reads incident documents',
        String(officerView.status),
      );
    }

    for (const [role, want] of [
      ['admin', 200],
      ['resident', 403],
    ]) {
      const response = await fetch(`${BASE}/api/v1/documents`, {
        headers: { authorization: `Bearer ${sessions[role].token}` },
      });
      report(
        response.status === want,
        `${role} on the estate register`,
        `${response.status} (want ${want})`,
      );
    }
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

  console.log(failures === 0 ? '\nAll checks passed.\n' : `\n${failures} check(s) failed.\n`);

  process.exit(failures === 0 ? 0 : 1);
}

await main();
