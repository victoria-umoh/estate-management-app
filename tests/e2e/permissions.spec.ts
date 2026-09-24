import { expect, test } from '@playwright/test';
import { api, contextFor, myMembershipId } from './helpers';

/**
 * Screen-level permission boundaries around the resident directory.
 *
 * A resident may read the directory by design — names and unit numbers, so
 * neighbours can find each other. Everything past that is someone else's
 * household: contact details, identity fields, and the decisions an
 * administrator makes about a membership.
 *
 * `pnpm smoke` checks the list projection. It cannot see what a resident gets
 * by typing an admin URL, which is what these two tests are for.
 */

test('a resident on /admin/residents gets the directory and none of the administration', async ({
  browser,
}) => {
  const residentContext = await contextFor(browser, 'resident');
  const page = await residentContext.newPage();

  await page.goto('/admin/residents');
  await expect(page.getByRole('heading', { name: 'Residents' })).toBeVisible();

  // No approval queue, and no decision the resident is not entitled to make.
  await expect(page.getByRole('button', { name: 'Approve' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Reject' })).toHaveCount(0);
  await expect(page.getByText(/Waiting for a decision/)).toHaveCount(0);

  // The directory carries no way to contact anybody.
  await expect(page.getByText(/@example\.com/)).toHaveCount(0);
  await expect(page.getByText(/\+234\d{7,}/)).toHaveCount(0);

  await residentContext.close();
});

test("a resident cannot read another household's contact details", async ({ browser }) => {
  const adminContext = await contextFor(browser, 'admin');
  const residentContext = await contextFor(browser, 'resident');
  const adminPage = await adminContext.newPage();
  const residentPage = await residentContext.newPage();

  const mine = await myMembershipId(residentPage.request);

  const directory = await api(adminPage.request).get<
    Array<{ membershipId: string; fullName: string }>
  >('/residents?limit=20');
  const neighbour = directory.find((entry) => entry.membershipId !== mine);
  expect(neighbour, 'the estate has another household to read').toBeTruthy();

  const detail = await api(adminPage.request).get<{ email: string; phone: string }>(
    `/residents/${neighbour!.membershipId}`,
  );

  // The API 404s for a resident reading a record outside their own address, so
  // the screen renders a not-found state rather than a profile. Waiting on an
  // <h1> was written against the leak: the page used to show the neighbour.
  const apiResponse = residentPage.waitForResponse(
    (response) =>
      response.url().includes(`/api/v1/residents/${neighbour!.membershipId}`) &&
      response.request().method() === 'GET',
  );

  await residentPage.goto(`/admin/residents/${neighbour!.membershipId}`);

  // A 404, not a 403: confirming the membership exists is itself a disclosure.
  expect((await apiResponse).status()).toBe(404);

  await expect(
    residentPage.getByText(detail.email),
    "another household's email address must not render for a resident",
  ).toHaveCount(0);
  await expect(
    residentPage.getByText(detail.phone),
    "another household's phone number must not render for a resident",
  ).toHaveCount(0);
  await expect(
    residentPage.getByText('National identity number'),
    'identity fields belong to administrators',
  ).toHaveCount(0);

  await adminContext.close();
  await residentContext.close();
});
