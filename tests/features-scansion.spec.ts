// Feature: metrical scansion (prosody).
//   - Iliad (verse, prosody data shipped): rows hidden by default; toolbar
//     Scansion toggle flips body.show-prosody and renders visible .scansion
//     rows under the verse lines
//   - Prose work without a prosody file (Xenophon, Anabasis): no Scansion
//     control is added and no .scansion rows ever appear
import { test, expect } from '@playwright/test';

const ILIAD = '#/tlg0012/iliad';
const ANABASIS = '#/tlg0032/anabasis'; // prose — no prosody file

test.describe('Scansion toggle', () => {
  test('Iliad: hidden by default, toggle shows .scansion rows + body class', async ({ page }) => {
    await page.goto(`/${ILIAD}`);
    await page.waitForSelector('.greek-line .w', { timeout: 30_000 });
    await page.waitForLoadState('networkidle').catch(() => {});

    // hidden by default
    expect(await page.evaluate(() => document.body.classList.contains('show-prosody'))).toBeFalsy();
    expect(await page.locator('.line > .scansion').count()).toBe(0);

    const tog = page.locator('.controls button', { hasText: /Scansion/ });
    await expect(tog).toHaveCount(1); // verse work with prosody data
    await tog.click();
    await page.waitForSelector('.line > .scansion', { timeout: 10_000 });

    expect(await page.evaluate(() => document.body.classList.contains('show-prosody'))).toBeTruthy();
    expect(await page.locator('.line > .scansion').count()).toBeGreaterThan(0);
    await expect(page.locator('.line > .scansion').first()).toBeVisible();
  });

  test('prose work without prosody data stays blank', async ({ page }) => {
    await page.goto(`/${ANABASIS}`);
    await page.waitForSelector('.greek-line .w', { timeout: 30_000 });
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForTimeout(500);

    // no toggle offered and no scansion nodes injected
    await expect(page.locator('.controls button', { hasText: /Scansion/ })).toHaveCount(0);
    expect(await page.locator('.scansion').count()).toBe(0);
    expect(await page.evaluate(() => document.body.classList.contains('show-prosody'))).toBeFalsy();
  });
});
