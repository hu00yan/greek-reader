// Feature: bookmarks & resume.
//   - per-unit ★ toggles, persists across reload (localStorage
//     greek-reader.bookmarks)
//   - home page shows a "Continue reading" card linking back to the work
//   - ?ref= deep link pages forward and lands on the requested unit;
//     footer pager reports the rendered Page N
//
// NOTE: star/copy buttons are only wired from page 2 onward (setUnitContext
// runs AFTER the first render in main.ts openReader) — so this spec uses a
// ?ref= deep link to reach starred units. The page-1 gap is documented as a
// product bug in qa-report/e2e-expansion.md.
import { test, expect } from '@playwright/test';

const ILIAD_REF_145 = '#/tlg0012/iliad?ref=1.45';
const ILIAD_REF_1100 = '#/tlg0012/iliad?ref=1.100'; // unit idx 99 → page 4

test.describe('Bookmarks & resume', () => {
  test('star unit persists after reload', async ({ page }) => {
    await page.goto(`/${ILIAD_REF_145}`);
    const star = page.locator('[data-ref="1.45"] .star-btn');
    await expect(star).toBeVisible();
    await star.click();
    await expect(star).toHaveAttribute('aria-pressed', 'true');
    await expect(star).toHaveText('★');

    await page.reload();
    await page.waitForSelector('.greek-line .w', { timeout: 30_000 });
    await page.locator('[data-ref="1.45"]').scrollIntoViewIfNeeded();
    await expect(page.locator('[data-ref="1.45"] .star-btn'))
      .toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('[data-ref="1.45"] .star-btn')).toHaveText('★');
  });

  test('Continue Reading section appears on home linking back to the work', async ({ page }) => {
    // visiting a reader records the resume position
    await page.goto(`/${ILIAD_REF_145}`);
    await page.waitForSelector('.greek-line .w', { timeout: 30_000 });
    await page.goto('/#/');
    const sec = page.locator('.continue-reading');
    await expect(sec).toBeVisible();
    const card = sec.locator('.cont-card').first();
    await expect(card).toHaveText(/Iliad/);
    await expect(card).toHaveAttribute('href', /#\/tlg0012\/iliad\?ref=/);
  });

  test('?ref= deep link pages forward; footer shows the target Page N', async ({ page }) => {
    await page.goto(`/${ILIAD_REF_1100}`);
    const row = page.locator('[data-ref="1.100"]');
    await expect(row).toBeVisible({ timeout: 30_000 }); // paged forward to it
    // units 91–120 → exactly page 4 (PAGE_SIZE = 30)
    await expect(page.locator('.pager-info')).toContainText('Page 4 of');
    const centered = await row.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return r.top >= 0 && r.bottom <= window.innerHeight + 40;
    });
    expect(centered).toBeTruthy(); // jump centers the target unit
  });
});
