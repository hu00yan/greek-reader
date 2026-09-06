// Prosody (scansion) module: fetch per-work scansion, manage toggle,
// and expose helpers for the renderer.
//
// Build output: public/data/prosody/<workId>.json
//   { workId, confidence, meter, lines:[{ref, pattern, raw, text}] }
//
// Runtime: toolbar toggle adds body class "show-prosody" and per-row
// ".scansion" divs are rendered beneath each Greek visual line when the
// work's prosody is available and the toggle is ON.
import { fetchJSON } from "./api";

export interface ProsodyLine {
  ref: string;
  pattern: string;
  raw: string;
  text: string;
}

interface ProsodyFile {
  workId: string;
  confidence: number;
  meter: string;
  lines: ProsodyLine[];
}

const STORAGE_KEY = "greek-reader.prosody.enabled";
const cache = new Map<string, Map<string, string>>(); // workId -> ref -> RAW scansion
const refIndexFallback = new Map<string, string[]>(); // workId -> raw by order index
const workConf = new Map<string, number>();

let enabled = false;
try {
  enabled = localStorage.getItem(STORAGE_KEY) === "1";
} catch { /* ignore */ }

const listeners = new Set<() => void>();

export function isProsodyEnabled(): boolean {
  return enabled;
}

export function setProsodyEnabled(v: boolean): void {
  enabled = v;
  try { localStorage.setItem(STORAGE_KEY, v ? "1" : "0"); } catch {}
  document.body.classList.toggle("show-prosody", v);
  for (const fn of listeners) fn();
}

export function toggleProsody(): void {
  setProsodyEnabled(!enabled);
}

