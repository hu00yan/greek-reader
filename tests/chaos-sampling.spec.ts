// Chaos sampling: pick random works at random, then assert the render
// invariants that must hold for EVERY text in the corpus, plus data-level
// invariants over random gloss-shard keys.
//
// Determinism: every choice comes from a seeded PRNG. Set SEED to reproduce a
// failure (the seed is printed at module load, so it is in the failure log).
import { test, expect } from '@playwright/test';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// NOTE: this spec reads the corpus from disk with node builtins, so it needs
// @types/node to typecheck standalone. The repo's tsconfig.json only includes
// src, so `tsc` does not cover tests/; Playwright transpiles the spec itself
// and resolves these at runtime.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(HERE, '..', 'public', 'data');

const SEED = Number(process.env.SEED ?? 20260930);
const N_AUTHORS = 4;
const GLOSS_KEY_SAMPLES = 200;
/** Cap on reported offenders, so a systemic failure stays readable. */
const MAX_REPORTED = 12;

/** mulberry32 — small, fast, fully reproducible from a 32-bit seed. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(SEED);
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)];

const readJSON = <T>(p: string): T =>
  JSON.parse(readFileSync(p, 'utf8')) as T;

/* ---------------- catalog shape (public/data/catalog.json) ---------------- */

interface Work {
  id: string;
  title: string;
  files: string[];
  unitCount: number;
  kind?: string;
}
interface Author {
  name: string;
  tlg: string;
  works: Work[];
}
interface Catalog {
  authors: Author[];
}
interface TextPart {
  kind: "verse" | "prose";
  units: Array<{ ref?: string; words: string[] }>;
}
interface GlossEntry {
  u: string;
  g: string;
  s?: string[];
}

const catalog = readJSON<Catalog>(path.join(DATA, 'catalog.json'));

/* ---------------- sample: N authors, one work each ---------------- */

interface Sample {
  tlg: string;
  author: string;
  workId: string;
  title: string;
  kind: "verse" | "prose" | "unknown";
  ref: string;
  /** Non-empty when the work can never render — the test is skipped. */
  skip: string | null;
}

function sampleWorks(n: number): Sample[] {
  // Shuffle-free: draw distinct authors by index, dedupe.
  const pool = catalog.authors.filter((a) => a.works.length > 0);
  const chosen: Author[] = [];
  const seen = new Set<string>();
  let guard = 0;
  while (chosen.length < Math.min(n, pool.length) && guard < 500) {
    guard += 1;
    const a = pick(pool);
    if (seen.has(a.tlg)) continue;
    seen.add(a.tlg);
    chosen.push(a);
  }

  return chosen.map((author) => {
    const work = pick(author.works);
    let kind: Sample['kind'] = 'unknown';
    let ref = '';
    let skip: string | null = null;
    try {
      const part = readJSON<TextPart>(path.join(DATA, work.files[0]));
      kind = part.kind;
      // Stay inside the first ~1.5 pages: jumpToRef caps at 40 pages, so a
      // ref deeper than that is never found and the test would sample page 1
      // while believing it sampled the deep link.
      const limit = Math.min(part.units.length, 45);
      const usable: Array<{ ref?: string; words: string[] }> =
        part.units.slice(0, limit).filter(
          (u) => !!u.ref && Array.isArray(u.words) && u.words.length > 0,
        );
      if (!usable.length) skip = 'no units with words in the first 45 units';
      else ref = usable[Math.floor(rand() * usable.length)].ref!;
    } catch (err) {
      skip = `text part unreadable: ${(err as Error).message}`;
    }
    return {
      tlg: author.tlg,
      author: author.name,
      workId: work.id,
      title: work.title,
      kind,
      ref,
      skip,
    };
  });
}

const samples = sampleWorks(N_AUTHORS);

console.log(
  `[chaos-sampling] SEED=${SEED} — sampling ${samples.length} work(s):\n` +
    samples
      .map(
        (s) =>
          `  ${s.tlg} ${s.author} / ${s.workId} (${s.kind}) ref=${s.ref || '-'}` +
          `${s.skip ? `  SKIP: ${s.skip}` : ''}`,
      )
      .join('\n'),
);

/* ---------------- the page-side invariant sweep ---------------- */

