// Feature: home-page full-text search.
//   - Unicode Greek query "λόγος" → "In Greek texts:" section with ≥1 hit
//     linking to a #/tlg… reader route
//   - Betacode input "lo/gos" normalizes to the SAME hit list
//   - English query "shepherd" → "In translations:" section with hits
import { test, expect } from '@playwright/test';

async function search(page: import('@playwright/test').Page, q: string): Promise<void> {
  await page.goto('/#/');
  const input = page.locator('.home-search input');
  await expect(input).toBeVisible();
  await input.fill(q);
}

test.describe('Greek & translation search', () => {
  test('Unicode Greek query shows "In Greek texts:" hits linking #/tlg routes', async ({ page }) => {
    await search(page, 'λόγος');
    const grc = page.locator('.grc-hits');
    await expect(grc.locator('.text-hits-head')).toContainText('In Greek texts:');
    const hits = grc.locator('.grc-hit');
    await expect(hits.first()).toBeVisible();
    expect(await hits.count()).toBeGreaterThanOrEqual(1);
    await expect(hits.first()).toHaveAttribute('href', /^#\/tlg\d{4}\//);
  });

  test('betacode input produces the same normalized results', async ({ page }) => {
    await search(page, 'λόγος');
    await page.waitForSelector('.grc-hits:not([hidden]) .grc-hit');
    const uniHits = await page.locator('.grc-hits .grc-hit')
      .evaluateAll((els) => els.map((e) => e.textContent));

    await search(page, 'lo/gos'); // betacode → fromBeta() → λόγος
    await page.waitForSelector('.grc-hits:not([hidden]) .grc-hit');
    const betaHits = await page.locator('.grc-hits .grc-hit')
      .evaluateAll((els) => els.map((e) => e.textContent));
    // same works, same order (only the echoed query text in the heading differs)
    expect(betaHits).toEqual(uniHits);
  });

  test('English-translations hits section still works ("shepherd")', async ({ page }) => {
    await search(page, 'shepherd');
    const en = page.locator('.text-hits:not(.grc-hits)');
    await expect(en.locator('.text-hits-head')).toContainText('In translations:');
    const hits = en.locator('.text-hit');
    await expect(hits.first()).toBeVisible();
    expect(await hits.count()).toBeGreaterThanOrEqual(1);
    await expect(hits.first()).toHaveAttribute('href', /^#\//);
  });
});