export function onProsodyToggle(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// initialise body class on load
try {
  if (enabled) document.body.classList.add("show-prosody");
} catch {}

export async function loadProsody(workId: string, tlg?: string): Promise<Map<string, string> | null> {
  const key = tlg ? `${tlg}--${workId}` : workId;
  if (cache.has(key)) return cache.get(key)!;
  // try qualified first, then plain
  const candidates: string[] = [];
  if (tlg) candidates.push(`data/prosody/${tlg}--${workId}.json`);
  candidates.push(`data/prosody/${workId}.json`);
  for (const url of candidates) {
    try {
      const data = await fetchJSON<ProsodyFile>(url);
      const m = new Map<string, string>();
      const order: string[] = [];
      for (const l of data.lines) {
        if (l.raw) {
          if (!m.has(l.ref)) m.set(l.ref, l.raw);
        }
        order.push(l.raw || "");
      }
      cache.set(key, m);
      // also store under plain fallback for non-qualified lookups if qualified succeeded
      if (tlg && url.includes(`${tlg}--`)) cache.set(workId, m);
      refIndexFallback.set(key, order);
      if (!refIndexFallback.has(workId)) refIndexFallback.set(workId, order);
      workConf.set(key, data.confidence);
      workConf.set(workId, data.confidence);
      if (enabled) for (const fn of listeners) fn();
      return m;
    } catch {
      continue;
    }
  }
  cache.set(key, new Map());
  return null;
}

/** Raw CLTK symbol string for a unit (one char per syllable: ¯ ˘ x),
 *  or null. Ref match first, positional fallback second. */
export function getProsodyRaw(workId: string, ref: string, idx: number): string | null {
  // workId may be qualified "tlg--id" or plain; try exact then fallback to plain
  const keys = [workId, workId.split("--").pop()!];
  for (const k of keys) {
    const m = cache.get(k);
    if (!m) continue;
    if (m.has(ref)) return m.get(ref)!;
  }
  for (const k of keys) {
    const arr = refIndexFallback.get(k);
    if (arr && idx < arr.length && arr[idx]) return arr[idx]!;
  }
  return null;
}

export function getProsodyConfidence(workId: string): number | null {
  return workConf.get(workId) ?? null;
}

/* ---------------- syllable-aligned scansion ----------------
 * Honesty contract (measured on the Iliad, 15,683 lines):
 *   - CLTK ships one symbol per line (raw "¯˘x…"), with NO word/syllable map.
 *   - Foot-boundary pipes appear only where the symbols parse cleanly into
 *     6 feet (footBreaks: dactylic hexameter or iambic trimeter); everywhere
 *     else the row shows bare symbols. The old greedy segmenter put 7–8
 *     "feet" and impossible trochees on most lines — never again.
 *   - Symbols are mapped to words by vowel-nucleus counts. When the counts
 *     add up EXACTLY to the raw length (~85% of Iliad lines), every symbol
 *     is pinned to its own syllable's measured box: a precise ruler.
 *   - Otherwise the row still renders word-grouped in symbol order (no worse
 *     than before) but carries data-approx + a visible ≈ flag.
 *   - Foot pipes need BOTH: exact word validation AND a clean 6-foot parse
 *     (dactylic hexameter or iambic trimeter). A clean count can still hide
 *     a misplaced symbol (Il. 1.6 ἐξ scanned short) — the failed foot parse
 *     catches it, so ≈ means "don't fully trust this line", never "exact".
 * Diaeresis (ϊ ϋ) always breaks diphthongs; elided forms (δ') count zero —
 * both verified against CLTK totals (39% → 85% exact agreement). */

const GREEK_VOWELS = "αεηιουω";
const DIPHTHONGS = new Set([
  "αι", "ει", "οι", "υι", "αυ", "ευ", "ηυ", "ου", "ωυ",
]);
const DIAERESIS = "̈";
/** Marks glued to the previous piece (elision apostrophes, hyphens). */
const GLUE_LEFT = new Set(["'", "’", "ʼ", "-", "‐", "‑"]);

interface VChar { ch: string; dia: boolean }

/** NFD char stream: accents dropped, diaeresis remembered (it forces hiatus). */
function vchars(word: string): VChar[] {
  const out: VChar[] = [];
  for (const c of word.normalize("NFD").toLowerCase()) {
    if (c === DIAERESIS) {
      if (out.length) out[out.length - 1].dia = true;
      continue;
    }
    const cp = c.codePointAt(0) ?? 0;
    if (cp >= 0x300 && cp <= 0x36f) continue; // other combining marks: drop
    out.push({ ch: c, dia: false });
  }
  return out;
}

/** Vowel nuclei as [start, end) spans over vchars (diphthong-folded). */
export function nuclei(word: string): Array<[number, number]> {
  const vc = vchars(word);
  const out: Array<[number, number]> = [];
  let i = 0;
  while (i < vc.length) {
    if (!GREEK_VOWELS.includes(vc[i].ch)) { i++; continue; }
    let j = i;
    while (j < vc.length && GREEK_VOWELS.includes(vc[j].ch)) j++;
    let k = i;
    while (k < j) {
      if (k + 1 < j &&
        DIPHTHONGS.has(vc[k].ch + vc[k + 1].ch) &&
        !vc[k].dia && !vc[k + 1].dia) {
        out.push([k, k + 2]); k += 2;
      } else {
        out.push([k, k + 1]); k += 1;
      }
    }
    i = j;
  }
  return out;
}

/** Syllable count via vowel nuclei. Vowelless tokens (elided δ') count 0:
 *  metrically they vanish, and CLTK agrees often enough that the exact-sum
 *  gate below stays honest. Display-grade only. */
export function countSyllables(word: string): number {
  return nuclei(word).length;
}

/**
 * Split a word into display syllables (original orthography preserved).
 * Maximal onset: a lone intervocalic consonant opens the next syllable,
 * clusters split after the first consonant. Punctuation glues left.
 * Returns [] for vowelless tokens (no scansion mark — correctly so).
 */
export function syllabify(word: string): string[] {
  const vc = vchars(word);
  const nuc = nuclei(word);
  if (!nuc.length) return [];
  // Render from the ORIGINAL NFD slice (not the stripped vchars) so accents,
  // diaereses and breathings stay exactly where they were.
  const nfd = Array.from(word.normalize("NFD"));
  const bases: number[] = []; // nfd index of each vchar base, in order
  for (let i = 0; i < nfd.length; i++) {
    const c = nfd[i];
    if (c === DIAERESIS) continue;
    const cp = c.codePointAt(0) ?? 0;
    if (cp >= 0x300 && cp <= 0x36f) continue;
    bases.push(i);
  }
  if (bases.length !== vc.length) return [word]; // paranoia: never corrupt text
  // piece boundaries in vchar space, then expand to nfd ranges (keep the
  // combining marks glued to their base so nothing is lost or moved)
  const cuts = new Set<number>(); // vchar indices where a new piece starts
  for (let n = 1; n < nuc.length; n++) {
    const prevEnd = nuc[n - 1][1];
    const nextStart = nuc[n][0];
    const gap = nextStart - prevEnd;
    let b = gap <= 1 ? prevEnd : prevEnd + 1;
    // glue-left marks never open a piece: lone consonants open before them,
    // clusters absorb them into the previous piece
    while (b < nextStart && GLUE_LEFT.has(vc[b]?.ch ?? "")) b++;
    cuts.add(Math.min(Math.max(b, prevEnd), nextStart));
  }
  // vchar pieces -> nfd slices (extend each piece end to swallow following
  // combining marks so accents/diaereses stay on their base)
  const nEnd = (v: number): number => {
    // nfd index just past vchar v (base + its combining marks)
    if (v >= bases.length) return nfd.length;
    let e = bases[v] + 1;
    while (e < nfd.length) {
      const c = nfd[e];
      if (c === DIAERESIS) { e++; continue; }
      const cp = c.codePointAt(0) ?? 0;
      if (cp >= 0x300 && cp <= 0x36f) { e++; continue; }
      break;
    }
    return e;
  };
  const starts = [0, ...Array.from(cuts).sort((a, b) => a - b)];
  const out: string[] = [];
  for (let p = 0; p < starts.length; p++) {
    const s = starts[p];
    const e = p + 1 < starts.length ? starts[p + 1] : bases.length;
    if (s >= e) continue;
    out.push(nfd.slice(bases[s], nEnd(e - 1)).join(""));
  }
  // NFC-normalize so split pieces render exactly like the unsplit word
  // (precomposed characters keep their shaping/kerning context stable)
  return out.map((s) => s.normalize("NFC"));
}

/** CLTK raw ("¯˘x…", one char per syllable) -> display symbols.
 * Longum stays ¯ (macron, narrow like the breve ∪): the em dash previously
 * used here is ~21px wide and bled ±4px out of narrow syllable boxes,
 * visibly merging with neighbouring symbols and foot pipes. */
export function rawToSymbols(raw: string): string[] {
  const out: string[] = [];
  for (const c of raw) {
    if (c === "¯") out.push("¯");
    else if (c === "˘") out.push("∪");
    else if (c === "x") out.push("×"); // anceps: either — never force long
  }
  return out;
}

export interface AlignedScansion {
  /** display pieces per word (all unit.words, speakers included) */
  syls: string[][];
  /** display symbols per word, same shape as syls */
  syms: string[][];
}

/**
 * Map raw symbols onto words. Returns null unless word piece counts add up
 * EXACTLY to the symbol count — callers must render the approximate
 * (flagged) row instead of distributing proportionally and silently
 * sliding symbols onto neighbouring syllables.
 */
export function alignScansion(words: string[], raw: string): AlignedScansion | null {
  const syms = rawToSymbols(raw);
  if (!syms.length || !words.length) return null;
  const syls = words.map(syllabify);
  const total = syls.reduce((a, b) => a + b.length, 0);
  if (total !== syms.length) return null;
  const per: string[][] = [];
  let from = 0;
  for (const pieces of syls) {
    per.push(syms.slice(from, from + pieces.length));
    from += pieces.length;
  }
  return { syls, syms: per };
}

/**
 * Word-grouped symbol runs for the approximate path (order-correct, positions
 * flagged approximate via data-approx on the row). Proportional distribution
 * is kept ONLY here, explicitly labelled — never for the precise path.
 */
export function wordScansions(words: string[], syms: string[]): string[][] {
  const S = syms.length;
  if (!words.length || !S) return words.map(() => []);
  const counts = words.map(countSyllables);
  const total = counts.reduce((a, b) => a + b, 0) || 1;
  const out: string[][] = [];
  let from = 0;
  let cum = 0;
  for (let wi = 0; wi < words.length; wi++) {
    cum += counts[wi];
    let end = Math.round((cum / total) * S);
    if (end > S) end = S;
    if (wi === words.length - 1) end = S; // last word mops up rounding
    out.push(syms.slice(from, end));
    from = end;
  }
  return out;
}

type El = HTMLElement;
const el = (tag: string, cls?: string, text?: string): El => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

/**
 * Foot boundaries for display symbols, or null when the line does not parse
 * cleanly. Tries dactylic hexameter first (feet ¯∪∪ / ¯¯), then iambic
 * trimeter (∪¯ / ¯¯); both require exactly 6 feet and full consumption.
 * Anceps × is a wildcard only in final position. Anything else (resolutions,
 * lyric meters, scanner noise like mid-line ˘¯) yields null: the row renders
 * symbols without foot divisions rather than confidently-wrong pipes.
 * (The old greedy segmenter put 7–8 "feet" and impossible trochees on most
 * lines — never again.)
 */
export function footBreaks(syms: string[]): boolean[] | null {
  if (syms.length < 2) return null;
  if (syms.some((s) => s !== "¯" && s !== "∪" && s !== "×")) return null;
  if (syms.slice(0, -1).includes("×")) return null;
  const match = (pos: number, pat: string[]): boolean => {
    if (pos + pat.length > syms.length) return false;
    for (let j = 0; j < pat.length; j++) {
      const s = syms[pos + j];
      if (s === "×") {
        if (pos + j !== syms.length - 1) return false;
        continue; // final anceps matches either quantity
      }
      if (s !== pat[j]) return false;
    }
    return true;
  };
  const parse = (feet: string[][]): number[][] | null => {
    const out: number[][] = [];
    let i = 0;
    while (i < syms.length) {
      let hit: string[] | null = null;
      for (const f of feet) {
        if (match(i, f)) { hit = f; break; }
      }
      if (!hit) return null;
      out.push([i, i + hit.length]);
      i += hit.length;
    }
    return out;
  };
  const dactylic: string[][] = [["¯", "∪", "∪"], ["¯", "¯"]];
  const iambic: string[][] = [["∪", "¯"], ["¯", "¯"]];
  for (const feet of [dactylic, iambic]) {
    const groups = parse(feet);
    // exactly 6 feet, final foot disyllabic (no 18-syllable "hexameter")
    if (groups && groups.length === 6 && groups[5][1] - groups[5][0] === 2) {
      const brk = new Array<boolean>(syms.length - 1).fill(false);
      for (let g = 0; g < 5; g++) brk[groups[g][1] - 1] = true;
      return brk;
    }
  }
  return null;
}

/**
 * Build the scansion row for a unit from CLTK raw, splitting the rendered
 * Greek words into syllable spans when the precise path validates.
 * Foot pipes appear only on validated lines whose symbols parse cleanly
 * into 6 feet (footBreaks); anything else renders symbols without pipes.
 */
export function buildScansionRow(ref: string, words: string[], raw: string): El {
  const al = alignScansion(words, raw);
  const syms = rawToSymbols(raw);
  const label = syms.join(" ");
  const scan = el("div", "scansion");
  scan.dataset.raw = raw;
  // ≈ flag unless attribution is exact AND feet verify: positions and
  // values are both trustworthy only then (a clean count can still hide a
  // misplaced symbol, e.g. Il. 1.6 ἐξ scanned short — attribution right,
  // value wrong — caught here by the failed foot parse, not by the count)
  const brk = al ? footBreaks(al.syms.flat()) : null;
  const trusted = !!al && !!brk;
  if (!trusted) scan.dataset.approx = "1";
  const ariaNote = trusted ? "" : " (uncertain)";
  scan.setAttribute("aria-label", `Scansion ${ref || ""}${ariaNote}: ${label}`.trim());
  scan.title = trusted ? label : `${label} (≈ automatic scansion uncertain)`;
  if (al) {
    // flat symbol list in line order, then pipes at validated boundaries
    const flat: Array<{ sym: string; wi: number }> = [];
    al.syls.forEach((pieces, wi) => {
      al.syms[wi].forEach((sym, si) => {
        if (si >= pieces.length) return; // cannot happen when validated
        flat.push({ sym, wi });
      });
    });
    let sy = 0;
    flat.forEach((f, i) => {
      const sp = el("span", "scan-u", f.sym);
      sp.dataset.sy = String(sy++);
      sp.dataset.w = String(f.wi);
      scan.appendChild(sp);
      // zero-footprint hairline exactly at the foot boundary (border, not a
      // glyph: the "|" character is ~9px wide and would reintroduce the very
      // collision this removes). Net layout impact is nil so ruler tiling
      // stays pixel-exact.
      if (brk?.[i] && i < flat.length - 1) {
        const pipe = el("span", "scan-pipe", "");
        pipe.dataset.w = String(f.wi);
        pipe.setAttribute("aria-hidden", "true");
        scan.appendChild(pipe);
      }
    });
  } else {
    scan.dataset.approx = "1";
    // one span per word (empty runs kept) so index pairing with .w spans
    // and reflow distribution stay 1:1, exactly like the legacy rows
    wordScansions(words, syms).forEach((run, wi) => {
      const sp = el("span", "scan-u", run.join(""));
      sp.dataset.wi = String(wi);
      scan.appendChild(sp);
    });
  }
  return scan;
}

/**
 * Split rendered .w word spans into .syl syllable spans (data-sy indexed
 * line-globally, in DOM order). Words without nuclei keep their plain text.
 * Idempotent per span (already-split spans are skipped).
 */
export function splitWordSpans(
  wordSpans: HTMLElement[],
  syls: string[][],
): void {
  wordSpans.forEach((w, wi) => {
    const pieces = syls[wi];
    if (!pieces?.length || w.querySelector(".syl")) return;
    const full = w.textContent ?? "";
    // sanity: pieces must exactly reconstitute the word (NFC) — else leave it
    if (pieces.join("") !== full.normalize("NFC")) return;
    w.replaceChildren();
    pieces.forEach((text) => {
      const s = el("span", "syl", text);
      w.appendChild(s);
    });
  });
  // assign line-global data-sy in DOM order (skips unsplit words: they carry
  // no symbols, and explicit data-sy pairing keeps everything else aligned)
  let sy = 0;
  for (const w of wordSpans) {
    const kids = Array.from(w.children).filter((c) =>
      (c as HTMLElement).classList.contains("syl")) as HTMLElement[];
    if (!kids.length) continue;
    for (const k of kids) k.dataset.sy = String(sy++);
  }
}

/**
 * Full per-unit scansion assembly: split the Greek (precise path only) and
 * build the row. Returns null when there is nothing to show. Splitting is
 * pre-verified on strings before touching the DOM, so the Greek is never
 * left partially split.
 */
export function scansionForUnit(
  greekEl: HTMLElement,
  words: string[],
  raw: string,
  ref: string,
): El | null {
  const syms = rawToSymbols(raw);
  if (!syms.length || !words.length) return null;
  const wSpans = Array.from(
    greekEl.querySelectorAll<HTMLElement>(":scope > .w"));
  if (wSpans.length !== words.length) return null;
  const al = alignScansion(words, raw);
  if (al) {
    const splittable = al.syls.every((pieces, wi) =>
      !pieces.length ||
      pieces.join("") === (words[wi] ?? "").normalize("NFC"));
    if (splittable) splitWordSpans(wSpans, al.syls);
    else return buildScansionRow(ref, words, raw); // ≈ path, Greek untouched
  }
  return buildScansionRow(ref, words, raw);
}

/** Create the toolbar toggle button for a verse work. Call after renderControls.
 *  Returns the button element (append to controls.root). */
export function createProsodyToggle(workId: string, tlg?: string): HTMLButtonElement {
  const key = tlg ? `${tlg}--${workId}` : workId;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.textContent = enabled ? "Scansion ●" : "Scansion ○";
  btn.title = "Toggle metrical scansion (¯ ∪ ∪ …) under each line";
  btn.setAttribute("aria-pressed", String(enabled));
  btn.addEventListener("click", () => {
    toggleProsody();
    btn.textContent = enabled ? "Scansion ●" : "Scansion ○";
    btn.setAttribute("aria-pressed", String(enabled));
    // when turning ON and data not yet loaded, trigger load; the renderer's
    // prosody-toggle subscription injects rows once data arrives (the cached
    // path was already handled by setProsodyEnabled's listener broadcast)
    if (enabled && !cache.has(key) && !cache.has(workId)) {
      void loadProsody(workId, tlg).then(() => {
        for (const fn of listeners) fn();
      });
    }
  });
  // keep label in sync with external toggles
  onProsodyToggle(() => {
    btn.textContent = enabled ? "Scansion ●" : "Scansion ○";
    btn.setAttribute("aria-pressed", String(enabled));
  });
  return btn;
}