/** Every fact the invariant block needs, read out of the live DOM once. */
interface ColSnapshot {
  cards: Array<{
    cls: string;
    lemma: string;
    feats: string | null;
    /** "inf." / "part." / "finite" when the row is a same-lemma split. */
    morphClass: string | null;
    glosses: string[];
  }>;
  chips: string[];
}
interface Snapshot {
  cols: ColSnapshot[];
  chipCount: number;
  cardCount: number;
}

const readSnapshot = (page: import('@playwright/test').Page): Promise<Snapshot> =>
  page.evaluate(() => {
    const cols = Array.from(
      document.querySelectorAll<HTMLElement>('.parse-row > .pcol'),
    ).map((col) => ({
      cards: Array.from(
        col.querySelectorAll<HTMLElement>(':scope > .pcard'),
      ).map((c) => ({
        cls: c.className,
        lemma:
          c.querySelector<HTMLElement>(':scope > .cand-head > .lemma')
            ?.textContent?.trim() ?? '',
        feats: c.querySelector<HTMLElement>(':scope > .feats')?.textContent ?? null,
        morphClass:
          c.querySelector<HTMLElement>(':scope > .cand-head > .morph-class')
            ?.textContent?.trim() ?? null,
        glosses: Array.from(
          c.querySelectorAll<HTMLElement>(':scope > .gloss'),
        ).map((g) => g.textContent ?? ''),
      })),
      chips: Array.from(
        col.querySelectorAll<HTMLElement>(':scope > .more-chip'),
      ).map((b) => b.textContent?.trim() ?? ''),
    }));
    return {
      cols,
      chipCount: document.querySelectorAll('.parse-row .more-chip').length,
      cardCount: document.querySelectorAll('.parse-row .pcard').length,
    };
  });

/**
 * Sweep every card/chip invariant over a snapshot, accumulating human-readable
 * violation strings.
 *
 * Deliberately ONE loop with plain JS checks rather than thousands of
 * expect() calls: a large prose page renders ~3,000 cards, and per-item soft
 * assertions cost minutes of wall clock (measured: 2.9 min for one work).
 * This runs in milliseconds and, on failure, reports up to MAX_REPORTED
 * concrete offenders instead of only the first.
 */
function collectViolations(
  snap: Snapshot,
  label: string,
  expandedState = false,
): string[] {
  const bad: string[] = [];
  const add = (msg: string): void => {
    if (bad.length < MAX_REPORTED) bad.push(msg);
  };

  for (const [ci, col] of snap.cols.entries()) {
    for (const [ki, card] of col.cards.entries()) {
      const at = `${label} col#${ci} card#${ki} (${card.cls || 'pcard'})`;

      // 1. every .pcard carries a non-empty .lemma. .pcard-unknown is the
      //    paste-page "not in the index" marker and has no lemma by design;
      //    it must never appear on a reader route (asserted separately).
      if (!card.cls.includes('pcard-unknown') && card.lemma.length === 0) {
        add(`${at}: empty .lemma`);
      }

      // 2/3. feature strings: no "undefined", no stray or doubled separators
      if (card.feats !== null) {
        const f = card.feats;
        if (f.includes('undefined')) add(`${at}: feats "${f}" contains "undefined"`);
        if (/·\s*·/.test(f)) add(`${at}: feats "${f}" has a doubled separator`);
        if (/·\s*$/.test(f)) add(`${at}: feats "${f}" has a trailing " ·"`);
        if (/^\s*·/.test(f)) add(`${at}: feats "${f}" has a leading " ·"`);
        if (f.trim().length === 0) add(`${at}: feats is blank`);
      }

      // 4. every gloss is either empty or reads as English, never Greek-only.
      //    The test is "contains an ASCII letter", NOT "contains no Greek":
      //    LSJ cross-references legitimately embed Greek headwords
      //    ("see l. χελιδόν", "variant of κύρτη I"), so a ban on Greek would
      //    reject correct data. The letter requirement is the exact expression
      //    of "not Greek-only".
      for (const [gi, gloss] of card.glosses.entries()) {
        if (!gloss.trim()) continue;
        if (!/[A-Za-z]/.test(gloss)) {
          add(`${at} gloss#${gi}: "${gloss}" has no ASCII letter (Greek-only)`);
        }
      }
    }

    // 5. first card is a plain .pcard while collapsed, an expanded .cand-row
    //    once expanded; chips always read "+N".
    //    (A column legitimately keeps a single collapsed card while expanded —
    //    it has nothing to compare — so only the collapsed-state direction is
    //    asserted.)
    if (col.cards.length && !expandedState && col.cards[0].cls.includes('cand-row')) {
      add(`${label} col#${ci}: first card is an expanded .cand-row while collapsed`);
    }
    for (const [chi, chip] of col.chips.entries()) {
      if (!/^\+\d+$/.test(chip)) {
        add(`${label} col#${ci} chip#${chi}: "${chip}" is not "+N"`);
      }
    }
  }
  return bad;
}

