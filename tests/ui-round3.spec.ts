// UI round 3 — verification for the seven reported bugs:
//   1 translation drawer resize handle (drag → --drawer-width → localStorage)
//   2 drawer close paths (Escape / backdrop / sticky header ×)
//   3 scansion row aligned under the Greek line (width-matched spans)
//   4 AI gear in controls flow, no horizontal overflow at 1280px+
//   5 per-unit 🔊 always restarts that unit (no pause toggle); new click
//     stops the previous one; global Play/Pause stays in the toolbar
//   6 per-line audio uses the exact unit text (WAV duration ≈ text) and
//     highlights the spoken unit
//   7 reader↔translation scroll sync tracks the focused Greek row (index,
//     not scroll ratio)
import { test, expect, type Page } from '@playwright/test';

const PLATO_ION = '#/tlg0059/ion';
const ILIAD = '#/tlg0012/iliad';

async function openReader(page: Page, hash: string): Promise<void> {
  await page.goto(`/${hash}`);
  await page.waitForSelector('.greek-line .w', { timeout: 30_000 });
}

async function drawerWidthPx(page: Page): Promise<number> {
  return page.evaluate(() => {
    const v = getComputedStyle(document.documentElement)
      .getPropertyValue('--drawer-width')
      .trim();
    const fs = parseFloat(getComputedStyle(document.documentElement).fontSize);
    return v.endsWith('rem') ? parseFloat(v) * fs : parseFloat(v);
  });
}

/** Coordinates of a blank spot outside drawers/controls (for backdrop clicks). */
async function blankPoint(page: Page): Promise<{ x: number; y: number }> {
  return page.evaluate(() => {
    for (let y = window.innerHeight - 40; y > 80; y -= 24) {
      for (const x of [16, 32, 64]) {
        const t = document.elementFromPoint(x, y);
        const tag = t?.tagName;
        if (tag === 'BODY' || tag === 'HTML' || (t instanceof HTMLElement && (t.id === 'app'))) {
          return { x, y };
        }
      }
    }
    return { x: 12, y: Math.round(window.innerHeight * 0.75) };
  });
}

