// TEMP screenshot pass (deleted after use)
import { chromium } from 'playwright-core';

const base = 'http://localhost:4188';
const shotDir = 'qa-report/screenshots';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

// reader light
await page.goto(`${base}/#/tlg0012/iliad`);
await page.waitForSelector('.greek-line .w', { timeout: 30000 });
await page.waitForTimeout(1500);
await page.screenshot({ path: `${shotDir}/round3b-reader-light-1440.png` });

// scansion on
await page.locator('.controls button', { hasText: /Scansion/ }).click();
await page.waitForTimeout(1200);
await page.screenshot({ path: `${shotDir}/round3b-scansion.png` });

// drawer open (translation on Ion) + scrolled sticky header
await page.goto(`${base}/#/tlg0059/ion`);
await page.waitForSelector('.greek-line .w', { timeout: 30000 });
await page.locator('button', { hasText: /English/ }).first().click();
await page.waitForSelector('#tr-drawer .tr-unit', { timeout: 10000 });
await page.waitForTimeout(800);
await page.screenshot({ path: `${shotDir}/round3b-drawer-open.png` });
await page.evaluate(() => { document.getElementById('tr-drawer').scrollTop = 900; });
await page.waitForTimeout(300);
await page.screenshot({ path: `${shotDir}/round3b-drawer-sticky.png` });

// dark theme reader
await page.evaluate(() => { document.getElementById('tr-drawer').classList.add('hidden'); document.body.classList.remove('translation-open'); });
const theme = page.locator('.controls .theme-ctl button', { hasText: /Dark/i }).first();
if (await theme.count()) {
  const auto = page.locator('.controls .theme-ctl button').first();
  // theme control may be Auto/Light/Dark segmented — click Dark if present
  const darkBtn = page.locator('.theme-ctl button', { hasText: /^Dark$/i }).first();
  if (await darkBtn.count()) { await darkBtn.click(); }
  else { void auto; }
}
await page.waitForTimeout(400);
await page.goto(`${base}/#/tlg0012/iliad`);
await page.waitForSelector('.greek-line .w', { timeout: 30000 });
await page.waitForTimeout(1200);
await page.screenshot({ path: `${shotDir}/round3b-reader-dark-1440.png` });

// mobile 390
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(500);
await page.screenshot({ path: `${shotDir}/round3b-mobile-390.png` });

await browser.close();
console.log('shots done');
