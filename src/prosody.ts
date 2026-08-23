// Prosody (scansion) module: fetch per-work scansion, manage toggle,
// and expose helpers for the renderer.
//
// Build output: public/data/prosody/<workId>.json
//   { workId, confidence, meter, lines:[{ref, pattern, raw, text}] }
//
// Runtime: toolbar toggle adds body class "show-prosody" and per-row
// ".scansion" divs are rendered beneath each Greek visual line when the
// work's prosody is available and the toggle is ON.
import { fetchJSON, stripAccents } from "./api";

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
const cache = new Map<string, Map<string, string>>(); // workId -> ref -> pattern
const refIndexFallback = new Map<string, string[]>(); // workId -> pattern by order index
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
  if (v) {
    // if any prosody data already cached, ensure DOM has nodes
    for (const wid of cache.keys()) {
      if (cache.get(wid)?.size) ensureProsodyDOM(wid);
    }
  }
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
        if (l.pattern) {
          if (!m.has(l.ref)) m.set(l.ref, l.pattern);
        }
        order.push(l.pattern || "");
      }
      cache.set(key, m);
      // also store under plain fallback for non-qualified lookups if qualified succeeded
      if (tlg && url.includes(`${tlg}--`)) cache.set(workId, m);
      refIndexFallback.set(key, order);
      if (!refIndexFallback.has(workId)) refIndexFallback.set(workId, order);
      workConf.set(key, data.confidence);
      workConf.set(workId, data.confidence);
      if (enabled) ensureProsodyDOM(key);
      return m;
    } catch {
      continue;
    }
  }
  cache.set(key, new Map());
  return null;
}

/** Walk existing DOM .line rows and inject missing scansion nodes for workId. */
export function ensureProsodyDOM(workId: string): void {
  const rows = document.querySelectorAll<HTMLElement>(".line");
  if (!rows.length) return;
  rows.forEach((row, idx) => {
    if (row.querySelector(".scansion")) return;
    const refEl = row.querySelector<HTMLElement>(".ref-label");
    const ref = refEl?.textContent?.trim() ?? "";
    const pat = getProsodyPattern(workId, ref, idx);
    if (!pat) return;
    const greek = row.querySelector<HTMLElement>(".greek-line");
    if (!greek) return;
    const words = Array.from(greek.querySelectorAll<HTMLElement>(".w"))
      .map((s) => s.textContent ?? "");
    const scan = buildScansionRow(ref, words, pat);
    // insert directly after greek-line
    if (greek.nextSibling) greek.parentNode?.insertBefore(scan, greek.nextSibling);
    else greek.parentNode?.appendChild(scan);
  });
}