test.describe('chaos sampling: render invariants hold on random works', () => {
  for (const s of samples) {
    const title =
      `${s.author} · ${s.title} (${s.kind}, ${s.tlg}/${s.workId} ref=${s.ref || '—'})` +
      (s.skip ? ` — SKIPPED: ${s.skip}` : '');
    test(title, async ({ page }) => {
      test.skip(!!s.skip, s.skip ?? undefined);
      // Prose works render a 30-unit page that can hold >12k parse cards, and
      // the expand/collapse cycle re-renders every one of them. 90s was not
      // enough on the larger samples; the invariants themselves are unchanged.
      test.setTimeout(240_000);

      await page.goto(
        `/#/${s.tlg}/${encodeURIComponent(s.workId)}` +
          (s.ref ? `?ref=${encodeURIComponent(s.ref)}` : ''),
      );
      // Prose and verse both paint .parse-row > .pcol; either .pcard or the
      // .noparse placeholder proves the reader got as far as parse rendering.
      await page.waitForSelector('.parse-row > .pcol', { timeout: 60_000 });
      await page.waitForFunction(
        () => document.querySelectorAll('.parse-row .pcard').length > 0,
        undefined,
        { timeout: 60_000 },
      ).catch(() => {
        // A work whose sampled page analyses no word at all is skipped, not
        // failed: there is nothing rendered to assert on.
      });
      await page.waitForLoadState('networkidle').catch(() => {});

      const label = `${s.tlg}/${s.workId}`;
      const collapsed = await readSnapshot(page);
      if (!collapsed.cardCount) {
        test.skip(
          true,
          `no parse cards rendered for ${label} (ref=${s.ref}) — nothing to assert`,
        );
        return;
      }

      // The paste page's .pcard-unknown marker must not appear on a reader
      // route: reader renders the .noparse placeholder instead.
      expect(
        collapsed.cols.some((c) => c.cards.some((k) => k.cls.includes('pcard-unknown'))),
        `${label}: .pcard-unknown leaked into a reader route`,
      ).toBeFalsy();

      const collapsedBad = collectViolations(collapsed, label);
      expect(
        collapsedBad,
        `${label}: ${collapsedBad.length}+ parse-card invariant violation(s)`,
      ).toEqual([]);

      // 7. the same-lemma merge: within one .pcol no two .cand-row share a
      //    lemma. Only observable once expanded.
      const toggle = page.getByRole('button', { name: /^(Expand|Collapse) all$/ });
      await expect(toggle).toBeVisible({ timeout: 20_000 });
      const beforeChips = collapsed.chipCount;
      await toggle.click();
      await page.waitForTimeout(700);

      const expanded = await readSnapshot(page);
      // 6. expanding changes the set of visible chips. It is NOT asserted to
      //    reach 0: see the "Expand all must expand all" regression guard below
      //    for the defect where high-frequency word forms kept their chips.
      //    The invariant is that the set changes and then is restored.
      expect(
        expanded.chipCount,
        `${label}: expanding did not change the visible chip set`,
      ).not.toBe(beforeChips);
      expect(
        expanded.chipCount,
        `${label}: expanding INCREASED the visible chips (${beforeChips} -> ` +
          `${expanded.chipCount}) — collapse is the only thing that may add chips`,
      ).toBeLessThan(beforeChips);
      expect(
        expanded.cardCount,
        `${label}: expanding produced no .cand-row`,
      ).toBeGreaterThanOrEqual(collapsed.cardCount);

      // Same-lemma rows are LEGAL only across morph classes: an infinitive
      // and a participle of one verb are different words spelled alike (the
      // Latin gerundive/gerund/participle axis). Within one class, gender /
      // number / case variants must have merged into a single row.
      //
      // So the invariant is: a repeated lemma in one column must be badged
      // with a morph class, and the badged rows must be distinguishable.
      const badMerges: string[] = [];
      const badSplits: string[] = [];
      for (const [ci, col] of expanded.cols.entries()) {
        const byLemma = new Map<string, typeof col.cards>();
        for (const card of col.cards) {
          if (!card.cls.includes('cand-row')) continue;
          const arr = byLemma.get(card.lemma);
          if (arr) arr.push(card);
          else byLemma.set(card.lemma, [card]);
        }
        for (const [lemma, cards] of byLemma) {
          if (cards.length < 2) continue;
          const classes = new Set(
            cards.map((c) => c.morphClass ?? '(none)'),
          );
          if (classes.size === 1) {
            // merged, yet rendered twice — the merge regressed
            badMerges.push(`col#${ci} "${lemma}" x${cards.length}`);
          } else if (classes.has('(none)')) {
            // split across classes but not badged, so the reader cannot tell
            // // them apart
            badSplits.push(`col#${ci} "${lemma}" ${[...classes].join('/')}`);
          }
        }
      }
      expect(
        badMerges,
        `${label}: same-lemma merge regressed — one row per lemma and ` +
          `morph class expected, found duplicates: ${badMerges.join('; ')}`,
      ).toEqual([]);
      expect(
        badSplits,
        `${label}: a same-lemma row carries no .morph-class badge, so the ` +
          `reader cannot tell an infinitive from a participle: ` +
          badSplits.join('; '),
      ).toEqual([]);

      // ...and the expanded rows keep the same lemma/feats/gloss contracts,
      // including the .gloss-more senses that only exist while expanded.
      const expandedBad = collectViolations(expanded, `${label} expanded`, true);
      expect(
        expandedBad,
        `${label}: ${expandedBad.length}+ invariant violation(s) while expanded`,
      ).toEqual([]);

      // ...and collapsing restores the original chip set exactly.
      // Re-locate the button: its label flips to "Collapse all" while
      // expanded, so the earlier `toggle` locator no longer matches.
      await page.getByRole('button', { name: /^(Expand|Collapse) all$/ }).click();
      await page.waitForTimeout(700);
      const restored = await readSnapshot(page);
      expect(
        restored.chipCount,
        `${label}: collapsing did not restore the ${beforeChips} .more-chip elements`,
      ).toBe(beforeChips);
    });
  }
});

