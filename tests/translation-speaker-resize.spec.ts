import { test, expect } from '@playwright/test';

const CRITO_HASH = '#/tlg0059/crito';
const ION_HASH = '#/tlg0059/ion';

test.describe('Translation speaker detection and panel resize', () => {

  test('strict englishSpeaker only at unit start with colon or verb-of-saying', async ({ page }) => {
    // Need to open a work with translation to load translation.ts module and hook
    await page.goto(`/${CRITO_HASH}`);
    await page.waitForSelector('.greek-line .w', { timeout: 20000 });
    // open translation to ensure hook is set (module-level also but ensure)
    const englishBtn = page.locator('button', { hasText: /English/ }).first();
    await expect(englishBtn).toBeVisible({ timeout: 10000 });
    await englishBtn.click();
    await page.waitForSelector('#tr-drawer', { timeout: 10000 });
    await page.waitForSelector('#tr-drawer .tr-unit', { timeout: 10000 });

    // Now test the strict detector via window hook
    const cases: Array<{ txt: string; expect: string | null }> = [
      { txt: 'Socrates: Hello there', expect: 'Socrates' },
      { txt: 'Socrates said: Hello', expect: 'Socrates' },
      { txt: 'Ion said hello', expect: 'Ion' },
      { txt: 'Crito: Yes very early', expect: 'Crito' },
      { txt: 'Crito said: Something', expect: 'Crito' },
      { txt: 'Soc.: Hi', expect: 'Socrates' },
      { txt: 'Ion: Welcome', expect: 'Ion' },
      // inline mentions should NOT trigger
      { txt: 'He said to Crito that Socrates mentions Crito mid-sentence', expect: null },
      { txt: 'Socrates Why have you come at this time Crito', expect: null }, // no colon, no verb -> no English detection
      { txt: 'Crito Yes very early Socrates', expect: null },
      { txt: 'Welcome Ion Where have you come from', expect: null },
      { txt: 'Why then you were competing Socrates', expect: null },
      { txt: 'He mentions Socrates inside speech', expect: null },
      { txt: '  Socrates: trimmed', expect: 'Socrates' },
      { txt: 'Socrates replied: answer', expect: 'Socrates' },
      { txt: 'SOCRATES: upper', expect: null }, // all-caps not TitleCase -> not matched (translations use TitleCase)
    ];
    for (const c of cases) {
      const res = await page.evaluate((t) => {
        const fn = (window as unknown as Record<string, unknown>).__englishSpeakerForTest as ((s: string) => string | null) | undefined;
        if (!fn) return '__missing__';
        return fn(t);
      }, c.txt);
      expect(res, `text "${c.txt}" should map to ${c.expect}`).toBe(c.expect);
    }

    // Also test verb pattern case-insensitive
    const verbRes = await page.evaluate(() => {
      const fn = (window as unknown as Record<string, unknown>).__englishSpeakerForTest as ((s: string) => string | null);
      return fn('Socrates answered: indeed');
    });
    expect(verbRes).toBe('Socrates');
    const noColon = await page.evaluate(() => {
      const fn = (window as unknown as Record<string, unknown>).__englishSpeakerForTest as ((s: string) => string | null);
      return fn('Socrates answered indeed without colon but verb present');
    });
    // verb pattern should match even without colon after verb (per spec "Ion said:" pattern)
    expect(noColon).toBe('Socrates');
  });

  test('translation panel does not color inline mentions (Crito inside Socrates speech)', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/${CRITO_HASH}`);
    await page.waitForSelector('.greek-line .w', { timeout: 20000 });
    const englishBtn = page.locator('button', { hasText: /English/ }).first();
    await englishBtn.click();
    const drawer = page.locator('#tr-drawer');
    await expect(drawer).not.toHaveClass(/hidden/);
    await page.waitForSelector('#tr-drawer .tr-unit', { timeout: 10000 });
    // Give time for rendering
    await page.waitForTimeout(500);

    // Fetch rows data
    const rows = await page.$$eval('#tr-drawer .tr-unit', els => els.map(e => ({
      text: (e.querySelector('.tr-text')?.textContent || '').trim(),
      speaker: (e.querySelector('.tr-speaker')?.textContent || '').trim() || null,
      hasSpkClass: !!e.querySelector('.tr-speaker')?.className.match(/spk-\d/),
      disabled: !!e.querySelector('.tr-speaker')?.hasAttribute('data-speaker-disabled'),
      rowClasses: e.className,
    })));

    expect(rows.length).toBeGreaterThan(10);

    // First row is Socrates speaking, translation text contains "Crito" at end but should be Socrates, not Crito
    const first = rows[0];
    // first translation text is "Socrates Why have you come..." -> per strict, englishSpeaker null, fallback Greek ΣΩ => Socrates
    expect(first.speaker).toBe('Socrates');
    // ensure not mislabeled as Crito due to inline mention
    expect(first.speaker).not.toBe('Crito');
    expect(first.text).toContain('Crito');
    // Socrates label should be colored (has spk-) or if disabled, at least not Crito
    if (!first.disabled) {
      expect(first.hasSpkClass).toBeTruthy();
    }

    // Find a row where Greek is Socrates but text contains Crito mid-sentence; ensure not colored as Crito
    // Row 5: "you in Crito He is used to me..." Greek is ΚΡ (Crito) actually? Let's check specific known ambiguous:
    // Row that has text "something for him Socrates Have you just come" -> contains Socrates inside, but Greek is ΚΡ? Hard to know. We'll instead verify general invariant:
    // For every row where speaker is present, the speaker name must NOT be found inside text *except* at very start OR via Greek fallback.
    // We can verify that no row has speaker label that appears ONLY inside text but not at start and Greek would indicate different speaker.
    // To test inline not colored, we check that a row with text "I am surprised that the watchman..." (no speaker at start) that is Socrates Greek, should not be labeled Crito even though next row's text contains Crito.
    // Simpler: Ensure that no row is labeled Crito when its Greek would be Socrates and text contains Crito mid
    // We can fetch Greek speakers via evaluation of window.__translationMappingConfidence etc., but we can also just ensure consistency: all Crito-labeled rows should have Greek fallback source, not inline English detection.
    // Check that at least Socrates and Crito both appear as speakers with consistent hashColor (or both disabled)
    const socRows = rows.filter(r => r.speaker === 'Socrates');
    const criRows = rows.filter(r => r.speaker === 'Crito');
    expect(socRows.length).toBeGreaterThan(0);
    expect(criRows.length).toBeGreaterThan(0);
    // Both should have same coloring approach (both colored or both disabled) - inconsistent would be one colored one disabled
    const socColored = socRows.some(r => r.hasSpkClass);
    const criColored = criRows.some(r => r.hasSpkClass);
    // With our fix, both should be consistently colored (both true) or both disabled (both false) but not one true one false
    expect(socColored).toBe(criColored);
    // Also check disabled flag consistency
    const socDisabled = socRows.some(r => r.disabled);
    const criDisabled = criRows.some(r => r.disabled);
    expect(socDisabled).toBe(criDisabled);

    // Verify that no row has speaker label derived from mid-text mention without Greek fallback:
    // For each row, if speaker exists and text does NOT start with speaker (case-insensitive) and speaker source is english, it would be wrong.
    // Since we now use strict, english source only when start + colon/verb, we can verify via data-speaker-source attribute
    const sourceRows = await page.$$eval('#tr-drawer .tr-unit', els => els.map(e => {
      const lbl = e.querySelector('.tr-speaker') as HTMLElement | null;
      return {
        text: (e.querySelector('.tr-text')?.textContent || '').trim(),
        speaker: lbl?.textContent?.trim() || null,
        source: lbl?.getAttribute('data-speaker-source') || lbl?.getAttribute('data-speaker-disabled') ? 'disabled' : lbl?.getAttribute('data-speaker-source') || null,
      };
    }));
    for (const r of sourceRows) {
      if (r.speaker && r.source === 'english') {
        // English source should mean text starts with speaker before colon/verb
        const startsWithSpeaker = r.text.trim().toLowerCase().startsWith(r.speaker.toLowerCase());
        const colonAtStart = new RegExp(`^\\s*${r.speaker}\\s*:`, 'i').test(r.text);
        const verbAtStart = new RegExp(`^\\s*${r.speaker}\\s+(said|says|replied|answered|asked)`, 'i').test(r.text);
        expect(colonAtStart || verbAtStart || startsWithSpeaker, `English speaker ${r.speaker} should be at very start for text "${r.text.slice(0,60)}"`).toBeTruthy();
      }
    }
  });

  test('translation speaker coloring uses shared hashColor consistently or disabled when low confidence', async ({ page }) => {
    await page.goto(`/${ION_HASH}`);
    await page.waitForSelector('.greek-line .w', { timeout: 20000 });
    await page.locator('button', { hasText: /English/ }).click();
    await page.waitForSelector('#tr-drawer .tr-unit');
    await page.waitForTimeout(500);
    const info = await page.evaluate(() => ({
      disabled: (window as unknown as Record<string, unknown>).__translationColorDisabled,
      confidence: (window as unknown as Record<string, unknown>).__translationMappingConfidence,
      high: (window as unknown as Record<string, unknown>).__translationHighEnglishCount,
    }));
    // For Ion, mapping should be high (>=0.75) so not disabled
    expect(info.disabled).toBe(false);
    expect(info.confidence).toBeGreaterThanOrEqual(0.75);

    // Check that Ion and Socrates use hashColor consistently: compute hashColor via same function as render
    const colors = await page.$$eval('#tr-drawer .tr-speaker', els => els.map(e => ({
      label: (e.textContent || '').trim(),
      cls: e.className,
    })));
    // Find Socrates and Ion colors
    const soc = colors.find(c => c.label === 'Socrates');
    const ion = colors.find(c => c.label === 'Ion');
    if (soc && ion) {
      // Both should have spk- class and not same (usually different hash, but could collide; just ensure they both have spk-)
      expect(soc.cls).toMatch(/spk-\d/);
      expect(ion.cls).toMatch(/spk-\d/);
      // Ensure color is derived via hash lowercased (deterministic)
      const hash = await page.evaluate((label: string) => {
        let h = 0;
        for (const ch of label.toLowerCase()) h = (h * 31 + (ch.codePointAt(0) ?? 0)) >>> 0;
        return h % 10;
      }, 'socrates');
      expect(soc.cls).toContain(`spk-${hash}`);
      const ionHash = await page.evaluate((label: string) => {
        let h = 0;
        for (const ch of label.toLowerCase()) h = (h * 31 + (ch.codePointAt(0) ?? 0)) >>> 0;
        return h % 10;
      }, 'ion');
      expect(ion.cls).toContain(`spk-${ionHash}`);
    }
    // Also test fallback to all black when confidence low: we can simulate by checking that if disabled, no spk- classes present
    // For Ion, should have spk- classes (since not disabled)
    const hasSpk = colors.some(c => /spk-\d/.test(c.cls));
    expect(hasSpk).toBeTruthy();
  });

  test('translation panel resizable gutter drag changes --drawer-width and persists', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/${ION_HASH}`);
    await page.waitForSelector('.greek-line .w', { timeout: 20000 });
    await page.waitForLoadState('networkidle');

    const englishBtn = page.locator('button', { hasText: /English/ }).first();
    await englishBtn.click();
    const drawer = page.locator('#tr-drawer');
    await expect(drawer).not.toHaveClass(/hidden/);
    await page.waitForTimeout(300);

    // Ensure gutter exists
    const gutter = page.locator('[data-testid="drawer-gutter-right"]');
    await expect(gutter).toBeVisible({ timeout: 5000 });

    const getWidth = async () => await page.evaluate(() => {
      const v = getComputedStyle(document.documentElement).getPropertyValue('--drawer-width').trim();
      if (v.endsWith('px')) return parseFloat(v);
      if (v.endsWith('rem')) return parseFloat(v) * parseFloat(getComputedStyle(document.documentElement).fontSize);
      return parseFloat(v);
    });
    const getLs = async () => await page.evaluate(() => localStorage.getItem('drawer-width'));
    const getAppMargin = async () => await page.evaluate(() => {
      const el = document.getElementById('app') as HTMLElement;
      return parseFloat(getComputedStyle(el).marginRight);
    });

    const initialW = await getWidth();
    expect(initialW).toBeGreaterThanOrEqual(280);
    expect(initialW).toBeLessThanOrEqual(1440 * 0.6 + 1);

    const box = await gutter.boundingBox();
    expect(box).not.toBeNull();
    if (!box) return;
    const startX = box.x + box.width / 2;
    const startY = box.y + box.height / 2;

    // Drag left to increase width (right drawer: moving left increases width)
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    // move 120px left
    await page.mouse.move(startX - 120, startY, { steps: 12 });
    await page.mouse.up();
    await page.waitForTimeout(400);

    const afterW = await getWidth();
    // Should have increased approx 120 (with tolerance)
    expect(afterW).toBeGreaterThan(initialW + 60);
    expect(afterW).toBeGreaterThanOrEqual(280);
    expect(afterW).toBeLessThanOrEqual(1440 * 0.6 + 1);
    // Check margin recalculated
    const marginAfter = await getAppMargin();
    expect(marginAfter).toBeGreaterThan(100);

    // Check persistence
    const ls = await getLs();
    expect(ls).not.toBeNull();
    expect(parseFloat(ls!)).toBeCloseTo(afterW, 0);

    // Test min clamp: drag far right to try to make width <280, should clamp to 280
    const box2 = await gutter.boundingBox();
    if (box2) {
      const sx2 = box2.x + box2.width / 2;
      const sy2 = box2.y + box2.height / 2;
      await page.mouse.move(sx2, sy2);
      await page.mouse.down();
      // move far right (decrease width)
      await page.mouse.move(1440 - 10, sy2, { steps: 15 });
      await page.mouse.up();
      await page.waitForTimeout(400);
      const minW = await getWidth();
      expect(minW).toBeGreaterThanOrEqual(280);
      expect(minW).toBeLessThanOrEqual(1440 * 0.6 + 1);
    }

    // Test max clamp: drag far left to exceed 60vw
    const box3 = await gutter.boundingBox();
    if (box3) {
      const sx3 = box3.x + box3.width / 2;
      const sy3 = box3.y + box3.height / 2;
      await page.mouse.move(sx3, sy3);
      await page.mouse.down();
      await page.mouse.move(0, sy3, { steps: 15 });
      await page.mouse.up();
      await page.waitForTimeout(400);
      const maxW = await getWidth();
      expect(maxW).toBeLessThanOrEqual(1440 * 0.6 + 5);
      expect(maxW).toBeGreaterThanOrEqual(280);
    }

    // Verify touch handle also exists (same element handles both)
    await expect(gutter).toHaveAttribute('role', 'separator');
  });

  test('lexicon drawer also has resizable gutter and shares --drawer-width', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/${ION_HASH}`);
    await page.waitForSelector('.greek-line .w', { timeout: 20000 });

    // Open lexicon
    const lexBtn = page.locator('.controls button', { hasText: /Lexicon/i }).first();
    await expect(lexBtn).toBeVisible();
    await lexBtn.click();
    const leftDrawer = page.locator('.drawer.left');
    await expect(leftDrawer).not.toHaveClass(/hidden/);
    await page.waitForTimeout(300);
    const leftGutter = page.locator('[data-testid="drawer-gutter-left"]');
    await expect(leftGutter).toBeVisible({ timeout: 5000 });

    const getWidth = async () => await page.evaluate(() => {
      const v = getComputedStyle(document.documentElement).getPropertyValue('--drawer-width').trim();
      if (v.endsWith('px')) return parseFloat(v);
      if (v.endsWith('rem')) return parseFloat(v) * parseFloat(getComputedStyle(document.documentElement).fontSize);
      return parseFloat(v);
    });
    const initial = await getWidth();

    const box = await leftGutter.boundingBox();
    expect(box).not.toBeNull();
    if (!box) return;
    // Drag right to increase left drawer width
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + 100, box.y + box.height / 2, { steps: 10 });
    await page.mouse.up();
    await page.waitForTimeout(400);
    const after = await getWidth();
    expect(after).toBeGreaterThan(initial);
    // Check that main app margin-left also updated
    const appMarginLeft = await page.evaluate(() => {
      const el = document.getElementById('app') as HTMLElement;
      return parseFloat(getComputedStyle(el).marginLeft);
    });
    expect(appMarginLeft).toBeGreaterThan(100);
  });

  test('persisted width survives reload', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/${ION_HASH}`);
    await page.waitForSelector('.greek-line .w', { timeout: 20000 });
    // Set a known width via evaluation
    await page.evaluate(() => {
      const w = 420;
      document.documentElement.style.setProperty('--drawer-width', `${w}px`);
      localStorage.setItem('drawer-width', String(w));
    });
    await page.reload();
    await page.waitForSelector('.greek-line .w', { timeout: 20000 });
    const persisted = await page.evaluate(() => {
      const v = getComputedStyle(document.documentElement).getPropertyValue('--drawer-width').trim();
      return parseFloat(v);
    });
    const ls = await page.evaluate(() => localStorage.getItem('drawer-width'));
    expect(ls).toBe('420');
    expect(persisted).toBeCloseTo(420, 0);
  });
});
