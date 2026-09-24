import { expect, test } from '@playwright/test';
import { contextFor, unique } from './helpers';

/**
 * Workflow 5 — goods leaving the estate.
 *
 * Declare, approve, verify at the barrier, close — and then the part that
 * matters most: the same code offered a second time must be refused. An exit
 * pass is single-use because it is the only record that a specific load left
 * once; a code that still works after the goods have gone is the whole control
 * defeated.
 */
test('an exit pass is approved, spent at the gate, and refused on a second attempt', async ({
  browser,
}) => {
  const carrier = unique('Carrier');

  const residentContext = await contextFor(browser, 'resident');
  const approverContext = await contextFor(browser, 'admin');
  const officerContext = await contextFor(browser, 'officer');

  const resident = await residentContext.newPage();
  const approver = await approverContext.newPage();
  const officer = await officerContext.newPage();

  // --- The household declares the manifest ---------------------------------

  await resident.goto('/my/exit-passes');
  await resident.getByRole('button', { name: 'New pass' }).click();

  const dialog = resident.getByRole('dialog', { name: 'Declare goods leaving' });
  await dialog.getByLabel('Who is carrying it').fill(carrier);
  await dialog.getByLabel('Where it is going').fill('Ikeja workshop');
  await dialog.getByLabel('Why').fill('Repair');
  await dialog.getByLabel('Qty').fill('2');
  await dialog.getByLabel('Description').fill('Office chair');
  await dialog.getByLabel('Identifying mark').fill('Blue, torn armrest');
  await dialog.getByRole('button', { name: 'Raise pass' }).click();

  // The receipt names the code in prose, which is also how the resident reads
  // it out to the carrier.
  const receipt = resident.getByText(/^Pass [A-Z0-9]+ raised$/);
  await expect(receipt).toBeVisible();
  const code = (await receipt.textContent())?.match(/Pass ([A-Z0-9]+) raised/)?.[1] ?? '';
  expect(code, 'the raised pass has a code').toMatch(/^[A-Z0-9]{4,12}$/);

  const row = resident.locator('li').filter({ hasText: carrier });
  await expect(row).toContainText('awaiting approval');

  // --- An approver locks the manifest --------------------------------------

  await approver.goto('/security/passes');
  const pendingRow = approver.locator('li').filter({ hasText: carrier });
  await expect(pendingRow).toContainText(code);
  await pendingRow.getByRole('button', { name: 'Approve' }).click();
  await approver.getByRole('dialog').getByRole('button', { name: 'Approve' }).click();

  // --- The gate checks the load and closes the pass ------------------------

  await officer.goto('/security/passes');
  await officer.getByLabel('Pass code').fill(code);
  await officer.getByRole('button', { name: 'Check' }).click();

  await expect(officer.getByText('Valid', { exact: true })).toBeVisible();
  // The manifest has to be on screen, or the officer cannot check the load.
  await expect(officer.getByText('Office chair')).toBeVisible();

  await officer.getByRole('button', { name: 'Goods have left — close pass' }).click();
  await officer.getByRole('dialog').getByRole('button', { name: 'Close pass' }).click();

  // --- The same code, a second time ----------------------------------------

  await officer.getByLabel('Pass code').fill(code);
  await officer.getByRole('button', { name: 'Check' }).click();

  await expect(officer.getByText('Do not release')).toBeVisible();
  await expect(officer.getByRole('button', { name: 'Goods have left — close pass' })).toBeHidden();

  await residentContext.close();
  await approverContext.close();
  await officerContext.close();
});
