// Feature: per-unit 🔊 single-toggle semantics.
//   - clicking a unit that is ALREADY speaking stops it immediately:
//     status returns to idle, .tts-speaking clears, and NO second WAV
//     synthesis is kicked off (__ttsLast unchanged)
//   - clicking another unit stops the first: at most ONE .tts-speaking row
//
// Test hooks (src/tts.ts): window.__ttsStatusForTest ('idle'|'loading'|
// 'playing'|…), window.__ttsLast ({durationMs,…} set once per synthesis),
// window.__ttsSpeakText. Buttons flip 🔊 → ⏹ while active.
import { test, expect, type Page } from '@playwright/test';

const ION = '#/tlg0059/ion';

/** Index of the wordiest of the first N units — longest utterance, so the
 *  first click is guaranteed still playing when we interact again. */
async function longestUnitIdx(page: Page, within = 12): Promise<number> {
  return page.evaluate((n) => {
    const rows = Array.from(document.querySelectorAll('.line, .prose-unit'))
      .slice(0, n);
    let best = 0;
    let bestLen = -1;
    rows.forEach((r, i) => {
      const len = r.querySelectorAll('.greek-line .w').length;
      if (len > bestLen) { bestLen = len; best = i; }
    });
    return best;
  }, within);
}

async function waitPlaying(page: Page): Promise<void> {
  await page.waitForFunction(() =>
    !!((window as unknown as Record<string, unknown>).__ttsLast) &&
    (window as unknown as Record<string, unknown>).__ttsStatusForTest === 'playing',
    null, { timeout: 25_000 });
}

test.describe('Per-unit TTS single toggle', () => {
  test('second click on the SAME unit stops it without re-synthesizing', async ({ page }) => {
    await page.goto(`/${ION}`);
    await page.waitForSelector('.greek-line .w', { timeout: 30_000 });
    const btn = page.locator('.tts-unit-btn').nth(await longestUnitIdx(page));
    await btn.scrollIntoViewIfNeeded();
    await btn.click();
    await waitPlaying(page);
    expect(await page.locator('.tts-speaking').count()).toBe(1);
    const lastBefore = await page.evaluate(() =>
      JSON.stringify((window as unknown as Record<string, unknown>).__ttsLast));

    await btn.click(); // still active → immediate STOP, never restart
    await page.waitForTimeout(400);
    const st = await page.evaluate(() => ({
      status: String((window as unknown as Record<string, unknown>).__ttsStatusForTest),
      last: JSON.stringify((window as unknown as Record<string, unknown>).__ttsLast),
    }));
    expect(st.status).toBe('idle');
    expect(await page.locator('.tts-speaking').count()).toBe(0);
    expect(st.last).toBe(lastBefore); // synthesis NOT re-triggered
  });

  test('clicking ANOTHER unit stops the first — one speaking row at most', async ({ page }) => {
    await page.goto(`/${ION}`);
    await page.waitForSelector('.greek-line .w', { timeout: 30_000 });
    const idxA = await longestUnitIdx(page);
    const btnA = page.locator('.tts-unit-btn').nth(idxA);
    await btnA.scrollIntoViewIfNeeded();
    await btnA.click();
    await waitPlaying(page);

    // remember WHICH row was speaking (position among all unit rows)
    const posA = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('.line, .prose-unit'));
      return rows.indexOf(document.querySelector('.tts-speaking'));
    });
    expect(posA).toBeGreaterThanOrEqual(0);

    const btnB = page.locator('.tts-unit-btn').nth(idxA === 6 ? 3 : 6);
    await btnB.scrollIntoViewIfNeeded();
    await btnB.click();
    await page.waitForFunction(
      () => ['playing', 'idle'].includes(
        String((window as unknown as Record<string, unknown>).__ttsStatusForTest)),
      null, { timeout: 25_000 });
    await page.waitForTimeout(600);

    const st = await page.evaluate((pos) => {
      const rows = Array.from(document.querySelectorAll('.line, .prose-unit'));
      const spk = document.querySelector('.tts-speaking');
      return {
        status: String((window as unknown as Record<string, unknown>).__ttsStatusForTest),
        count: document.querySelectorAll('.tts-speaking').length,
        pos: spk ? rows.indexOf(spk) : -1,
        posA: pos,
      };
    }, posA);
    expect(st.count).toBeLessThanOrEqual(1); // never two choirs at once
    if (st.count === 1) expect(st.pos).not.toBe(st.posA); // survivor is B, not A
    expect(st.status).not.toBe('paused');

    try { await page.evaluate(() => { try { speechSynthesis?.cancel(); } catch {} }); } catch {}
  });
});
