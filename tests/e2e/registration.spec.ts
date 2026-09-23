import { expect, test } from '@playwright/test';
import { api, PASSWORD, signIn, storageStatePath, unique } from './helpers';

/**
 * Workflow 1 — registration through to a usable digital ID.
 *
 * The browser part of this journey is deliberately short, because that is all
 * there is: the app ships no public registration screen, only `POST
 * /api/v1/auth/register`. So the account is created over the API — the way a
 * native client would — and everything after that is driven through the UI:
 * the refusal to sign in before approval, the chairman's decision, and the ID
 * appearing for the resident who was just approved.
 *
 * Registration is rate limited to five per IP per fifteen minutes, so this file
 * creates exactly one account per run.
 */
test.use({ storageState: storageStatePath('admin') });

test('a registration is refused at sign-in until an admin approves it, then the ID is issued', async ({
  page,
  browser,
}) => {
  const admin = api(page.request);
  const estate = await admin.get<{ id: string }>('/estate');

  const surname = unique('Testresident').replace(/-/g, '');
  const email = `${surname.toLowerCase()}@example.test`;
  // Nigerian mobile format, and random so repeat runs do not collide on the
  // unique phone index.
  const phone = `080${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;

  const registerResponse = await page.request.post('/api/v1/auth/register', {
    data: {
      firstName: 'Chidi',
      lastName: surname,
      email,
      phone,
      password: PASSWORD,
      estateId: estate.id,
      category: 'homeowner',
    },
  });

  expect(
    registerResponse.status(),
    `registration failed: ${await registerResponse.text()}`,
  ).toBeLessThan(300);

  // --- Signing in before approval is refused, on screen ---------------------

  const applicant = await browser.newContext();
  const applicantPage = await applicant.newPage();

  await signIn(applicantPage, email);
  // `.first()` because Next's own route announcer is also role="alert"; the
  // form's message is the one above the fields.
  await expect(applicantPage.getByRole('alert').first()).toContainText(/awaiting approval/i);
  await expect(applicantPage).toHaveURL(/\/login/);

  // --- The chairman approves, in the browser -------------------------------

  await page.goto('/admin/residents');
  await page.getByRole('textbox', { name: 'Search residents' }).fill(surname);

  const row = page.getByRole('link', { name: new RegExp(surname) });
  await expect(row).toBeVisible();
  await row.click();

  await expect(page.getByRole('heading', { name: `Chidi ${surname}` })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Waiting for a decision' })).toBeVisible();

  await page.getByRole('button', { name: 'Approve', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Approve' }).click();

  // The decision card is gone precisely because the membership is now active.
  await expect(page.getByRole('heading', { name: 'Waiting for a decision' })).toBeHidden();

  // --- The same person can now sign in, and has an ID ----------------------

  await signIn(applicantPage, email);
  await applicantPage.waitForURL('**/dashboard');

  await applicantPage.goto('/my/id');
  // The card is issued on first request, so its presence — not merely a 200 —
  // is what proves approval carried through to gate access.
  await expect(applicantPage.getByRole('button', { name: 'Show QR code' })).toBeVisible();
  await expect(applicantPage.getByText(`Chidi ${surname}`)).toBeVisible();

  await applicant.close();
});
