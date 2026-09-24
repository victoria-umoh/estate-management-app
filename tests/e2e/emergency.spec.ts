import { expect, test } from '@playwright/test';
import { api, contextFor, myMembershipId, unique } from './helpers';

/**
 * Workflow 6 — a panic alert from raised to resolved.
 *
 * The alert is raised over the API because there is no panic control anywhere
 * in the web interface — `POST /api/v1/emergencies` is reachable only from a
 * native client today. Everything the responder does is driven on screen.
 */
test('an emergency reaches the security desk and can be acknowledged and resolved', async ({
  browser,
}) => {
  const residentContext = await contextFor(browser, 'resident');
  const officerContext = await contextFor(browser, 'officer');
  const residentPage = await residentContext.newPage();
  const officer = await officerContext.newPage();

  const location = unique('Block');
  const membershipId = await myMembershipId(residentPage.request);

  const raised = await api(residentPage.request).post<{ reference: string }>('/emergencies', {
    membershipId,
    type: 'security',
    description: 'End-to-end drill',
    location,
  });

  // --- It is the first thing the desk shows --------------------------------

  await officer.goto('/security');
  await expect(officer.getByText(raised.reference)).toBeVisible();
  await expect(officer.getByText(location)).toBeVisible();

  // --- Acknowledged --------------------------------------------------------

  await officer.goto('/security/emergencies');

  // The innermost block that carries this alert's reference and its own
  // controls, so a second alert on the desk cannot be acted on by mistake.
  const card = officer
    .locator('div')
    .filter({ hasText: raised.reference })
    .filter({ has: officer.getByRole('button', { name: 'Resolve' }) })
    .last();

  await expect(card).toContainText('not yet acknowledged');
  await card.getByRole('button', { name: 'Acknowledge' }).click();

  await expect(card).toContainText('acknowledged');
  // Disabled rather than removed. On a life-safety screen the controls keep
  // their positions so a responder's muscle memory is not rearranged mid-
  // incident; the state shows in the button being dead, not absent.
  await expect(card.getByRole('button', { name: 'Acknowledge' })).toBeDisabled();

  // --- Resolved, with the written outcome the record requires --------------

  await card.getByRole('button', { name: 'Resolve' }).click();
  const dialog = officer.getByRole('dialog', { name: 'Resolve this emergency' });
  await dialog.getByLabel('Outcome').fill('Drill completed, no action needed');
  await dialog.getByRole('button', { name: 'Resolve' }).click();

  await expect(officer.getByRole('dialog')).toBeHidden();

  // Off the live board after a reload: the board carries what is still open,
  // and the "closed in this session" card only holds it until then.
  await officer.reload();
  await expect(officer.getByRole('heading', { name: 'Emergencies' })).toBeVisible();
  await expect(officer.getByText(raised.reference)).toHaveCount(0);

  const resolved = await api(officer.request).get<Array<{ reference: string }>>(
    '/emergencies?status=resolved',
  );
  expect(
    resolved.some((item) => item.reference === raised.reference),
    'the alert is recorded as resolved',
  ).toBe(true);

  await residentContext.close();
  await officerContext.close();
});
