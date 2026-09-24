import { expect, test } from '@playwright/test';
import { contextFor, datetimeLocalValue, unique } from './helpers';

/**
 * Workflow 2 — a visitor from invitation to departure.
 *
 * Every step is driven through the interface that step's user actually has:
 * the resident's pass dialog, the officer's gate scanner, the security desk's
 * "currently inside" list, and the scanner again on the way out. Nothing here
 * calls the API to move the story along, because the point is to prove those
 * four screens are wired to each other.
 */
test('a resident invites a visitor, the gate admits them, and checkout closes the visit', async ({
  browser,
}) => {
  const visitorName = unique('Visitor');

  const residentContext = await contextFor(browser, 'resident');
  const officerContext = await contextFor(browser, 'officer');
  const resident = await residentContext.newPage();
  const officer = await officerContext.newPage();

  // --- The resident creates the pass ---------------------------------------

  await resident.goto('/my/visitors');
  await resident.getByRole('button', { name: 'New pass' }).click();

  const dialog = resident.getByRole('dialog', { name: 'Invite a visitor' });
  await dialog.getByLabel('Visitor name').fill(visitorName);
  await dialog.getByLabel('Purpose of visit').fill('End-to-end test visit');

  const now = new Date();
  await dialog
    .getByLabel('Expected arrival')
    .fill(datetimeLocalValue(new Date(now.getTime() - 15 * 60_000)));
  await dialog
    .getByLabel('Expected departure')
    .fill(datetimeLocalValue(new Date(now.getTime() + 4 * 60 * 60_000)));

  await dialog.getByRole('button', { name: 'Create pass' }).click();

  // The receipt is the only place the gate code is presented large; reading it
  // from there is exactly what the resident does before phoning their guest.
  const codeButton = resident.getByRole('button', { name: /^Copy gate code/ }).first();
  await expect(codeButton).toBeVisible();
  const code = (await codeButton.textContent())?.trim().replace(/\s+/g, '') ?? '';
  expect(code, 'the receipt shows a gate code').toMatch(/^[A-Z0-9]{4,12}$/);

  // --- The officer admits them at the gate ---------------------------------

  await officer.goto('/security/scan');
  await officer.getByRole('tab', { name: 'Code' }).click();
  await officer.getByLabel('Visitor code').fill(code);
  await officer.getByRole('button', { name: 'Check code' }).click();

  // `role="status"` on the result panel is what an officer glancing up relies
  // on, so it is what the test reads too.
  const scanResult = officer.locator('[role="status"]');
  await expect(scanResult).toContainText('Admit');
  await expect(scanResult).toContainText(visitorName);

  // --- The desk shows them inside ------------------------------------------

  await officer.goto('/security');
  // The desk shows the same name in two lists — who is inside, and what just
  // happened at the gate. They are named, so this asks for the one it means.
  const insideRow = officer
    .getByRole('list', { name: 'Currently inside' })
    .locator('li')
    .filter({ hasText: visitorName });
  await expect(insideRow).toContainText('inside');

  // --- Checkout closes the visit -------------------------------------------

  await officer.goto('/security/scan');
  await officer.getByRole('button', { name: 'Exit' }).click();
  await officer.getByRole('tab', { name: 'Code' }).click();
  await officer.getByLabel('Visitor code').fill(code);
  await officer.getByRole('button', { name: 'Check code' }).click();
  await expect(officer.locator('[role="status"]')).toContainText('Admit');

  await officer.goto('/security');
  await expect(officer.getByText(visitorName)).toBeHidden();

  await resident.goto('/my/visitors');
  const row = resident.locator('li').filter({ hasText: visitorName });
  // `completed` is the terminal status in VisitorPassStatus; there is no
  // 'checked-out'. The visit is over, which is what the resident needs to see.
  await expect(row).toContainText('completed');

  await residentContext.close();
  await officerContext.close();
});