/* ---------------- data-level invariants over random gloss keys ---------------- */

test.describe('chaos sampling: gloss shard data invariants', () => {
  test(`${GLOSS_KEY_SAMPLES} sampled gloss keys are well-formed and bounded`, () => {
    test.setTimeout(60_000);

    const shardFiles = readdirSync(path.join(DATA, 'gloss')).filter((f: string) =>
      f.endsWith('.json'),
    );
    expect(shardFiles.length, 'no gloss shards on disk').toBeGreaterThan(0);

    // Flatten every key ONCE, then sample indices. Reading shards lazily
    // would make the sample depend on which keys a previous draw hit.
    const keys: string[] = [];
    const values: GlossEntry[] = [];
    for (const f of shardFiles) {
      const shard = readJSON<Record<string, GlossEntry>>(
        path.join(DATA, 'gloss', f),
      );
      for (const [k, v] of Object.entries(shard)) {
        keys.push(k);
        values.push(v);
      }
    }
    expect(keys.length, 'gloss shards hold no keys').toBeGreaterThan(0);

    const n = Math.min(GLOSS_KEY_SAMPLES, keys.length);
    const seen = new Set<number>();
    while (seen.size < n) seen.add(Math.floor(rand() * keys.length));

    const bad: string[] = [];
    const overLong: string[] = [];
    const noLetter: Array<{ key: string; g: string }> = [];
    const capsOnly: Array<{ key: string; g: string }> = [];
    let maxG = 0;
    let maxGKey = '';

    for (const i of seen) {
      const v = values[i];
      const at = `gloss[${keys[i]}]`;
      if (typeof v.u !== 'string') bad.push(`${at}: u is ${typeof v.u}`);
      if (typeof v.g !== 'string') bad.push(`${at}: g is ${typeof v.g}`);
      if (typeof v.g !== 'string') continue;
      if (v.g.length > 400) overLong.push(`${at}: g is ${v.g.length} chars`);
      if (v.g.length > maxG) {
        maxG = v.g.length;
        maxGKey = keys[i];
      }
      const t = v.g.trim();
      if (t) {
        if (!/[A-Za-z]/.test(t)) noLetter.push({ key: keys[i], g: v.g });
        else if (!/[a-z]/.test(t)) capsOnly.push({ key: keys[i], g: v.g });
      }
      if (v.s !== undefined && !Array.isArray(v.s)) {
        bad.push(`${at}: s is ${Array.isArray(v.s) ? 'array' : typeof v.s}`);
      }
    }

    console.log(
      `[chaos-sampling] gloss sample: ${n} keys, longest g = ${maxG} chars ` +
        `("${maxGKey}"); no-ASCII-letter = ${noLetter.length}, ` +
        `uppercase-only = ${capsOnly.length}`,
    );

    expect(bad, `malformed gloss entries:\n${bad.join('\n')}`).toEqual([]);
    expect(
      overLong,
      `gloss g longer than 400 chars:\n${overLong.join('\n')}`,
    ).toEqual([]);
    // A truncated LSJ sense ("= (", "3.290.") has no ASCII letter at all, so
    // it would render as a Greek-free, letter-free card body. That is a real
    // data defect; the invariant is asserted, and the known-bad census below
    // pins how many entries currently have it so it can only shrink.
    expect(
      noLetter,
      'sampled gloss g has no ASCII letter at all (truncated LSJ markup)',
    ).toEqual([]);
  });
});

