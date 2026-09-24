import { expect, test } from '@playwright/test';
import { api, contextFor, myMembershipId, unique } from './helpers';

/**
 * Workflow 4 — paying an invoice.
 *
 * The assertion that matters is the negative one. Coming back from the
 * provider's checkout page proves nothing: the payer controls that redirect.
 * An invoice may only flip to paid when the webhook lands and the amount has
 * been re-verified, so this test walks the resident all the way to checkout and
 * then insists the invoice is still outstanding — on the screen and in the API.
 */
test('checkout does not mark an invoice paid on the browser redirect alone', async ({
  browser,
}) => {
  const adminContext = await contextFor(browser, 'admin');
  const residentContext = await contextFor(browser, 'resident');
  const adminPage = await adminContext.newPage();
  const residentPage = await residentContext.newPage();

  const admin = api(adminPage.request);
  const resident = api(residentPage.request);

  const membershipId = await myMembershipId(residentPage.request);
  const description = unique('E2E due');

  const invoice = await admin.post<{ id: string; number: string }>('/invoices', {
    membershipId,
    lines: [{ description, quantity: 1, unitAmount: 250_000 }],
    dueAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
  });
  await admin.post(`/invoices/${invoice.id}/issue`);

  await residentPage.goto('/my/payments');

  const row = residentPage.locator('li').filter({ hasText: invoice.number });
  await expect(row).toBeVisible();
  await expect(row).toContainText(/issued|overdue|due/i);

  // Clicking Pay hands the browser to the provider. In this environment that is
  // the offline provider's own checkout stub, which is enough: what is under
  // test is what the estate does when the browser comes back, not what the
  // provider's page looks like.
  await row.getByRole('button', { name: 'Pay' }).click();
  await residentPage.waitForURL(/reference=/, { timeout: 60_000 });
  expect(residentPage.url()).toContain('reference=');

  // Back from checkout, exactly as a payer who abandoned — or faked — the
  // redirect would be.
  await residentPage.goto('/my/payments');
  const afterRow = residentPage.locator('li').filter({ hasText: invoice.number });
  await expect(afterRow).toBeVisible();
  await expect(afterRow).not.toContainText('paid');
  await expect(afterRow.getByRole('button', { name: 'Pay' })).toBeVisible();

  const invoices =
    await resident.get<Array<{ number: string; status: string; outstanding: number }>>(
      '/me/invoices?limit=50',
    );
  const stored = invoices.find((candidate) => candidate.number === invoice.number);
  expect(stored?.status, 'the invoice did not flip to paid on a redirect').not.toBe('paid');
  expect(stored?.outstanding).toBe(250_000);

  await adminContext.close();
  await residentContext.close();
});