export function getProsodyPattern(workId: string, ref: string, idx: number): string | null {
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

/* ---------------- word-aligned scansion ----------------
 * The shipped pattern is one string per LINE ("— ∪ ∪ | — …"), which renders
 * as a monospace row of the wrong width with foot pipes at arbitrary x
 * positions. To align every — / ∪ under its source syllable we:
 *   1. tokenize the pattern into per-syllable symbols (+ foot boundaries),
 *   2. count each Greek word's syllables (vowel-run heuristic),
 *   3. emit ONE scansion span per WORD containing that word's symbols,
 *      with "|" kept inside the word where a foot boundary falls inside it
 *      and at the word edge when the boundary falls between words.
 * render.ts then measures the live Greek word spans and pins each scansion
 * span to exactly its word's box, so columns align pixel-for-pixel. */

const GREEK_VOWELS = "αεηιουω";
const DIPHTHONGS = new Set([
  "αι", "ει", "οι", "υι", "αυ", "ευ", "ηυ", "ου", "ωυ",
]);

/** Strip accents, iota-subscript, punctuation; keep Greek letters only. */
function greekLetters(word: string): string {
  return stripAccents(word).replace(/[^αβγδεζηθικλμνξοπρστυφχψ]/g, "");
}

/** Syllable count via vowel runs (diphthong-folded). Display-grade only. */
export function countSyllables(word: string): number {
  const s = greekLetters(word);
  if (!s) return 0;
  let n = 0;
  let i = 0;
  while (i < s.length) {
    if (GREEK_VOWELS.includes(s[i])) {
      let j = i;
      while (j < s.length && GREEK_VOWELS.includes(s[j])) j++;
      const run = s.slice(i, j);
      for (let k = 0; k < run.length;) {
        if (k + 1 < run.length && DIPHTHONGS.has(run.slice(k, k + 2))) k += 2;
        else k += 1;
        n += 1;
      }
      i = j;
    } else i++;
  }
  return Math.max(1, n);
}

interface ScanSyl { sym: string; brk: boolean }

/** Tokenize a pattern string into per-syllable symbols + foot boundaries. */
export function parsePattern(pattern: string): ScanSyl[] {
  const toks = pattern.trim().split(/\s+/).filter(Boolean);
  const syls: ScanSyl[] = [];
  const isSym = (t: string): boolean => /[—–∪¯˘]/.test(t);
  for (let i = 0; i < toks.length; i++) {
    if (!isSym(toks[i])) continue; // skips "|" and any stray token
    // boundary after this symbol iff a "|" appears before the next symbol
    let brk = false;
    for (let j = i + 1; j < toks.length; j++) {
      if (toks[j] === "|") { brk = true; break; }
      if (isSym(toks[j])) break;
    }
    syls.push({ sym: toks[i], brk });
  }
  return syls;
}

/**
 * One scansion fragment per word, in word order.
 * Words are mapped to syllable symbols by their vowel-run count; when the
 * linguistic count disagrees with the scanner's total (elision/crasis edge
 * cases), symbols are distributed PROPORTIONALLY so every symbol and every
 * foot boundary is still consumed in order — pipes land within a word-length
 * of their source syllable instead of piling onto the last word.
 */
export function wordScansions(words: string[], pattern: string): string[] {
  const syls = parsePattern(pattern);
  const S = syls.length;
  if (!words.length || !S) return words.map(() => "");
  const counts = words.map(countSyllables);
  const total = counts.reduce((a, b) => a + b, 0) || 1;
  const out: string[] = [];
  let from = 0; // next unconsumed symbol index
  let cum = 0;
  for (let wi = 0; wi < words.length; wi++) {
    cum += counts[wi];
    // target end position of this word's symbols on the pattern timeline
    let end = Math.round((cum / total) * S);
    if (end > S) end = S;
    if (wi === words.length - 1) end = S; // last word mops up rounding
    let frag = "";
    for (; from < end; from++) {
      frag += syls[from].sym;
      // keep foot pipes inside the word where the boundary falls; drop only
      // the very-final boundary (patterns never end with an emitted pipe)
      if (syls[from].brk && from < S - 1) frag += "|";
    }
    out.push(frag);
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

/** Build the per-word scansion row for a unit (spans carry data-wi indexes). */
export function buildScansionRow(ref: string, words: string[], pattern: string): El {
  const frags = wordScansions(words, pattern);
  const scan = el("div", "scansion");
  scan.dataset.pattern = pattern;
  scan.setAttribute("aria-label", `Scansion ${ref || ""}: ${pattern}`.trim());
  scan.title = pattern;
  frags.forEach((f, i) => {
    const sp = el("span", "scan-u", f);
    sp.dataset.wi = String(i);
    scan.appendChild(sp);
  });
  return scan;
}

/** Create the toolbar toggle button for a verse work. Call after renderControls.
 *  Returns the button element (append to controls.root). */
export function createProsodyToggle(workId: string, tlg?: string): HTMLButtonElement {
  const key = tlg ? `${tlg}--${workId}` : workId;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.textContent = enabled ? "Scansion ●" : "Scansion ○";
  btn.title = "Toggle metrical scansion (— ∪ ∪ | …) under each line";
  btn.setAttribute("aria-pressed", String(enabled));
  btn.addEventListener("click", () => {
    toggleProsody();
    btn.textContent = enabled ? "Scansion ●" : "Scansion ○";
    btn.setAttribute("aria-pressed", String(enabled));
    // when turning ON and data not yet loaded, trigger load
    if (enabled && !cache.has(key) && !cache.has(workId)) {
      void loadProsody(workId, tlg).then(() => {
        ensureProsodyDOM(key);
        for (const fn of listeners) fn();
      });
    } else if (enabled) {
      ensureProsodyDOM(key);
    }
  });
  // keep label in sync with external toggles
  onProsodyToggle(() => {
    btn.textContent = enabled ? "Scansion ●" : "Scansion ○";
    btn.setAttribute("aria-pressed", String(enabled));
  });
  return btn;
}
