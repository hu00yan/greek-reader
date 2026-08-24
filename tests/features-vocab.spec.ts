// Feature: vocabulary book (localStorage known-words).
//   - per-word "Mark known ✓" in the word side panel dims the word (.vk)
//     and survives page.reload()
//   - toolbar Vocab group (Off / Highlight unknown) flips aria-pressed and
//     re-applies dimming + stats chip  (NOTE: current build toggles word
//     classes, not a body class — see qa-report/e2e-expansion.md)
//   - "Mark page known" bulk action opens the explicit confirm modal
//   - About-page export buttons fire a real download event
import { test, expect, type Page } from '@playwright/test';

const ION = '#/tlg0059/ion';

async function openReader(page: Page): Promise<void> {
  await page.goto(`/${ION}`);
  await page.waitForSelector('.greek-line .w', { timeout: 30_000 });
}

test.describe('Vocabulary book', () => {
  test('mark-known dims the word and persists after reload', async ({ page }) => {
    await openReader(page);
    const word = page.locator('.greek-line .w:not(.speaker)').first();
    await word.click();
    const markBtn = page.locator('.side-panel .panel-vocab-btn');
    await expect(markBtn).toHaveText('Mark known ✓');
    await markBtn.click();
    await expect(word).toHaveClass(/vk/); // dimmed immediately
    await expect(page.locator('.vocab-chip')).toHaveText(/unknown \d+ \/ \d+/);

    const stripped = await word.getAttribute('data-stripped');
    await page.reload();
    await page.waitForSelector('.greek-line .w', { timeout: 30_000 });
    // same form is still dimmed after a cold reload
    const stillDimmed = await page.evaluate((key) =>
      !!document.querySelector(`.greek-line .w[data-stripped="${key}"].vk`), stripped);
    expect(stillDimmed).toBeTruthy();
  });

  test('toolbar Vocab highlight mode toggle flips state and clears dimming on Off', async ({ page }) => {
    await openReader(page);
    const word = page.locator('.greek-line .w:not(.speaker)').first();
    await word.click();
    await page.locator('.panel-vocab-btn').click(); // mark one form known
    await expect(page.locator('.greek-line .w.vk').first()).toBeVisible();

    const offBtn = page.locator('.vocab-group button', { hasText: /^Off$/ });
    const hiBtn = page.locator('.vocab-group button', { hasText: 'Highlight unknown' });
    await offBtn.click();
    await expect(offBtn).toHaveAttribute('aria-pressed', 'true');
    await expect(hiBtn).toHaveAttribute('aria-pressed', 'false');
    expect(await page.locator('.greek-line .w.vk').count()).toBe(0);
    await expect(page.locator('.vocab-chip')).toHaveText(/^\d+ words$/); // off-mode format

    await hiBtn.click();
    await expect(hiBtn).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.greek-line .w.vk').first()).toBeVisible();
  });

  test('bulk mark shows confirm dialog; About export triggers download event', async ({ page }) => {
    await openReader(page);
    await page.locator('.vocab-group button', { hasText: 'Mark page known' }).click();
    const card = page.locator('.modal-backdrop .modal-card[role="dialog"]');
    await expect(card).toContainText('Mark whole page known?');
    await expect(card.locator('.modal-ok')).toHaveText(/^Mark \d+ known$/);
    await card.locator('button', { hasText: 'Cancel' }).click();
    await expect(page.locator('.modal-backdrop')).toHaveCount(0); // nothing marked

    await page.goto('/#/about');
    const btn = page.locator('.yourdata-btn', { hasText: 'Export vocabulary' });
    await expect(btn).toBeVisible();
    const dlPromise = page.waitForEvent('download');
    await btn.click();
    const dl = await dlPromise;
    expect(dl.suggestedFilename()).toBe('greek-reader-vocab.json');
  });
});