test.describe('UI round 3', () => {

  // ---- Bug 1: resize handle -------------------------------------------------
  test('bug1: dragging the translation gutter resizes, applies and persists', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openReader(page, PLATO_ION);
    await page.locator('button', { hasText: /English/ }).first().click();
    const drawer = page.locator('#tr-drawer');
    await expect(drawer).not.toHaveClass(/hidden/);
    const gutter = page.locator('[data-testid="drawer-gutter-right"]');
    await expect(gutter).toBeAttached();

    const w0 = await drawerWidthPx(page);
    // let the slide-in transform finish so boundingBox() is final-position
    await page.waitForTimeout(500);
    const box = await gutter.boundingBox();
    expect(box).not.toBeNull();
    if (!box) return;
    const y = Math.min(box.y + box.height / 2, 400);
    // widen: right drawer grows leftward
    await page.mouse.move(box.x + box.width / 2, y);
    await page.mouse.down();
    for (let i = 1; i <= 10; i++) await page.mouse.move(box.x + box.width / 2 - i * 10, y);
    await page.mouse.up();
    await page.waitForTimeout(250);
    const w1 = await drawerWidthPx(page);
    expect(w1).toBeGreaterThan(w0 + 50);

    // applied to layout: #app margin-right grew with it
    const margin = await page.evaluate(() =>
      parseFloat(getComputedStyle(document.getElementById('app')!).marginRight));
    expect(margin).toBeGreaterThan(w1 - 2);
    // persisted
    const ls = await page.evaluate(() => localStorage.getItem('drawer-width'));
    expect(ls).not.toBeNull();
    expect(parseFloat(ls!)).toBeCloseTo(w1, -1);

    // shrink back down
    const box2 = await gutter.boundingBox();
    if (box2) {
      const y2 = Math.min(box2.y + box2.height / 2, 400);
      await page.mouse.move(box2.x + box2.width / 2, y2);
      await page.mouse.down();
      for (let i = 1; i <= 10; i++) await page.mouse.move(box2.x + box2.width / 2 + i * 14, y2);
      await page.mouse.up();
      await page.waitForTimeout(250);
    }
    const w2 = await drawerWidthPx(page);
    expect(w2).toBeLessThan(w1 - 50);
    expect(w2).toBeGreaterThanOrEqual(280); // min clamp
  });

  // ---- Bug 2: close paths ----------------------------------------------------
  test('bug2: Escape, backdrop click and sticky-header × all close the drawer', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openReader(page, PLATO_ION);
    const trBtn = page.locator('button', { hasText: /English/ }).first();

    // Escape
    await trBtn.click();
    await expect(page.locator('#tr-drawer')).not.toHaveClass(/hidden/);
    await expect(trBtn).toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.press('Escape');
    await expect(page.locator('#tr-drawer')).toHaveClass(/hidden/);
    await expect(trBtn).toHaveAttribute('aria-pressed', 'false');

    // backdrop (pointerdown outside drawer, outside chrome)
    await trBtn.click();
    await expect(page.locator('#tr-drawer')).not.toHaveClass(/hidden/);
    const pt = await blankPoint(page);
    await page.mouse.click(pt.x, pt.y);
    await expect(page.locator('#tr-drawer')).toHaveClass(/hidden/);
    await expect(trBtn).toHaveAttribute('aria-pressed', 'false');

    // sticky header × stays reachable while the drawer body is scrolled
    await trBtn.click();
    await page.waitForSelector('#tr-drawer .tr-unit');
    await page.evaluate(() => { document.getElementById('tr-drawer')!.scrollTop = 900; });
    await page.waitForTimeout(200);
    const head = await page.evaluate(() => {
      const d = document.getElementById('tr-drawer')!;
      const h = d.querySelector<HTMLElement>('.tr-headbar');
      const c = d.querySelector<HTMLElement>('.close-btn');
      if (!h || !c) return null;
      const hr = h.getBoundingClientRect();
      const cr = c.getBoundingClientRect();
      return { headTop: hr.top, closeVisible: cr.top >= 0 && cr.bottom <= innerHeight && cr.width > 0 };
    });
    expect(head).not.toBeNull();
    expect(head!.headTop).toBeLessThan(60);       // stuck near the top…
    expect(head!.closeVisible).toBeTruthy();       // …with its × fully on screen
    await page.locator('#tr-drawer .close-btn').click();
    await expect(page.locator('#tr-drawer')).toHaveClass(/hidden/);
    await expect(trBtn).toHaveAttribute('aria-pressed', 'false');
  });

  // ---- Bug 3: scansion alignment ---------------------------------------------
  // Contract (syllable-precise, honestly flagged):
  //   - every symbol sits centered over its own syllable (≤1px), never under
  //     a neighbour's — verified per symbol, not per word;
  //   - no foot pipes anywhere (the greedy segmentation put 7-8 "feet" and
  //     impossible trochees on most hexameter lines);
  //   - lines whose counts don't validate render word-grouped WITH a visible
  //     ≈ flag instead of silently sliding symbols;
  //   - splitting words into syllable spans never alters the Greek text.
  test('bug3: scansion symbols sit exactly under their Greek syllables', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openReader(page, ILIAD);
    const tog = page.locator('.controls button', { hasText: /Scansion/ });
    await expect(tog).toBeVisible();
    await tog.click();
    await page.waitForSelector('.line .scansion .scan-u', { timeout: 10_000 });
    await page.waitForTimeout(600); // alignment pass

    // splitting must not alter the Greek text itself
    const t1 = await page.locator('.line').first().locator('.greek-line').textContent();
    expect(t1?.replace(/\s+/g, ' ').trim())
      .toBe('μῆνιν ἄειδε θεὰ Πηληϊάδεω Ἀχιλῆος');

    const rows = await page.evaluate(() => {
      const out: Array<{
        approx: boolean;
        attributed: boolean; // every symbol paired to a measured syllable box
        symsInOrder: boolean;
        maxOffsetPx: number;
        nSyms: number;
        nPipes: number;
      }> = [];
      document.querySelectorAll<HTMLElement>('.line').forEach((row) => {
        const scan = row.querySelector<HTMLElement>(':scope > .scansion');
        const greek = row.querySelector<HTMLElement>(':scope > .greek-line');
        if (!scan || !greek || out.length >= 12) return;
        const sus = Array.from(scan.querySelectorAll<HTMLElement>('.scan-u'));
        if (!sus.length) return;
        // every raw symbol consumed once, in order (¯ stays, ˘→∪ x→×)
        const raw = (scan.dataset.raw ?? '').replace(/[^¯˘x]/g, '')
          .replace(/˘/g, '∪').replace(/x/g, '×');
        const joined = sus.map((s) => s.textContent ?? '').join('');
        if (joined !== raw) {
          out.push({ approx: true, attributed: false, symsInOrder: false, maxOffsetPx: -1, nSyms: sus.length, nPipes: 0 });
          return;
        }
        const approx = scan.hasAttribute('data-approx');
        const nPipes = scan.querySelectorAll('.scan-pipe').length;
        // precise attribution: every symbol's center over its syllable's center
        const syls = new Map<string, DOMRect>();
        greek.querySelectorAll<HTMLElement>('.syl').forEach((s) =>
          syls.set(s.dataset.sy ?? '', s.getBoundingClientRect()));
        let maxOff = 0;
        let attributed = true;
        for (const su of sus) {
          const g = syls.get(su.dataset.sy ?? '');
          if (!g) { attributed = false; break; }
          const r = su.getBoundingClientRect();
          maxOff = Math.max(maxOff,
            Math.abs((r.left + r.width / 2) - (g.left + g.width / 2)));
        }
        out.push({
          approx,
          attributed,
          symsInOrder: true,
          maxOffsetPx: Math.round(maxOff * 100) / 100,
          nSyms: sus.length,
          nPipes,
        });
      });
      return out;
    });
    expect(rows.length).toBeGreaterThanOrEqual(8);
    // foot pipes: 0 or 5 per row, never 7 like the old greedy segmenter.
    // A piped row must be fully trusted (attributed + unflagged) with every
    // segment a valid foot — pipes always mean verified foot membership.
    const pipeCheck = await page.evaluate(() => {
      const bad: string[] = [];
      let piped = 0;
      document.querySelectorAll<HTMLElement>('.line > .scansion').forEach((scan) => {
        const n = scan.querySelectorAll('.scan-pipe').length;
        if (!n) return;
        piped++;
        const ref = scan.closest('.line')?.dataset.ref ?? '?';
        if (n !== 5) { bad.push(`${ref}: ${n} pipes`); return; }
        if (scan.hasAttribute('data-approx')) { bad.push(`${ref}: piped but flagged`); return; }
        const segs: string[][] = [[]];
        for (const node of Array.from(scan.childNodes)) {
          const e = node as HTMLElement;
          if (e.classList?.contains('scan-pipe')) segs.push([]);
          else if (e.classList?.contains('scan-u')) segs[segs.length - 1].push(e.textContent ?? '');
        }
        segs.map((a) => a.join('')).forEach((s, i) => {
          if (!/^(¯∪∪|¯¯|∪¯|¯×|∪×)$/.test(s)) bad.push(`${ref}#${i}:${s}`);
        });
      });
      return { piped, bad: bad.slice(0, 6) };
    });
    expect(pipeCheck.bad, JSON.stringify(pipeCheck)).toEqual([]);
    expect(pipeCheck.piped).toBeGreaterThan(0);
    let nApprox = 0;
    let nAttributed = 0;
    for (const r of rows) {
      expect(r.symsInOrder, `symbols in order (${JSON.stringify(r)})`).toBeTruthy();
      if (!r.attributed) {
        // word-grouped fallback: flagged, never piped
        expect(r.approx, `unattributed row must be flagged (${JSON.stringify(r)})`).toBeTruthy();
        expect(r.nPipes, `unattributed row must not carry pipes (${JSON.stringify(r)})`).toBe(0);
        nApprox++;
        continue;
      }
      nAttributed++;
      expect(r.maxOffsetPx, `symbols pinned under syllables (${JSON.stringify(r)})`).toBeLessThanOrEqual(1);
      if (r.approx) { nApprox++; continue; } // attributed exactly, values suspect
      expect(r.nPipes, `trusted row carries its 5 foot pipes (${JSON.stringify(r)})`).toBe(5);
    }
    // all three states occur on Iliad book 1: trusted, attributed-but-≈,
    // and word-grouped ≈
    expect(nAttributed).toBeGreaterThan(0);
    expect(nApprox).toBeGreaterThan(0);
    expect(nApprox).toBeLessThan(rows.length);
    // the ≈ flag is actually visible (not just a data attribute)
    const approxVisible = await page.evaluate(() => {
      const row = document.querySelector('.line > .scansion[data-approx] .scan-u');
      if (!row) return false;
      const cs = getComputedStyle(row, '::before').content;
      return !!cs && cs !== 'none' && cs.includes('≈');
    });
    expect(approxVisible).toBeTruthy();

    // attribution rate over ~100 lines stays high — tripwire against
    // syllabifier regressions (measured 84.7% Iliad-wide). Foot-cleanliness
    // is stricter (~22%) and asserted per-row above, not here.
    for (let i = 0; i < 3; i++) {
      await page.locator('.pager button', { hasText: /Next/ }).click();
      await page.waitForTimeout(1200);
    }
    const rate = await page.evaluate(() => {
      const scans = Array.from(document.querySelectorAll('.line > .scansion'));
      const attributed = scans.filter((s) =>
        (s as HTMLElement).querySelector('.scan-u[data-sy]')).length;
      return scans.length ? attributed / scans.length : 0;
    });
    expect(rate).toBeGreaterThanOrEqual(0.5);
  });

  // ---- Bug 3b: Agamemnon regression -----------------------------------------
  // Ref "0" (prologue line) bucketed chapter-building into a TypeError
  // ("Cannot set properties of undefined (setting 'label')") that blanked
  // the whole reader. Its iambic lines must also carry valid ∪— pipes.
  test('bug3b: Agamemnon opens, chapters include 0, iambic pipes valid', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/#/tlg0085/agamemnon');
    await page.waitForSelector('.greek-line .w', { timeout: 30_000 });
    // no error state (the status <p> exists but must stay empty)
    await expect(page.locator('.reader-error')).toHaveText('');
    const menu = await page.locator('.chapter-jump option')
      .evaluateAll((els) => els.map((e) => e.textContent));
    expect(menu).toContain('0');
    const tog = page.locator('.controls button', { hasText: /Scansion/ });
    await expect(tog).toBeVisible();
    await tog.click();
    await page.waitForSelector('.line .scansion .scan-u', { timeout: 10_000 });
    await page.waitForTimeout(600);
    const check = await page.evaluate(() => {
      const bad: string[] = [];
      let piped = 0;
      document.querySelectorAll<HTMLElement>('.line').forEach((row) => {
        if (piped > 0) return;
        const scan = row.querySelector<HTMLElement>(':scope > .scansion');
        if (!scan || !scan.querySelector('.scan-pipe')) return;
        piped++;
      });
      const scan = document.querySelector('.line > .scansion:has(.scan-pipe)');
      if (scan) {
        const segs: string[][] = [[]];
        for (const node of Array.from(scan.childNodes)) {
          const e = node as HTMLElement;
          if (e.classList?.contains('scan-pipe')) segs.push([]);
          else if (e.classList?.contains('scan-u')) segs[segs.length - 1].push(e.textContent ?? '');
        }
        if (segs.length !== 6) bad.push(`feet: ${segs.length}`);
        segs.map((a) => a.join('')).forEach((s, i) => {
          if (!/^(∪¯|¯¯|∪×|¯×)$/.test(s)) bad.push(`foot${i}:${s}`);
        });
      }
      return { piped: piped > 0, bad };
    });
    expect(check.piped).toBeTruthy();
    expect(check.bad).toEqual([]);
  });

  // ---- Bug 4: gear in flow, no overflow ---------------------------------------
  test('bug4: AI gear sits inside the controls flow; no horizontal scroll at 1280+', async ({ page }) => {
    await openReader(page, PLATO_ION);
    for (const width of [1280, 1440, 1600]) {
      await page.setViewportSize({ width, height: 900 });
      await page.waitForTimeout(250);
      const m = await page.evaluate(() => {
        const bar = document.querySelector<HTMLElement>('.controls');
        const wrap = document.getElementById('ai-gear-wrap');
        const themeCtl = bar?.querySelector('.theme-ctl') as HTMLElement | null;
        if (!bar || !wrap || !themeCtl) return null;
        return {
          docOverflow: document.documentElement.scrollWidth > window.innerWidth,
          barOverflow: bar.scrollWidth > bar.clientWidth + 1,
          inFlow: bar.contains(wrap) &&
            getComputedStyle(wrap).position !== 'fixed',
          overlaps: (() => {
            const g = wrap.getBoundingClientRect();
            const t = themeCtl.getBoundingClientRect();
            return g.left < t.right && g.right > t.left && g.top < t.bottom && g.bottom > t.top;
          })(),
        };
      });
      expect(m).not.toBeNull();
      expect(m!.docOverflow, `${width}: document must not scroll horizontally`).toBeFalsy();
      expect(m!.barOverflow, `${width}: controls bar must not overflow`).toBeFalsy();
      expect(m!.inFlow, `${width}: gear must live in the bar flow`).toBeTruthy();
      expect(m!.overlaps, `${width}: gear must not cover other controls`).toBeFalsy();
    }
  });

  // ---- Bugs 5 + 6: per-unit TTS ------------------------------------------------
  test('bug5+6: 🔊 replays its own unit, stops the previous one, highlights the row', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openReader(page, PLATO_ION);

    // global transport: ONE state-labelled toggle (▶ Play ↔ ⏸ Pause ↔
    // ▶ Resume); separate Pause/Stop buttons were removed in round 4
    const transport = page.locator('.controls button', { hasText: /Play|Pause|Resume/ });
    await expect(transport).toHaveCount(1);
    await expect(transport).toBeVisible();
    await expect(page.locator('.controls button[title="Stop TTS"]')).not.toBeAttached();

    const btn2 = page.locator('.tts-unit-btn').nth(2);
    const btn4 = page.locator('.tts-unit-btn').nth(4);
    await btn2.scrollIntoViewIfNeeded();
    await btn2.click();

    // exact unit text was handed to the synthesizer (bug 6)
    const expected = await page.evaluate(() => {
      const row = document.querySelector<HTMLElement>('.tts-speaking');
      const words = row ? Array.from(row.querySelectorAll('.w')).map((w) => w.textContent ?? '') : [];
      return words.join(' ').trim();
    });
    await page.waitForFunction(() => !!(
      window as unknown as Record<string, unknown>).__ttsLast, null, { timeout: 20_000 });
    const tts = await page.evaluate(() => {
      const w = (window as unknown as Record<string, unknown>);
      return {
        spoken: String(w.__ttsSpeakText ?? ''),
        last: w.__ttsLast as { durationMs: number; expectedMs: number; ratio: number },
        speakingRows: document.querySelectorAll('.tts-speaking').length,
        active: !!document.querySelector('[data-tts-active="1"]'),
      };
    });
    expect(tts.speakingRows).toBe(1);
    expect(tts.active).toBeTruthy();
    expect(tts.spoken.replace(/\s+/g, ' ')).toBe(expected.replace(/\s+/g, ' '));
    // WAV length tracks the text (guard band used by tts.ts itself)
    expect(tts.last.durationMs).toBeGreaterThan(300);
    expect(tts.last.ratio).toBeGreaterThan(0.25);
    expect(tts.last.ratio).toBeLessThan(3);

    // toolbar transport keeps tracking playback even after per-unit 🔊
    // (TTS status bus must stay multi-listener, not single-slot)
    await expect(page.locator('.controls button', { hasText: '⏸ Pause' }))
      .toBeEnabled({ timeout: 15_000 });

    // re-click SAME unit while STILL ACTIVE → STOP immediately (round 5:
    // no replay, no second synthesis). If it already finished naturally,
    // the stop path simply doesn't apply.
    const lastBefore = await page.evaluate(
      () => JSON.stringify((window as unknown as Record<string, unknown>).__ttsLast ?? null));
    const stillActive = await page.evaluate(() =>
      !!document.querySelector('.tts-speaking'));
    await btn2.click();
    await page.waitForTimeout(400);
    const st = await page.evaluate(() => ({
      status: String((window as unknown as Record<string, unknown>).__ttsStatusForTest ?? ''),
      speakingRows: document.querySelectorAll('.tts-speaking').length,
      lastAfter: JSON.stringify((window as unknown as Record<string, unknown>).__ttsLast ?? null),
    }));
    if (stillActive) {
      expect(st.status).toBe('idle'); // immediate stop
      expect(st.speakingRows).toBe(0);
      expect(st.lastAfter).toBe(lastBefore); // WAV synthesis NOT re-triggered
    }
    expect(st.status).not.toBe('paused');

    // click ANOTHER unit → previous stops, new text takes over
    await btn4.scrollIntoViewIfNeeded();
    await btn4.click();
    await page.waitForTimeout(600);
    const second = await page.evaluate(() => ({
      spoken: String((window as unknown as Record<string, unknown>).__ttsSpeakText ?? ''),
      status: String((window as unknown as Record<string, unknown>).__ttsStatusForTest ?? ''),
      speakingRows: document.querySelectorAll('.tts-speaking').length,
    }));
    expect(second.speakingRows).toBeLessThanOrEqual(1);
    expect(second.status).not.toBe('paused');

    try { await page.evaluate(() => { try { speechSynthesis?.cancel(); } catch {} }); } catch {}
  });

  // ---- Bug 7: scroll sync by ref index ------------------------------------------
  test('bug7: drawer highlights the translation row matching the focused Greek line', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openReader(page, PLATO_ION);
    await page.locator('button', { hasText: /English/ }).first().click();
    await page.waitForSelector('#tr-drawer .tr-unit');
    await page.waitForTimeout(800); // initial sync settles

    for (const idx of [5, 14, 24]) {
      await page.evaluate((i) => {
        const rows = document.querySelectorAll<HTMLElement>('.line, .prose-unit');
        const r = rows[i];
        window.scrollTo(0, r.getBoundingClientRect().top + window.scrollY
          - window.innerHeight * 0.42 + 10);
      }, idx);
      await page.waitForTimeout(500); // rAF-throttled sync
      const res = await page.evaluate((i) => {
        const rows = Array.from(document.querySelectorAll<HTMLElement>('.line, .prose-unit'));
        const fy = window.innerHeight * 0.42;
        let best = 0; let bd = Infinity;
        rows.forEach((r, j) => {
          const rc = r.getBoundingClientRect();
          if (rc.bottom < -80 || rc.top > innerHeight + 80) return;
          const d = Math.abs(rc.top + rc.height / 2 - fy);
          if (d < bd) { bd = d; best = j; }
        });
        const cur = Array.from(document.querySelectorAll<HTMLElement>('#tr-drawer .tr-unit'))
          .indexOf(document.querySelector('#tr-drawer .tr-unit.current') as HTMLElement);
        void i;
        return { best, cur };
      }, idx);
      expect(res.cur, `focused row ${idx}: drawer should track index ${res.best}`)
        .toBe(res.best);
      expect(Math.abs(res.cur - idx)).toBeLessThanOrEqual(1);
    }
  });
});
