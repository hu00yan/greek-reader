// Feature: dual book titles in the catalog (commit 9d0038f).
//   - LXX books render "English / Lat. Latin" — Hosea must show
//     "Hosea / Lat. Osee"
//   - NT gospels carry a Greek parenthetical after the English name,
//     e.g. "Matthew (Κατὰ Μαθθαῖον α)"
// Titles surface in the reader controls crumbs ("Author, Title") and on
// home work links.
import { test, expect } from '@playwright/test';

test.describe('Dual book titles', () => {
  test('LXX book renders "Hosea / Lat. Osee"', async ({ page }) => {
    await page.goto('/#/tlg0527/osee');
    await page.waitForSelector('.greek-line .w', { timeout: 30_000 });
    const crumbs = page.locator('.controls .crumbs');
    await expect(crumbs).toContainText('Septuaginta');
    await expect(crumbs).toHaveText(/Hosea \/ Lat\. Osee/);
  });

  test('NT gospel title contains a Greek parenthetical', async ({ page }) => {
    await page.goto('/#/tlg0031/matthew');
    await page.waitForSelector('.greek-line .w', { timeout: 30_000 });
    const crumbs = page.locator('.controls .crumbs');
    await expect(crumbs).toContainText('New Testament');
    // English name followed by a Greek-title parenthesis
    await expect(crumbs).toHaveText(/Matthew \(Κατὰ Μαθθαῖον α\)/);
  });

  test('home catalog lists the dual titles too', async ({ page }) => {
    await page.goto('/#/');
    const hosea = page.locator('.work-link', { hasText: 'Hosea / Lat. Osee' });
    await expect(hosea.first()).toBeVisible();
    const matthew = page.locator('.work-link', { hasText: 'Matthew (Κατὰ Μαθθαῖον α)' });
    await expect(matthew.first()).toBeVisible();
  });
});