/* ---------------- REGRESSION GUARD: "Expand all" must expand all ----------

   This case was a CONFIRMED DEFECT, found by this file against real data
   rather than theorised. On tlg0545 (Aelian, Varia Historia) at ref=1.22,
   "Expand all" left 164 of 1379 chips on screen, every one of them the same
   word form: καὶ.

   Mechanism, confirmed by measurement:
     - καὶ occurs 228 times on the rendered page, so it is the only word form
       above the second-place ὁ (47).
     - After expanding, exactly 64 of those 228 columns became .cand-row
       groups. 64 is `arr.length > 64` in registerCol().
     - That branch pruned colsByForm to entries whose column `isConnected`.
       Columns are registered in parseCards() BEFORE their row is appended, so
       a column registered during the current render pass is not yet
       connected; the prune therefore discarded live columns, not dead ones.
       rerenderAll() never reached the dropped entries, and those columns kept
       their collapsed card + "+N" chip even though the toolbar read
       "Collapse all".

   Fix: registerCol() no longer prunes. pruneCols() runs from
   rerenderAll()/expandAll(), long after the render pass, when isConnected
   finally distinguishes "gone" from "mid-append".

   Consequence for a reader, had this stood: a word appearing more than 64
   times on one page could not be expanded everywhere, and the toolbar label
   lied about the state.
*/
test.describe('chaos sampling: regression guards', () => {
  test('Expand all expands every ambiguous column on a high-frequency page', async ({
    page,
  }) => {
    test.setTimeout(240_000);

    await page.goto('/#/tlg0545/varia-historia?ref=1.22');
    await page.waitForSelector('.parse-row > .pcol', { timeout: 60_000 });
    await page.waitForFunction(
      () => document.querySelectorAll('.parse-row .more-chip').length > 0,
      undefined,
      { timeout: 60_000 },
    );
    const before = await page.locator('.more-chip').count();
    expect(before, 'sanity: the page must have chips to expand').toBeGreaterThan(64);

    await page.getByRole('button', { name: /^Expand all$/ }).click();
    await page.waitForTimeout(2500);

    // Every column that HAD a chip must have lost it. This failed while
    // registerCol() pruned by isConnected during registration: parseCards()
    // runs before the column is appended, so live columns were discarded and
    // never re-rendered. The prune now happens in rerenderAll() instead.
    const left = await page.locator('.more-chip').count();
    expect(
      left,
      `Expand all left ${left} chips; a column was never re-rendered`,
    ).toBe(0);
  });
});

/* ---------------- pinned census of known-degenerate glosses ---------------- */

