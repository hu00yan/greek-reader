import { test, expect } from '@playwright/test';

const ION_HASH = '#/tlg0059/ion';

test.describe('Drawer layout fixes', () => {

  test('Dictionary drawer pushes main (left) not overlay', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/${ION_HASH}`);
    await page.waitForSelector('.greek-line .w', { timeout: 20000 });
    await page.waitForLoadState('networkidle');

    const app = page.locator('#app');
    await expect(app).toBeVisible();

    // Initial margin-left should be auto/0
    const initialMargin = await page.evaluate(() => {
      const el = document.getElementById('app') as HTMLElement;
      return getComputedStyle(el).marginLeft;
    });
    const initialNum = parseFloat(initialMargin);
    // initial may be auto computed as px; just capture for later comparison

    // Find Dictionary/Lexicon button (top controls)
    const lexBtn = page.locator('.controls button', { hasText: /Lexicon|Dictionary/i }).first();
    // Fallback to floating fab if controls not found
    const lexBtnCount = await lexBtn.count();
    let btn = lexBtn;
    if (lexBtnCount === 0) {
      btn = page.locator('button.lex-fab, button', { hasText: /Lexicon|Dictionary/i }).first();
    }
    await expect(btn).toBeVisible({ timeout: 8000 });
    await btn.click();

    // Check drawer left visible
    const drawer = page.locator('.drawer.left');
    await expect(drawer).toBeVisible({ timeout: 8000 });
    await expect(drawer).not.toHaveClass(/hidden/);
    // Check body has lexicon-open
    await expect.poll(async () => await page.evaluate(() => document.body.classList.contains('lexicon-open'))).toBeTruthy();

    // Check CSS variable --drawer-width exists
    const drawerVar = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--drawer-width').trim());
    expect(drawerVar).not.toBe('');
    expect(drawerVar).toMatch(/rem|px|vw/);

    // Check #app margin-left changed (push)
    const afterMargin = await page.evaluate(() => {
      const el = document.getElementById('app') as HTMLElement;
      return getComputedStyle(el).marginLeft;
    });
    const afterNum = parseFloat(afterMargin);
    // Should be significantly larger than initial (drawer width ~384)
    expect(afterNum).toBeGreaterThan(100);
    // Also check transition includes margin-left
    const transition = await page.evaluate(() => {
      const el = document.getElementById('app') as HTMLElement;
      return getComputedStyle(el).transition;
    });
    expect(transition).toMatch(/margin-left|margin/);

    // Check not overlay: drawer right edge <= app left edge (with 5px tolerance)
    const notOverlay = await page.evaluate(() => {
      const d = document.querySelector('.drawer.left') as HTMLElement;
      const a = document.getElementById('app') as HTMLElement;
      if (!d || !a) return false;
      const dr = d.getBoundingClientRect();
      const ar = a.getBoundingClientRect();
      // When hidden via transform, dr may be off-screen; but when visible, dr.right should be <= ar.left + tolerance
      // Also check that drawer is not covering text: app left should be >= drawer width -10
      return dr.right <= ar.left + 10;
    });
    expect(notOverlay).toBeTruthy();

    // Toggle close
    await btn.click();
    await expect(drawer).toHaveClass(/hidden/);
    await expect.poll(async () => await page.evaluate(() => !document.body.classList.contains('lexicon-open'))).toBeTruthy();
    const closedMargin = await page.evaluate(() => {
      const el = document.getElementById('app') as HTMLElement;
      return getComputedStyle(el).marginLeft;
    });
    // Closed margin should be back to initial (smaller)
    expect(parseFloat(closedMargin)).toBeLessThan(afterNum);
  });

  test('Translation drawer pushes correctly (right)', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/${ION_HASH}`);
    await page.waitForSelector('.greek-line .w', { timeout: 20000 });
    await page.waitForLoadState('networkidle');

    const englishBtn = page.locator('button', { hasText: /English/i }).first();
    await expect(englishBtn).toBeVisible({ timeout: 10000 });
    await englishBtn.click();

    const drawer = page.locator('#tr-drawer, .drawer.right');
    await expect(drawer).toBeVisible({ timeout: 10000 });
    await expect(drawer).not.toHaveClass(/hidden/);
    await expect.poll(async () => await page.evaluate(() => document.body.classList.contains('translation-open'))).toBeTruthy();

    const afterMarginRight = await page.evaluate(() => {
      const el = document.getElementById('app') as HTMLElement;
      return getComputedStyle(el).marginRight;
    });
    expect(parseFloat(afterMarginRight)).toBeGreaterThan(100);

    const transition = await page.evaluate(() => {
      const el = document.getElementById('app') as HTMLElement;
      return getComputedStyle(el).transition;
    });
    expect(transition).toMatch(/margin-right|margin/);

    // Not overlay on right: app right <= drawer left
    const notOverlay = await page.evaluate(() => {
      const d = document.querySelector('.drawer.right') as HTMLElement;
      const a = document.getElementById('app') as HTMLElement;
      if (!d || !a) return false;
      const dr = d.getBoundingClientRect();
      const ar = a.getBoundingClientRect();
      return ar.right <= dr.left + 10;
    });
    expect(notOverlay).toBeTruthy();

    // Close via close button
    const closeBtn = drawer.locator('.close-btn').first();
    await closeBtn.click();
    await expect(drawer).toHaveClass(/hidden/);
    await expect.poll(async () => await page.evaluate(() => !document.body.classList.contains('translation-open'))).toBeTruthy();
  });

  test('Both drawers simultaneously open do not double-overlap', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/${ION_HASH}`);
    await page.waitForSelector('.greek-line .w', { timeout: 20000 });
    await page.waitForLoadState('networkidle');

    const lexBtn = page.locator('.controls button', { hasText: /Lexicon|Dictionary/i }).first();
    const englishBtn = page.locator('button', { hasText: /English/i }).first();
    await expect(lexBtn).toBeVisible();
    await expect(englishBtn).toBeVisible();

    await lexBtn.click();
    await page.waitForTimeout(300);
    await englishBtn.click();
    await page.waitForTimeout(500);

    const leftDrawer = page.locator('.drawer.left');
    const rightDrawer = page.locator('.drawer.right, #tr-drawer');
    await expect(leftDrawer).not.toHaveClass(/hidden/);
    await expect(rightDrawer).not.toHaveClass(/hidden/);
    await expect.poll(async () => await page.evaluate(() => document.body.classList.contains('lexicon-open') && document.body.classList.contains('translation-open'))).toBeTruthy();

    // Both margins should be set
    const margins = await page.evaluate(() => {
      const el = document.getElementById('app') as HTMLElement;
      const s = getComputedStyle(el);
      return { left: s.marginLeft, right: s.marginRight };
    });
    expect(parseFloat(margins.left)).toBeGreaterThan(100);
    expect(parseFloat(margins.right)).toBeGreaterThan(100);

    // Check no overlap: left drawer right <= app left, app right <= right drawer left
    const overlap = await page.evaluate(() => {
      const l = document.querySelector('.drawer.left') as HTMLElement;
      const r = document.querySelector('.drawer.right') as HTMLElement;
      const a = document.getElementById('app') as HTMLElement;
      if (!l || !r || !a) return { ok: false, l: 0, ar: 0, rr: 0 };
      const lr = l.getBoundingClientRect();
      const rr = r.getBoundingClientRect();
      const ar = a.getBoundingClientRect();
      return {
        leftOk: lr.right <= ar.left + 10,
        rightOk: ar.right <= rr.left + 10,
        noOverlap: lr.right < rr.left,
        lr: lr.right,
        arL: ar.left,
        arR: ar.right,
        rrL: rr.left,
      };
    });
    expect(overlap.leftOk).toBeTruthy();
    expect(overlap.rightOk).toBeTruthy();
    expect(overlap.noOverlap).toBeTruthy();

    // Close both
    await lexBtn.click();
    await rightDrawer.locator('.close-btn').first().click();
    await expect.poll(async () => await page.evaluate(() => !document.body.classList.contains('lexicon-open') && !document.body.classList.contains('translation-open'))).toBeTruthy();
  });

  test('Main text uses screen width ( >900 on 1440, ~70% on 1920 )', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/${ION_HASH}`);
    await page.waitForSelector('.greek-line .w', { timeout: 20000 });
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(500);

    const width1440 = await page.evaluate(() => {
      const el = document.getElementById('app') as HTMLElement;
      return el ? el.getBoundingClientRect().width : 0;
    });
    expect(width1440).toBeGreaterThan(900);
    // Should be at least 60% of viewport
    expect(width1440 / 1440).toBeGreaterThan(0.6);

    await page.setViewportSize({ width: 1920, height: 900 });
    await page.waitForTimeout(800);
    const width1920 = await page.evaluate(() => {
      const el = document.getElementById('app') as HTMLElement;
      return el ? el.getBoundingClientRect().width : 0;
    });
    // On 1920, expect ~70% width (allow 60-85%)
    const ratio = width1920 / 1920;
    expect(width1920).toBeGreaterThan(1100);
    expect(ratio).toBeGreaterThan(0.60);
    expect(ratio).toBeLessThan(0.85);
    // Also check that CSS uses 75vw or 1100
    const maxWidth = await page.evaluate(() => {
      const el = document.getElementById('app') as HTMLElement;
      return getComputedStyle(el).maxWidth;
    });
    // maxWidth should be something like 1400px or 75vw
    expect(maxWidth).not.toBe('52rem');
  });

  test('AI and TTS buttons placement deterministic at header', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/${ION_HASH}`);
    await page.waitForSelector('.greek-line .w', { timeout: 20000 });
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(800); // allow LLM sweeper to bind

    const units = await page.$$eval('.line, .prose-unit', els => els.map(row => {
      const header = row.querySelector('.unit-head');
      const actions = header ? header.querySelector('.unit-actions') : null;
      const headerExists = !!header;
      const actionsExists = !!actions;
      const btns = actions ? Array.from(actions.querySelectorAll('button')) : [];
      const ttsCount = actions ? actions.querySelectorAll('.tts-unit-btn').length : 0;
      const aiCount = actions ? actions.querySelectorAll('.ai-btn, .ai-btn-line').length : 0;
      const totalInHeader = btns.length;
      // orphan checks: buttons that are direct children of row but not in header
      const directChildren = Array.from(row.children);
      const orphanAi = directChildren.filter(ch => ch.classList.contains('ai-btn') || ch.classList.contains('ai-btn-line')).length;
      const orphanTts = directChildren.filter(ch => ch.classList.contains('tts-unit-btn')).length;
      // between greek and parse: check if any .ai-btn or .tts-unit-btn is sibling between greek and parse-row
      const greek = row.querySelector('.greek-line');
      const parse = row.querySelector('.parse-row');
      let between = 0;
      if (greek && parse) {
        let cur: Element | null = greek.nextElementSibling;
        while (cur && cur !== parse) {
          if (cur.matches('button.ai-btn, button.tts-unit-btn, .ai-btn, .tts-unit-btn')) between++;
          cur = cur.nextElementSibling;
        }
      }
      // Check that header is first child (before greek)
      const headerIndex = header ? Array.from(row.children).indexOf(header) : -1;
      const greekIndex = greek ? Array.from(row.children).indexOf(greek) : 999;
      const headerBeforeGreek = headerIndex >= 0 && headerIndex < greekIndex;
      // Also check that parseRow is after greek
      const parseIndex = parse ? Array.from(row.children).indexOf(parse) : 999;
      const greekBeforeParse = greekIndex < parseIndex;
      return {
        headerExists,
        actionsExists,
        ttsCount,
        aiCount,
        totalInHeader,
        orphanAi,
        orphanTts,
        between,
        headerBeforeGreek,
        greekBeforeParse,
        rowHTML: row.outerHTML.slice(0, 400),
      };
    }));

    expect(units.length).toBeGreaterThan(0);
    for (const u of units) {
      expect(u.headerExists, `header missing for unit ${u.rowHTML}`).toBeTruthy();
      expect(u.actionsExists, `actions missing`).toBeTruthy();
      expect(u.ttsCount, `tts count not 1 for unit`).toBe(1);
      expect(u.aiCount, `ai count not 1 for unit`).toBe(1);
      // round-5+: unit-actions = TTS + star + copy + AI (product truth)
      expect(u.totalInHeader, `total header buttons not 4`).toBe(4);
      expect(u.orphanAi, `orphan AI button between lines`).toBe(0);
      expect(u.orphanTts, `orphan TTS button between lines`).toBe(0);
      expect(u.between, `button between greek and parse row`).toBe(0);
      expect(u.headerBeforeGreek, `header not before greek`).toBeTruthy();
      expect(u.greekBeforeParse, `greek not before parse`).toBeTruthy();
    }

    // Also ensure no orphan between units: no .ai-btn directly under #app or between rows
    const orphanBetweenUnits = await page.evaluate(() => {
      const app = document.getElementById('app');
      if (!app) return 1;
      // Look for buttons that are children of #app but not inside a unit
      const directBtns = Array.from(app.children).filter(el => el.matches('button.ai-btn, button.tts-unit-btn'));
      return directBtns.length;
    });
    expect(orphanBetweenUnits).toBe(0);

    // Check grouping: actions is inline flex with gap
    const flexCheck = await page.evaluate(() => {
      const a = document.querySelector('.unit-actions') as HTMLElement;
      if (!a) return null;
      const s = getComputedStyle(a);
      return { display: s.display, gap: s.gap, marginLeft: s.marginLeft };
    });
    expect(flexCheck).not.toBeNull();
    expect(flexCheck!.display).toMatch(/flex/);
    // gap should be non-zero
    const gapNum = parseFloat(flexCheck!.gap);
    expect(gapNum).toBeGreaterThan(0);
  });

  test('No duplicate AI/TTS buttons after reflow and pagination', async ({ page }) => {
    await page.setViewportSize({ width: 500, height: 900 }); // narrow to trigger reflow
    await page.goto(`/${ION_HASH}`);
    await page.waitForSelector('.greek-line .w', { timeout: 20000 });
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1000);
    await page.evaluate(() => window.dispatchEvent(new Event('resize')));
    await page.waitForTimeout(1000);

    const units = await page.$$eval('.line, .prose-unit', els => els.map(row => {
      const tts = row.querySelectorAll('.tts-unit-btn').length;
      const ai = row.querySelectorAll('.ai-btn, .ai-btn-line').length;
      const vlines = row.querySelectorAll('.vline').length;
      // Ensure no ai button inside vline (should be only in header)
      const aiInVline = row.querySelectorAll('.vline .ai-btn, .vline .tts-unit-btn').length;
      return { tts, ai, vlines, aiInVline };
    }));
    for (const u of units) {
      expect(u.tts).toBe(1);
      expect(u.ai).toBe(1);
      expect(u.aiInVline).toBe(0);
    }

    // Check total button counts equal 2 * units
    const totalTts = await page.$$eval('.tts-unit-btn', els => els.length);
    const totalAi = await page.$$eval('.ai-btn-line', els => els.length);
    expect(totalTts).toBe(units.length);
    expect(totalAi).toBe(units.length);
  });
});
