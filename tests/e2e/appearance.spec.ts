import { expect, test, type Page } from '@playwright/test';
import { contextFor, type Role } from './helpers';

/**
 * Light and dark, at phone, tablet and desktop, on the four surfaces the spec
 * singles out.
 *
 * These are the screens used one-handed, outdoors, at a barrier, or in an
 * emergency — where a horizontal scrollbar is not an aesthetic complaint but a
 * control pushed off the edge of a 320px phone. Each case asserts the screen's
 * own landmark rendered and that the page does not scroll sideways.
 */
interface Surface {
  name: string;
  path: string;
  role: Role;
  /** Something only this screen renders, so a redirect to /login cannot pass. */
  expect: (page: Page) => Promise<void>;
}

const SURFACES: Surface[] = [
  {
    name: 'gate scanner',
    path: '/security/scan',
    role: 'officer',
    expect: async (page) => {
      await expect(page.getByRole('tab', { name: 'Code' })).toBeVisible();
      await expect(page.getByRole('group', { name: 'Direction' })).toBeVisible();
    },
  },
  {
    name: 'digital ID',
    path: '/my/id',
    role: 'resident',
    expect: async (page) => {
      await expect(page.getByRole('button', { name: 'Show QR code' })).toBeVisible();
    },
  },
  {
    name: 'visitor pass',
    path: '/my/visitors',
    role: 'resident',
    expect: async (page) => {
      await expect(page.getByRole('heading', { name: 'My visitors' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'New pass' })).toBeVisible();
    },
  },
  {
    name: 'emergency',
    path: '/security/emergencies',
    role: 'officer',
    expect: async (page) => {
      await expect(page.getByRole('heading', { name: 'Emergencies' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Refresh' })).toBeVisible();
    },
  },
];

const VIEWPORTS = [
  { name: '320px phone', width: 320, height: 720 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
];

for (const surface of SURFACES) {
  for (const theme of ['light', 'dark'] as const) {
    for (const viewport of VIEWPORTS) {
      test(`${surface.name} renders in ${theme} at ${viewport.name}`, async ({ browser }) => {
        const context = await contextFor(browser, surface.role);
        const page = await context.newPage();

        // next-themes reads its choice from storage before first paint, so
        // setting it here avoids testing a flash of the wrong theme.
        await page.addInitScript(
          ([key, value]) => window.localStorage.setItem(key as string, value as string),
          ['theme', theme],
        );
        await page.setViewportSize({ width: viewport.width, height: viewport.height });

        await page.goto(surface.path);
        await surface.expect(page);

        await expect(page.locator('html')).toHaveClass(new RegExp(theme));

        const overflow = await page.evaluate(() => ({
          scrollWidth: document.documentElement.scrollWidth,
          clientWidth: document.documentElement.clientWidth,
        }));

        // One pixel of slack for sub-pixel layout rounding; anything more is a
        // control the user has to scroll sideways to reach.
        expect(
          overflow.scrollWidth,
          `${surface.name} scrolls horizontally at ${viewport.width}px`,
        ).toBeLessThanOrEqual(overflow.clientWidth + 1);

        await context.close();
      });
    }
  }
}
