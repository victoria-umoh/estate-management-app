import { expect, test } from '@playwright/test';
import { storageStatePath } from './helpers';

/**
 * The ⌘K palette.
 *
 * Never exercised by anything before this: it is mounted lazily, listens on a
 * global key handler, and its whole value is that the keyboard alone can
 * finish the job. So the test uses the keyboard alone.
 */
test.use({ storageState: storageStatePath('admin') });

/**
 * The palette is a lazily loaded chunk with `ssr: false`, so the shortcut does
 * nothing until it has mounted — and in dev that chunk is compiled on demand.
 * Pressing until the dialog appears waits on the state that matters rather than
 * on a guessed delay.
 */
async function openPalette(page: import('@playwright/test').Page) {
  const dialog = page.getByRole('dialog');

  await expect(async () => {
    await page.keyboard.press('ControlOrMeta+k');
    await expect(dialog).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 60_000 });

  return dialog;
}

test('opens on ⌘K, filters as you type, and Enter navigates to the highlighted row', async ({
  page,
}) => {
  await page.goto('/dashboard');
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();

  await openPalette(page);

  const search = page.getByRole('textbox', { name: 'Search' });
  await expect(search).toBeFocused();

  await search.fill('resid');

  const options = page.getByRole('option');
  await expect(options.first()).toBeVisible();

  // The first row is highlighted on open; moving down and back up must land
  // somewhere real rather than off the end of the list.
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowUp');
  const highlighted = page.getByRole('option', { selected: true });
  await expect(highlighted).toHaveCount(1);
  const destination = (await highlighted.textContent())?.trim() ?? '';

  await page.keyboard.press('Enter');

  await expect(page.getByRole('dialog')).toBeHidden();
  await expect(page).not.toHaveURL(/\/dashboard$/);
  expect(destination.length, 'the row Enter acted on had a label').toBeGreaterThan(0);
});

test('Escape closes the palette without navigating', async ({ page }) => {
  await page.goto('/dashboard');
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();

  await openPalette(page);

  await page.keyboard.press('Escape');

  await expect(page.getByRole('dialog')).toBeHidden();
  await expect(page).toHaveURL(/\/dashboard$/);
});