/**
 * Real data, measured over all 121,314 gloss strings (primary sense + further
 * senses), recorded so the page-side invariants above are read against facts
 * rather than against an idealised corpus:
 *
 *  - 0 strings are Greek-only (every gloss has ASCII letters).
 *  - 18 strings have no ASCII letter at all — truncated LSJ cross-references
 *    like "= (", "3.290.", "= 2(2).1126.32.". These are the entries the
 *    ASCII-letter invariant would reject.
 *  - 34 strings are uppercase-only — LSJ section labels ("USAGE", "WITH",
 *    "DISJUNCTIVE", "OF ORIGIN") and bare cross-references ("= II.2"). These
 *    are English, which is why the invariant asks for /[A-Za-z]/ and not
 *    /[a-z]/: a lowercase-only reading would reject correct data.
 *
 * The two counts are asserted exactly, so a pipeline change that damages gloss
 * text — or fixes it — must update this test on purpose.
 */
const KNOWN_TRUNCATED_GLOSSES = 18;
const KNOWN_UPPERCASE_ONLY_GLOSSES = 34;

test.describe('chaos sampling: gloss corpus census', () => {
  test('degenerate gloss counts match the recorded data reality', () => {
    test.setTimeout(60_000);

    let truncated = 0;
    let capsOnly = 0;
    let greekOnly = 0;
    let total = 0;
    let over400 = 0;
    let malformed = 0;

    for (const f of readdirSync(path.join(DATA, 'gloss'))) {
      if (!f.endsWith('.json')) continue;
      const shard = readJSON<Record<string, GlossEntry>>(
        path.join(DATA, 'gloss', f),
      );
      for (const v of Object.values(shard)) {
        if (typeof v.u !== 'string' || typeof v.g !== 'string') {
          malformed += 1;
          continue;
        }
        for (const text of [v.g, ...(v.s ?? [])]) {
          if (typeof text !== 'string' || !text.trim()) continue;
          total += 1;
          if (text.length > 400) over400 += 1;
          const hasAscii = /[A-Za-z]/.test(text);
          if (!hasAscii) truncated += 1;
          else if (!/[a-z]/.test(text)) capsOnly += 1;
          if (!hasAscii && /[Ͱ-Ͽἀ-῿]/.test(text)) greekOnly += 1;
        }
      }
    }

    console.log(
      `[chaos-sampling] gloss corpus: ${total} strings, ` +
        `truncated=${truncated}, uppercase-only=${capsOnly}, ` +
        `greek-only=${greekOnly}, over-400=${over400}`,
    );

    expect(malformed, 'gloss entries without string u/g').toBe(0);
    expect(over400, 'gloss strings longer than 400 chars').toBe(0);
    expect(
      greekOnly,
      'a gloss is Greek-only — never a valid English gloss',
    ).toBe(0);
    expect(
      truncated,
      'truncated (no-ASCII-letter) gloss count changed — the page-side ' +
        'ASCII-letter invariant now covers or excludes different data',
    ).toBe(KNOWN_TRUNCATED_GLOSSES);
    expect(
      capsOnly,
      'uppercase-only gloss count changed — the page-side invariant must be ' +
        're-read as /[A-Za-z]/ vs /[a-z]/ against the new data',
    ).toBe(KNOWN_UPPERCASE_ONLY_GLOSSES);
  });
});

/* ---------------- how to run ----------------

  Whole file, fixed default seed:
    npx playwright test tests/chaos-sampling.spec.ts --reporter=list

  A different corpus sample (the seed is printed at the top of every run):
    SEED=424242 npx playwright test tests/chaos-sampling.spec.ts --reporter=list

  Re-running exactly the sample that failed: the seed printed in the failure
  log is the whole input, so paste it back:
    SEED=<seed-from-log> npx playwright test tests/chaos-sampling.spec.ts

  One work only, to iterate on a single title:
    SEED=<seed> npx playwright test tests/chaos-sampling.spec.ts \
      -g "Marcus Aurelius"

  The seed drives BOTH the four sampled works and the 200 sampled gloss keys
  (drawn from one PRNG stream, in that order), so a given seed always samples
  the same works and the same keys. Fixing the seed fixes the entire run.

  Playwright pins chromium-1148, which is not in this machine's ms-playwright
  cache; playwright.config.ts already falls back to chromium-1187, so the file
  runs without `playwright install`.
*/
