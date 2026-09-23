import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { expect, test } from '@playwright/test';
import { api, contextFor, firstGateId, unique } from './helpers';

const run = promisify(execFile);

/**
 * Workflow 3 — a visitor who stays past their departure time.
 *
 * The sweep only raises a pass once it is past its departure *plus* the
 * estate's grace period, which defaults to an hour. Rather than wait an hour or
 * reach into the database, the test sets the grace to zero for its duration —
 * the same knob an administrator has on the settings screen — and restores it
 * afterwards.
 *
 * The gate refuses a pass whose departure has already passed, so the check-in
 * has to happen while the window is still open: the pass is created with a few
 * seconds of life, admitted immediately, and left to expire.
 */
test('an overstaying visitor is raised by the sweep and surfaces on the security desk', async ({
  browser,
}) => {
  // The pass has to live long enough to be admitted and then expire, and the
  // sweep is a separate process spawn on top of that.
  test.setTimeout(240_000);

  const visitorName = unique('Overstayer');

  const adminContext = await contextFor(browser, 'admin');
  const officerContext = await contextFor(browser, 'officer');
  const residentContext = await contextFor(browser, 'resident');

  const adminPage = await adminContext.newPage();
  const officerPage = await officerContext.newPage();
  const residentPage = await residentContext.newPage();

  const admin = api(adminPage.request);
  const officer = api(officerPage.request);
  const resident = api(residentPage.request);

  const before = await admin.get<{ settings: { visitorOverstayGraceMinutes: number } }>('/estate');
  const originalGrace = before.settings.visitorOverstayGraceMinutes;

  try {
    await admin.patch('/estate', { visitorOverstayGraceMinutes: 0 });

    // The gate is resolved first: the pass's window is deliberately short, and
    // anything done between creating it and admitting the visitor eats into it.
    const gateId = await firstGateId(officerPage.request);

    // `/security/inside` reports `overstaying` from whole minutes past
    // departure, so the pass has to be at least a minute stale before anything
    // — screen or sweep — will call it an overstay.
    const departure = new Date(Date.now() + 20_000);
    const pass = await resident.post<{ id: string; code: string }>('/me/visitors', {
      visitorName,
      purpose: 'Overstay sweep check',
      expectedArrival: new Date(Date.now() - 60_000).toISOString(),
      expectedDeparture: departure.toISOString(),
    });

    const admitted = await officer.post<{ admitted: boolean }>('/gate/code', {
      code: pass.code,
      gateId,
      direction: 'in',
    });
    expect(admitted.admitted, 'the gate admitted the visitor before their window closed').toBe(true);

    // Waits on the server's own view of the pass rather than on a clock in the
    // test: once it reports the visitor as overstaying, the sweep has something
    // to find.
    await expect
      .poll(
        async () => {
          const inside = await officer.get<Array<{ code: string; overstaying: boolean }>>(
            '/security/inside',
          );
          return inside.find((visitor) => visitor.code === pass.code)?.overstaying ?? false;
        },
        { timeout: 180_000, intervals: [2_000] },
      )
      .toBe(true);

    const { stdout } = await run('pnpm', ['job:overstay'], {
      cwd: process.cwd(),
      timeout: 120_000,
    });
    expect(stdout).toBeTruthy();

    // The sweep's own record that it acted on this pass, as opposed to the
    // screen merely computing "past departure" for itself.
    const audit = await admin.get<Array<{ metadata?: { code?: string } }>>(
      '/audit?action=visitor.overstayed&limit=50',
    );
    expect(
      audit.some((entry) => entry.metadata?.code === pass.code),
      'the overstay sweep recorded this pass',
    ).toBe(true);

    await officerPage.goto('/security');
    await expect(
      officerPage.getByRole('heading', { name: 'Overstaying visitors' }),
    ).toBeVisible();
    // The innermost element carrying both the visitor and their code — the row
    // an officer would read.
    const row = officerPage
      .locator('div')
      .filter({ hasText: pass.code })
      .filter({ hasText: visitorName })
      .last();
    await expect(row).toContainText('over');
  } finally {
    await admin.patch('/estate', { visitorOverstayGraceMinutes: originalGrace });
    await adminContext.close();
    await officerContext.close();
    await residentContext.close();
  }
});
