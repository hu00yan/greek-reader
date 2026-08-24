// Shared interlinear rendering: Greek units (verse lines or prose chunks)
// with per-word parse cards, controls bar, and the click-for-details panel.
import { loadCatalog, loadGloss, loadMorph, stripAccents, type Gloss, type Parse, type Unit } from "./api";
import { applyClasses, attachChip, isKnown, markKnown, toolbarControls, unmarkKnown } from "./vocab";
import { copyLinkButtonFor, openStarPanel, starButtonFor } from "./bookmarks";
import { fetchHomerEntries, HOMER_DICTS, isHomerActive, openLexicon,
  lexiconButton } from "./lexicon";
import { themeControl } from "./theme";
import { speakGreek, stopTTS, pauseTTS, resumeTTS, speakQueue, onTTSStatus, getTTSStatus, isUnitActive, stopUnit } from "./tts";
import {
  getProsodyPattern, isProsodyEnabled, buildScansionRow, onProsodyToggle,
} from "./prosody";

type El = HTMLElement;
const el = (tag: string, cls?: string, text?: string): El => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text; // never innerHTML
  return e;
};

export interface RenderCtx {
  morph: Map<string, Parse[]>;
  gloss: Map<string, Gloss>;
  /** Accent-stripped forms known to be unanalysable (paste live pass). */
  unknown?: Set<string>;
  /** lemma -> occurrence count among this work's loaded tokens
   *  (ranking signal for parse disambiguation). */
  lemmaFreq?: Map<string, number>;
  /** Author register hint: "prose" enables the dialect penalty in the
   *  parse ranking; anything else is neutral. */
  genre?: string;
  /** Author TLG id when known (reader routes). Gates speaker coloring to
   *  dialogue works — undefined (e.g. paste view) means never color. */
  tlg?: string;
}

/* ---------------- parse ranking ---------------- */

/** Dialect tags that mark a parse as off-register for classical prose. */
const PROSE_FOREIGN_DIALECTS = new Set([
  "epic", "homeric", "doric", "aeolic", "ionic",
]);

/** Authors whose works are classical/Koine PROSE (TLG id -> register).
 *  Poets and dramatists stay neutral; Herodotus writes Ionic prose, so
 *  he is deliberately not listed. Extend as new authors ship. */
const GENRE_BY_TLG: Record<string, string> = {
  tlg0003: "prose", // Thucydides
  tlg0007: "prose", // Plutarch
  tlg0010: "prose", // Isocrates
  tlg0014: "prose", // Demosthenes
  tlg0018: "prose", // Philo Judaeus
  tlg0026: "prose", // Aeschines
  tlg0027: "prose", // Andocides
  tlg0028: "prose", // Antiphon
  tlg0029: "prose", // Dinarchus
  tlg0030: "prose", // Hyperides
  tlg0031: "prose", // New Testament
  tlg0032: "prose", // Xenophon
  tlg0034: "prose", // Lycurgus
  tlg0059: "prose", // Plato
  tlg0060: "prose", // Diodorus Siculus
  tlg0062: "prose", // Lucian
  tlg0074: "prose", // Arrian
  tlg0081: "prose", // Dionysius of Halicarnassus
  tlg0086: "prose", // Aristotle
  tlg0093: "prose", // Theophrastus
  tlg0099: "prose", // Strabo
  tlg0284: "prose", // Aelius Aristides
  tlg0525: "prose", // Pausanias
  tlg0527: "prose", // Septuaginta
  tlg0532: "prose", // Achilles Tatius
  tlg0537: "prose", // Epicurus
  tlg0540: "prose", // Lysias
  tlg0543: "prose", // Polybius
  tlg0545: "prose", // Aelian
  tlg0548: "prose", // Apollodorus
  tlg0557: "prose", // Epictetus
  tlg0560: "prose", // Longinus
  tlg0561: "prose", // Longus
  tlg0562: "prose", // Marcus Aurelius
  tlg0612: "prose", // Dio Chrysostom
  tlg0627: "prose", // Hippocrates
};

/** Register for a catalog author; "" when neutral. */
export function genreFor(tlg: string): string {
  return GENRE_BY_TLG[tlg] ?? "";
}

/** Dialect tokens of a parse (x = dialects space-separated | stemtypes).
 *  Some shipped shard entries omit fields; stay defensive. */
function dialectTags(p: Parse): string[] {
  return ((p.x ?? "").split("|")[0] ?? "").split(/\s+/).filter(Boolean);
}

/** Pure ranking score for one candidate parse.
 *  Corpus frequency dominates (weight 10/log2); dialect flags cost 5. */
export function scoreParse(
  p: Parse,
  lemmaFreq?: Map<string, number>,
  genre?: string,
): number {
  let s = 0;
  const f = lemmaFreq?.get(stripAccents(p.l ?? "")) ?? 0;
  s += Math.log2(1 + f) * 10;
  if (
    genre === "prose" &&
    dialectTags(p).some((d) => PROSE_FOREIGN_DIALECTS.has(d))
  ) {
    s -= 5;
  }
  return s;
}

/** Indices into `parses`, best-ranked first. Stable tiebreak: original order. */
export function rankParses(
  parses: Parse[],
  lemmaFreq?: Map<string, number>,
  genre?: string,
): number[] {
  return parses
    .map((p, i) => ({ i, s: scoreParse(p, lemmaFreq, genre) }))
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((x) => x.i);
}

/** Add every candidate lemma of every parsed token to ctx.lemmaFreq.
 *  Call once per freshly loaded batch to grow the work-view signal. */
export function tallyLemmas(ctx: RenderCtx, units: Unit[]): void {
  if (!ctx.lemmaFreq) ctx.lemmaFreq = new Map();
  const freq = ctx.lemmaFreq;
  for (const u of units) {
    for (const w of u.words) {
      for (const p of ctx.morph.get(stripAccents(w)) ?? []) {
        const l = stripAccents(p.l);
        if (l) freq.set(l, (freq.get(l) ?? 0) + 1);
      }
    }
  }
}

/**
 * Feature tokens of candidate idx that vary within its same-lemma group,
 * e.g. ["acc"] vs ["dat"] — the disagreement made scannable.
 */
export function diffTokens(fs: string[], idx: number): string[] {
  if (fs.length < 2) return [];
  const sets = fs.map((f) => new Set((f ?? "").split(/\s+/).filter(Boolean)));
  return Array.from(sets[idx]).filter((t) =>
    !sets.every((s) => s.has(t)),
  );
}

/* expansion state persists per word-form while one work view is on screen.
 * All columns of the same form expand/collapse together: a live registry
 * keeps every rendered column in sync with the set (common words like
 * "ὅτι" appear many times per view). */
let expandedView: El | null = null;
const expandedForms = new Set<string>();
const colsByForm = new Map<string, Array<{ col: El; word: string }>>();
let currentCtx: RenderCtx | null = null;

function resetExpansion(container: El): void {
  if (expandedView !== container) {
    expandedView = container;
    expandedForms.clear();
    colsByForm.clear();
  }
}

/** Re-render every live parse column against the expansion set. */
function rerenderAll(): void {
  if (!currentCtx) return;
  for (const arr of colsByForm.values()) {
    for (const entry of arr) {
      if (entry.col.isConnected) fillParseCol(entry.col, entry.word, currentCtx);
    }
  }
}

/** Expand every multi-candidate word in the current view. */
export function expandAll(): void {
  if (!currentCtx || !expandedView?.isConnected) return;
  for (const [key, arr] of colsByForm) {
    const entry = arr.find((e) => e.col.isConnected);
    if (!entry) continue;
    if ((currentCtx.morph.get(key)?.length ?? 0) > 1) expandedForms.add(key);
  }
  rerenderAll();
}

/** Collapse everything back to best-parse cards. */
export function collapseAll(): void {
  if (!expandedForms.size) return;
  expandedForms.clear();
  rerenderAll();
}

/** Keyboard shortcut: E toggles all candidates in the current view. */
function onGlobalKey(e: KeyboardEvent): void {
  if (e.key !== "e" && e.key !== "E") return;
  const t = e.target as HTMLElement | null;
  if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" ||
    t.isContentEditable)) return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (!currentCtx || !expandedView?.isConnected) return;
  e.preventDefault();
  if (expandedForms.size) collapseAll();
  else expandAll();
}
document.addEventListener("keydown", onGlobalKey);

function registerCol(key: string, col: El, word: string, ctx: RenderCtx): void {
  let arr = colsByForm.get(key);
  if (!arr) colsByForm.set(key, (arr = []));
  const entry = { col, word };
  arr.push(entry);
  // drop dead entries lazily when their column left the document
  if (arr.length > 64) {
    colsByForm.set(
      key,
      arr.filter((e) => e.col.isConnected),
    );
  }
}

/** Flip expansion for one word-form and re-render every live column. */
function toggleExpanded(word: string, ctx: RenderCtx): void {
  const key = stripAccents(word);
  if (!expandedForms.delete(key)) expandedForms.add(key);
  for (const entry of colsByForm.get(key) ?? []) {
    if (!entry.col.isConnected) continue;
    fillParseCol(entry.col, entry.word, ctx);
  }
}

/** Merge freshly loaded shards into an accumulating context. */
export function mergeCtx(
  ctx: RenderCtx,
  morph: Map<string, Parse[]>,
  gloss: Map<string, Gloss>,
): RenderCtx {
  for (const [k, v] of morph) if (!ctx.morph.has(k)) ctx.morph.set(k, v);
  for (const [k, v] of gloss) if (!ctx.gloss.has(k)) ctx.gloss.set(k, v);
  return ctx;
}

/** Load every analysis + gloss needed for these units (shards cached). */
export async function prepare(units: Unit[]): Promise<RenderCtx> {
  const forms = units.flatMap((u) => u.words);
  const morph = await loadMorph(forms);
  const lemmas: string[] = [];
  for (const w of new Set(forms)) {
    for (const p of morph.get(stripAccents(w)) ?? []) lemmas.push(p.l);
  }
  const gloss = await loadGloss(lemmas);
  return { morph, gloss };
}

function parseCards(word: string, ctx: RenderCtx): El {
  const col = el("div", "pcol");
  registerCol(stripAccents(word), col, word, ctx);
  fillParseCol(col, word, ctx);
  return col;
}

/** (Re)render one word's parse column per current expansion state. */
function fillParseCol(col: El, word: string, ctx: RenderCtx): void {
  col.replaceChildren();
  const key = stripAccents(word);
  const parses = ctx.morph.get(key);
  if (!parses || parses.length === 0) {
    if (ctx.unknown?.has(key)) {
      // confirmed unknown after both index and live lookup
      col.appendChild(el("div", "pcard pcard-unknown", "—"));
    } else {
      col.appendChild(el("span", "noparse", "—"));
    }
    return;
  }

  const order = rankParses(parses, ctx.lemmaFreq, ctx.genre);
  if (order.length > 1 && !expandedForms.has(key)) {
    // collapsed: best-ranked card + muted "+N" chip
    parseCard(parses[order[0]], ctx, col);
    const chip = el("button", "more-chip", `+${order.length - 1}`) as HTMLButtonElement;
    chip.type = "button";
    chip.title = `${order.length} analyses — click to compare`;
    chip.setAttribute("aria-label",
      `${order.length} analyses for ${word}; click to show all`);
    chip.addEventListener("click", () => toggleExpanded(word, ctx));
    col.appendChild(chip);
    return;
  }

  // expanded (or unambiguous): every candidate, clearly separated
  const groups = new Map<string, Parse[]>();
  for (const i of order) {
    const k = stripAccents(parses[i].l);
    let arr = groups.get(k);
    if (!arr) groups.set(k, (arr = []));
    arr.push(parses[i]);
  }
  for (const i of order) {
    candidateRow(parses[i], i, groups.get(stripAccents(parses[i].l))!, ctx)
      .forEach((node) => col.appendChild(node));
  }
}

/**
 * One expanded candidate: compact summary row — lemma, features,
 * diff badges against same-lemma siblings, gloss.
 */
function candidateRow(
  p: Parse,
  idx: number,
  group: Parse[],
  ctx: RenderCtx,
): El[] {
  const row = el("div", "pcard cand-row");
  const head = el("div", "cand-head");
  head.appendChild(el("span", "lemma", p.l || "?"));
  for (const tok of diffTokens(group.map((g) => g.f),
    group.indexOf(p))) {
    head.appendChild(el("span", "diff-badge", tok));
  }
  row.appendChild(head);
  const feats = [p.p, p.f, p.x].filter(Boolean).join(" · ");
  if (feats) row.appendChild(el("div", "feats", feats));
  const g = ctx.gloss.get(stripAccents(p.l));
  if (g) row.appendChild(el("div", "gloss", g.g));
  return [row];
}

function parseCard(p: Parse, ctx: RenderCtx, col: El): void {
  const card = el("div", "pcard");
  const head = el("div", "cand-head");
  head.appendChild(el("span", "lemma", p.l || "?"));
  card.appendChild(head);
  const feats = [p.p, p.f, p.x].filter(Boolean).join(" · ");
  card.appendChild(el("div", "feats", feats));
  const g = ctx.gloss.get(stripAccents(p.l));
  card.appendChild(el("div", "gloss", g ? g.g : ""));
  col.appendChild(card);
}

/** Render interlinear units into container.
 *  kind "verse": one row per unit — ref label, Greek line, cards beneath.
 *  kind "prose": ref badge + flowing paragraph of words, cards beneath.
 *  baseIndex: cumulative unit offset (prose refs show every 5th chunk).
 *  Refs render VERBATIM — Stephanus/Bekker/book.line strings as shipped.
 *  Header fix: every unit gets a deterministic .unit-head with ref + grouped
 *  actions (TTS 🔊 + AI). Buttons are inline flex gap at header end (right-aligned),
 *  never between greek lines and parse rows. No MutationObserver mid-unit. */
/* Per-unit TTS: ONE 🔊 button, state machine per unit —
 * click 1: synthesize+play, row highlights, button flips to small ⏹;
 * click 2 on the ACTIVE unit: STOP immediately (espeak cancel via
 * stopUnit → stopTTS generation bump; NO re-synthesis, no double-speak);
 * clicking ANOTHER unit while one plays: stops current, starts new;
 * global toolbar Play/Pause cancels the unit and vice versa. The
 * currently-spoken row keeps .tts-speaking. */
function markSpeaking(row: El, on: boolean): void {
  row.classList.toggle("tts-speaking", on);
  if (on) row.setAttribute("data-tts-active", "1");
  else row.removeAttribute("data-tts-active");
}
// one global listener clears stale highlights whenever TTS stops/pauses/errors
let ttsHighlightBound = false;
function bindTTSHighlightClear(): void {
  if (ttsHighlightBound) return;
  ttsHighlightBound = true;
  onTTSStatus((s) => {
    if (s === "playing" || s === "loading") return;
    document
      .querySelectorAll<HTMLElement>(".tts-speaking")
      .forEach((r) => markSpeaking(r, false));
  });
}

function ttsButtonForUnit(unit: Unit, row: El, token: string, domRef?: string | null): El {
  const b = el("button", "tts-unit-btn", "🔊") as HTMLButtonElement;
  b.type = "button";
  const idleTitle = "Play this line from the start (espeak-ng grc, reconstructed)";
  b.title = idleTitle;
  b.setAttribute("aria-label", `Play ${domRef || unit.ref || "unit"} in Ancient Greek`);
  b.addEventListener("click", (e) => {
    e.stopPropagation();
    // second click while THIS unit is active → STOP, never re-synthesize
    if (isUnitActive(token)) {
      stopUnit(token); // generation bump discards in-flight WAV work
      markSpeaking(row, false);
      b.textContent = "🔊";
      b.classList.remove("tts-loading");
      b.title = idleTitle;
      return;
    }
    // EXACT unit text — never a joined neighborhood or cached queue slice
    const text = unit.words.join(" ").trim();
    if (!text.trim()) return;
    stopTTS(); // clicking another unit's 🔊 (or re-start) stops the previous
    bindTTSHighlightClear();
    markSpeaking(row, true);
    b.classList.add("tts-loading");
    b.textContent = "⏹";
    b.title = "Stop";
    void speakGreek(text, token)
      .catch(() => { /* status handled via onTTSStatus */ })
      .finally(() => {
        if (!isUnitActive(token)) {
          markSpeaking(row, false);
          b.textContent = "🔊";
          b.classList.remove("tts-loading");
          b.title = idleTitle;
        }
      });
  });
  return b;
}

function aiButtonForUnit(unit: Unit): El {
  const b = el("button", "ai-btn ai-btn-line", "AI") as HTMLButtonElement;
  b.type = "button";
  b.title = "AI Translate this line";
  b.setAttribute("aria-label", `AI translate ${unit.ref || "unit"}`);
  // Handler bound by llm-panel's attachRowButtons (deterministic header placement)
  // No direct listener here to avoid duplicate binding; sweeper will attach via data-ai-bound
  return b;
}

let currentProsodyWorkId: string | null = null;

export function setProsodyWorkId(id: string | null): void {
  currentProsodyWorkId = id;
}

/** Shipped data refs repeat when an edition chunks one verse into several
 *  units (Mark 1.2 → 4 daṇḍa chunks; baseline bug 5b). DOM refs must be
 *  unique for deep links / resume tracking, so the first occurrence keeps
 *  the verbatim ref and repeats get letter suffixes: 1.2a, 1.2b, …
 *  Counts are keyed per container (one reader view = one work), so
 *  pagination continues the sequence and route changes reset it.
 *  unit.ref itself is NEVER mutated — translation alignment matches on it. */
const refCountsByRoot = new WeakMap<El, Map<string, number>>();

export function uniqueDomRef(container: El, ref: string): string {
  let counts = refCountsByRoot.get(container);
  if (!counts) {
    counts = new Map();
    refCountsByRoot.set(container, counts);
  }
  const n = counts.get(ref) ?? 0;
  counts.set(ref, n + 1);
  if (n === 0) return ref;
  return n <= 26 ? `${ref}${String.fromCharCode(96 + n)}` : `${ref}${n}`;
}

export function renderUnits(
  container: El,
  units: Unit[],
  ctx: RenderCtx,
  kind: "verse" | "prose" = "verse",
  baseIndex = 0,
): void {
  resetExpansion(container);
  currentCtx = ctx;
  units.forEach((unit, uIdx) => {
    const row = el("div", kind === "prose" ? "unit prose-unit" : "line");
    // unique per-work DOM ref (repeated verse chunks get letter suffixes);
    // unit.ref stays verbatim for translation alignment
    const domRef = unit.ref ? uniqueDomRef(container, unit.ref) : null;
    if (domRef) row.dataset.ref = domRef; // deep-link / resume target
    // Deterministic header: ref + right-aligned grouped actions (TTS + AI)
    const head = el("div", "unit-head");
    // prose-head alias for backward compat + styling
    if (kind === "prose") head.classList.add("prose-head");
    const showRef = kind === "verse" ? !!unit.ref : !!(unit.ref && (baseIndex + uIdx) % 5 === 0);
    if (showRef && domRef) {
      const refEl = el("span", kind === "verse" ? "ref-label" : "ref-badge", domRef);
      if (kind === "verse") refEl.title = `ref ${domRef}`;
      head.appendChild(refEl);
    }
    const actions = el("div", "unit-actions");
    actions.appendChild(ttsButtonForUnit(unit, row, `u${baseIndex + uIdx}`, domRef));
    const star = starButtonFor(domRef ?? unit.ref);
    if (star) actions.appendChild(star);
    const copy = copyLinkButtonFor(domRef ?? unit.ref);
    if (copy) actions.appendChild(copy);
    actions.appendChild(aiButtonForUnit(unit));
    head.appendChild(actions);
    row.appendChild(head);

    const greek = el("div", "greek-line");
    greek.setAttribute("lang", "grc");
    const parseRow = el("div", "parse-row");

    // unit-initial person name => speaker label (first 1-2 TitleCase pers words)
    // Render speakerSpan as colored label with hashColor, EXCLUDE from parse lookup
    const spkCount = speakerSpanCount(unit, ctx);
    const speakerWords = unit.words.slice(0, spkCount);
    const restWords = unit.words.slice(spkCount);
    if (speakerWords.length) {
      speakerWords.forEach((w, idx) => {
        const parses = ctx.morph.get(stripAccents(w)) ?? [];
        const hit = parses.find((p) => isPersonParse(p));
        const canonical = stripAccents(hit?.l || w);
        const col = hashColor(canonical);
        // include `w` for compatibility with existing selector tests, but
        // speaker is NOT given a parse card and is not interactive as normal word
        const label = el("span", `w speaker spk-${col}`, w);
        label.title = `speaker: ${hit?.l || w}`;
        // distinguish from normal w: no click handler, no parse column
        greek.appendChild(label);
        if (idx < speakerWords.length - 1) greek.appendChild(document.createTextNode(" "));
      });
      if (restWords.length) greek.appendChild(document.createTextNode(" "));
    }

    restWords.forEach((w, i) => {
      const parses = ctx.morph.get(stripAccents(w)) ?? [];
      const span = el("span", "w", w);
      span.dataset.stripped = stripAccents(w); // vocab book key
      const col = parseCards(w, ctx);
      const many = parses.length > 1;
      span.addEventListener("click", () => {
        // word click: full side panel (all analyses + LSJ) — acceptance
        // behaviour — and, when several candidates exist, also expand the
        // inline candidate list in place.
        openPanel(span, w, ctx);
        if (many) toggleExpanded(w, ctx);
      });
      // double-click keeps the full side panel too (no-op if already open)
      span.addEventListener("dblclick", () => openPanel(span, w, ctx));
      greek.appendChild(span);
      if (i < restWords.length - 1) {
        greek.appendChild(document.createTextNode(" "));
      }
      parseRow.appendChild(col);
    });

    row.appendChild(greek);

    // prosody: word-aligned scansion under each verse Greek line (toggle via
    // toolbar). Each .scan-u span maps 1:1 to the .w span above it; widths are
    // pinned by alignScansionRows() so symbols sit exactly under their word.
    if (kind === "verse" && currentProsodyWorkId) {
      const globalIdx = baseIndex + uIdx;
      const pat = getProsodyPattern(currentProsodyWorkId, unit.ref, globalIdx);
      if (pat) {
        const scan = buildScansionRow(unit.ref, unit.words, pat);
        // visibility controlled by body.show-prosody; alignment deferred to
        // the prosody-toggle/observer passes (element is display:none now)
        row.appendChild(scan);
      }
    }

    row.appendChild(parseRow);
    container.appendChild(row);
    registerForReflow(row);
  });
  applyClasses(); // vocab dimming + stats chip for the freshly rendered page
  if (isProsodyEnabled()) {
    requestAnimationFrame(() => alignAllScansions());
  }
}

/* ---------------- scansion alignment ----------------
 * Pin each .scan-u span to the exact box of its .w word span: width := word
 * width, trailing margin := the gap to the next word. Both rows then wrap at
 * identical points (same column widths), so every — / ∪ sits under its word
 * and foot pipes land between the right syllables. Runs only while rows are
 * visible (display:none under body:not(.show-prosody)); re-run on toggle,
 * font resize, and web-font load. */

function alignScansionContainer(scan: El, greek: El): boolean {
  const sus = Array.from(scan.querySelectorAll<HTMLElement>(".scan-u"));
  const ws = Array.from(greek.querySelectorAll<HTMLElement>(".w"));
  if (!sus.length || ws.length < sus.length) return false;
  // hidden rows can't be measured — flag for the next pass instead
  if (!scan.isConnected || scan.getClientRects().length === 0) return false;
  for (let i = 0; i < sus.length; i++) {
    const w = ws[i];
    const su = sus[i];
    const wr = w.getBoundingClientRect();
    su.style.width = `${wr.width}px`;
    if (i < sus.length - 1) {
      const wn = ws[i + 1].getBoundingClientRect();
      su.style.marginRight = `${Math.max(0, wn.left - wr.right)}px`;
    } else {
      su.style.marginRight = "0px";
    }
  }
  scan.removeAttribute("data-needs-align");
  return true;
}

/** Align every visible scansion row against its Greek line. */
export function alignAllScansions(): void {
  document.querySelectorAll<HTMLElement>(".line, .prose-unit").forEach((row) => {
    const scan = row.querySelector<HTMLElement>(":scope > .scansion");
    if (scan) {
      const greek = row.querySelector<HTMLElement>(":scope > .greek-line");
      if (greek) alignScansionContainer(scan, greek);
    }
    // split (reflowed) rows: one scansion per visual-line block
    row.querySelectorAll<HTMLElement>(".vline").forEach((b) => {
      const scanB = b.querySelector<HTMLElement>(":scope > .scansion");
      const greekB = b.querySelector<HTMLElement>(":scope > .greek-line");
      if (scanB && greekB) alignScansionContainer(scanB, greekB);
    });
  });
}

// keep alignment fresh: prosody toggle, viewport resize / font-size buttons,
// web-font swap. (renderUnits batches call it directly after append.)
let scansionHooksBound = false;
function bindScansionHooks(): void {
  if (scansionHooksBound) return;
  scansionHooksBound = true;
  onProsodyToggle(() => {
    requestAnimationFrame(() => requestAnimationFrame(alignAllScansions));
  });
}
bindScansionHooks();

/* ---------------- speaker labels ---------------- */

/** Proper-name speaker lexicon: the ONLY words that may ever render as a
 *  colored speaker label. Extend as dialogue works ship. */
export const SPEAKER_LEMMAS = new Set<string>([
  // Platonic cast
  "σωκρατησ", "πλατων", "φαιδρος", "γλαυκων", "αδειμαντοσ",
  "θρασυμαχοσ", "πολεμαρχοσ", "κεφαλοσ", "λυσις", "μενοξενοσ",
  "χαρμιδησ", "ιππιας", "πρωταγορας", "μενων", "κριτιας", "τιμαιοσ",
  "ερμογονης", "απολλοδωρος", "παμφιλος", "εικρατης", "ιων",
  "κριτων", "κεβεισ", "σιμμιασ", "ευθυφρων", "κριτωνα", "κεβεισοσ",
  // include stripped variants without accents for robustness (stripAccents lower)
  "σωκρατεσ", "κριτωνοσ",
  // MSS speaker abbreviations used by dialogue editions (ΣΩ, ΙΩΝ, ΚΡ)
  // ευθ = Euthyphro, μελητοσ = Meletus — unit-initial in Plato's Euthyphro;
  // without ευθ every ΕΥΘ unit fell through and only ΣΩ ever colored,
  // collapsing the whole dialogue to a single speaker hue (baseline bug 5).
  "σω", "σοκ", "κρ", "κρι", "ευθ", "μελητοσ",
  // NT / LXX frequent actors
  "ιησους", "πετρος", "παυλος", "ιωαννησ", "μωυσησ", "πιλατος",
  "ηρως", "δαβιδ", "αβρααμ",
]);

/** Works whose editions carry REAL speaker labels (dramatic dialogues).
 *  Speaker coloring is gated to these: in epistles, histories and scripture
 *  a leading proper name is the narrator's subject or a vocative addressee
 *  ("ΠΑΥΛΟΣ…", ἀδελφοί), never the voice speaking. */
const DIALOGUE_TLGS = new Set([
  "tlg0006", // Euripides
  "tlg0011", // Sophocles
  "tlg0019", // Aristophanes
  "tlg0059", // Plato
  "tlg0062", // Lucian
  "tlg0085", // Aeschylus
]);

/** Morpheus marks person names with a "pers" feature token; used only to
 *  resolve a canonical lemma/label once a word already passed the lexicon
 *  gate — it no longer qualifies a word on its own. */
export function isPersonParse(p: Parse): boolean {
  return (
    /\bpers\b/.test(p.f ?? "") ||
    /\bpers\b/.test(p.x ?? "") ||
    SPEAKER_LEMMAS.has(stripAccents(p.l ?? ""))
  );
}

function isTitleCase(word: string): boolean {
  if (!word) return false;
  const first = word[0];
  const rest = word.slice(1);
  const isUpper = first !== first.toLowerCase() && first === first.toUpperCase();
  if (!isUpper) return false;
  // rest lowercase or empty (allows ΙΩΝ all-caps to be handled separately)
  return rest === rest.toLowerCase();
}
function isAllCapsGreek(word: string): boolean {
  return word.length >= 2 && word === word.toUpperCase() && word !== word.toLowerCase();
}

/**
 * Speaker test, tightened after false positives in 1 Corinthians:
 * the form must LOOK like a speaker label (TitleCase name or all-caps MSS
 * abbreviation such as ΣΩ / ΙΩΝ / ΚΡ) AND its accent-stripped form must be
 * in the SPEAKER_LEMMAS proper-name lexicon. Previously ANY all-caps token
 * (ΚΑΙ, ΔΕ…) or any parse carrying a "pers" tag qualified — which coloured
 * epistle openings like ΠΑΥΛΟΣ κλητὸς ἀπόστολος as a "speaker".
 */
function isSpeakerWord(word: string): boolean {
  const stripped = stripAccents(word);
  return (
    (isTitleCase(word) || isAllCapsGreek(word)) &&
    SPEAKER_LEMMAS.has(stripped)
  );
}

/** How many LEADING words are person names (cap 2). Genre-gated: coloring
 *  only happens for known dialogue works. */
export function speakerSpanCount(unit: Unit, ctx: RenderCtx): number {
  if (!ctx.tlg || !DIALOGUE_TLGS.has(ctx.tlg)) return 0;
  const n = Math.min(2, unit.words.length);
  let count = 0;
  for (let i = 0; i < n; i++) {
    if (isSpeakerWord(unit.words[i])) count += 1;
    else break;
  }
  return count;
}

export function hashColor(s: string): number {
  let h = 0;
  for (const ch of s) h = (h * 31 + (ch.codePointAt(0) ?? 0)) >>> 0;
  return h % 10;
}

/** Speaker color for a unit (first leading person name), or null. */
export function getSpeakerColor(unit: Unit, ctx: RenderCtx): number | null {
  const n = speakerSpanCount(unit, ctx);
  if (n === 0) return null;
  const w = unit.words[0];
  const parses = ctx.morph.get(stripAccents(w)) ?? [];
  const hit = parses.find((p) => isPersonParse(p));
  // fallback canonical is the stripped word itself when pers missing
  const canonical = stripAccents(hit?.l || w);
  return hashColor(canonical);
}

/** Canonical speaker lemma / form for label, or null. */
export function getSpeakerLabel(unit: Unit, ctx: RenderCtx): string | null {
  const n = speakerSpanCount(unit, ctx);
  if (n === 0) return null;
  const w = unit.words[0];
  const parses = ctx.morph.get(stripAccents(w)) ?? [];
  const hit = parses.find((p) => isPersonParse(p));
  return hit?.l || w;
}

/** Style one word span as a speaker label with a stable per-name color. */
function markSpeaker(span: El, w: string, parses: Parse[]): void {
  const hit = parses.find((p) => isPersonParse(p));
  const canonical = stripAccents(hit?.l || w);
  span.classList.add("speaker", `spk-${hashColor(canonical)}`);
  span.title = `speaker: ${hit?.l || w}`;
}

/* ---------------- parse-area cap ---------------- */

/* ---------------- viewport-width interlinear reflow ----------------
 * Greek text wraps naturally in the browser; once a row is near the
 * viewport we READ the browser's own wrap points (word-span offsetTop
 * groups) and restructure the DOM so every VISUAL line gets its parse
 * cards directly beneath it — NoDictionaries-style. Repacked on
 * container resize (debounced), font-size change, and web-font load.
 * Only rows within ~1 screen ahead are processed. */

interface ReflowEntry {
  row: El;
  done: boolean;
}
const reflowRows = new Set<ReflowEntry>();
let reflowIO: IntersectionObserver | null = null;
let resizeTimer = 0;
let appRO: ResizeObserver | null = null;

/** Repack when the CONTENT CONTAINER changes WIDTH — drawer open/close,
 *  side panel, or a font-size change all shift wrap points without a
 *  window resize event (baseline bugs 1/3: stale packs under the drawer).
 *  Width-only: re-packing changes the container HEIGHT, so a naive
 *  observer would repack-loop forever and never let the page settle. */
function ensureAppResizeObserver(): void {
  if (appRO || typeof ResizeObserver === "undefined") return;
  const app = document.getElementById("app");
  if (!app) return;
  let lastW = app.getBoundingClientRect().width;
  appRO = new ResizeObserver((ents) => {
    const w = ents[0]?.contentRect.width ?? app.getBoundingClientRect().width;
    if (Math.abs(w - lastW) < 0.5) return; // height-only change → ignore
    lastW = w;
    onReflowResize();
  });
  appRO.observe(app);
}

function registerForReflow(row: El): void {
  // drop rows from torn-down views (route changes)
  for (const e of reflowRows) {
    if (!e.row.isConnected) reflowRows.delete(e);
  }
  const entry: ReflowEntry = { row, done: false };
  reflowRows.add(entry);
  ensureReflowObserver().observe(row);
}

function ensureReflowObserver(): IntersectionObserver {
  if (reflowIO) return reflowIO;
  reflowIO = new IntersectionObserver(
    (ents) => {
      for (const e of ents) {
        if (!e.isIntersecting) continue;
        for (const entry of reflowRows) {
          if (entry.row === e.target && !entry.done) {
            entry.done = true;
            requestAnimationFrame(() => reflowRow(entry));
          }
        }
      }
    },
    { rootMargin: "100% 0px" }, // ~one screen ahead
  );
  // web fonts change every width — repack when they settle
  document.fonts?.ready.then(() => {
    repackAll();
    alignAllScansions();
  }).catch(() => {});
  window.addEventListener("resize", onReflowResize);
  ensureAppResizeObserver();
  return reflowIO;
}

function onReflowResize(): void {
  window.clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(() => {
    repackAll();
    alignAllScansions(); // glyph widths changed → re-pin scansion columns
  }, 150);
}

/** Undo all splits and re-run the wrap-point pass from scratch. */
export function repackAll(): void {
  for (const entry of reflowRows) {
    unsplitRow(entry.row);
    entry.done = false;
    reflowIO?.unobserve(entry.row);
    reflowIO?.observe(entry.row);
  }
}

/** Restore the flat one-paragraph layout (pre-split). */
function unsplitRow(row: El): void {
  const blocks = Array.from(row.querySelectorAll(".vline"));
  if (!blocks.length) return;
  const head = row.querySelector(".unit-head");
  const aiOut = row.querySelector(":scope > .ai-out") as El | null;
  // gather word-aligned scansion spans back in word order
  const scanUs: HTMLElement[] = [];
  for (const b of blocks) {
    b.querySelectorAll<HTMLElement>(".scansion .scan-u")
      .forEach((s) => scanUs.push(s));
  }
  const greek = el("div", "greek-line");
  greek.setAttribute("lang", "grc");
  const parseRow = el("div", "parse-row");
  for (const b of blocks) {
    const gl = b.querySelector(".greek-line");
    const pr = b.querySelector(".parse-row");
    while (gl?.firstChild) greek.appendChild(gl.firstChild);
    while (pr?.firstChild) parseRow.appendChild(pr.firstChild);
    b.remove();
  }
  row.replaceChildren();
  if (head) row.appendChild(head);
  row.appendChild(greek);
  if (scanUs.length) {
    const scan = el("div", "scansion");
    for (const s of scanUs) scan.appendChild(s);
    row.appendChild(scan);
    requestAnimationFrame(() => alignAllScansions());
  }
  row.appendChild(parseRow);
  if (aiOut) row.appendChild(aiOut);
}

/** Split one rendered row into per-visual-line blocks using the
 *  browser's own wrap points (offsetTop of the word spans).
 *  Baseline bug 1 root cause: speaker labels are `.w` spans but carry NO
 *  parse-card column — grouping by ALL `.w` spans shifted every card one
 *  slot left per speaker and orphaned the row's last cards. Only
 *  card-bearing words are grouped; speaker labels ride in the first block. */
function reflowRow(entry: ReflowEntry): void {
  const { row } = entry;
  const greek = row.querySelector(":scope > .greek-line") as El | null;
  const parseRow = row.querySelector(":scope > .parse-row") as El | null;
  if (!greek || !parseRow || row.querySelector(".vline")) return;
  const spans = Array.from(
    greek.querySelectorAll<HTMLElement>(".w:not(.speaker)"),
  );
  if (spans.length < 2) return;

  // group card-word indices by visual line via offsetTop
  const groups: number[][] = [[]];
  let top = spans[0].offsetTop;
  spans.forEach((s, i) => {
    if (s.offsetTop !== top) {
      groups.push([]);
      top = s.offsetTop;
    }
    groups[groups.length - 1].push(i);
  });
  if (groups.length < 2) return; // single visual line

  // bucket every child node under its CARD word: a `.w:not(.speaker)` span
  // opens its own bucket; speaker labels, spaces and ref-labels attach to
  // the current (preceding) word — bucket 0 while still leading the unit.
  const buckets: Node[][] = spans.map(() => []);
  // scansion spans are per unit.words (ALL words, speakers included) — keep
  // a card-index → all-word-index map so scan symbols follow their word
  const cardToAll: number[] = [];
  let wi = 0;
  let allWi = 0;
  for (const n of Array.from(greek.childNodes)) {
    const isW = n.nodeType === 1 && (n as Element).classList.contains("w");
    const isCardWord = isW &&
      !(n as Element).classList.contains("speaker");
    if (isCardWord) {
      buckets[Math.min(wi, spans.length - 1)].push(n);
      cardToAll[wi] = allWi;
      wi += 1;
    } else {
      buckets[Math.max(0, wi - 1)].push(n);
    }
    if (isW) allWi += 1;
  }

  const head = row.querySelector(".unit-head");
  // Preserve AI output if present (should stay outside vlines, at row end)
  const aiOut = row.querySelector(":scope > .ai-out") as El | null;
  // word-aligned scansion: distribute spans into their own visual-line block
  const scanRow = row.querySelector(":scope > .scansion") as El | null;
  const scanUs = scanRow
    ? Array.from(scanRow.querySelectorAll<HTMLElement>(".scan-u"))
    : [];
  const frag = document.createDocumentFragment();
  // measure container width explicitly to pack correctly (prose paragraphs)
  void row.clientWidth;
  void greek.clientWidth;
  for (const g of groups) {
    const block = el("div", "vline");
    const gl = el("div", "greek-line");
    gl.setAttribute("lang", "grc");
    const pr = el("div", "parse-row");
    let bScan: El | null = scanUs.length ? el("div", "scansion") : null;
    if (bScan && scanRow) bScan.dataset.pattern = scanRow.dataset.pattern ?? "";
    // pack every word index in this visual line
    for (const idx of g) {
      for (const n of buckets[idx] ?? []) gl.appendChild(n);
      const su = scanUs[cardToAll[idx] ?? idx];
      if (su && bScan) bScan.appendChild(su); // scansion follows its word's line
    }
    // every visual Greek line gets exactly its parse row beneath
    for (let k = 0; k < g.length; k++) {
      const col = parseRow.firstElementChild;
      if (!col) break;
      pr.appendChild(col);
    }
    block.appendChild(gl);
    if (bScan && bScan.childElementCount) block.appendChild(bScan);
    block.appendChild(pr);
    frag.appendChild(block);
  }
  row.replaceChildren();
  if (head) row.appendChild(head);
  row.appendChild(frag);
  if (aiOut) row.appendChild(aiOut);
  requestAnimationFrame(() => alignAllScansions());
}

/** Back-compat alias used by the paste page. */
export const renderLines = renderUnits;

/* ---------------- controls ---------------- */

export interface Controls {
  root: El;
}

/** This bar's TTS status subscription (re-bound per renderControls call). */
let ttsUiUnsub: (() => void) | null = null;

export function renderControls(crumbsText: string, onBack: () => void): Controls {
  const bar = el("nav", "controls");
  const back = el("button", undefined, "← Home");
  back.addEventListener("click", onBack);
  bar.appendChild(back);
  bar.appendChild(el("span", "crumbs", crumbsText));

  const spacer = el("span", "spacer");
  bar.appendChild(spacer);

  let showGloss = true;
  const tog = el("button", undefined, "Hide glosses");
  tog.setAttribute("aria-pressed", "true");
  tog.addEventListener("click", () => {
    showGloss = !showGloss;
    document.body.classList.toggle("hide-gloss", !showGloss);
    tog.textContent = showGloss ? "Hide glosses" : "Show glosses";
    tog.setAttribute("aria-pressed", String(showGloss));
  });
  bar.appendChild(tog);

  // expand/collapse all candidate lists (also key: E)
  const expAll = el("button", undefined, "Expand all");
  expAll.title = "Show every candidate parse (key: E)";
  expAll.addEventListener("click", expandAll);
  const colAll = el("button", undefined, "Collapse all");
  colAll.title = "Back to best-parse cards (key: E)";
  colAll.addEventListener("click", collapseAll);
  bar.appendChild(expAll);
  bar.appendChild(colAll);

  // vocabulary book: mode toggle group, stats chip, bulk page marking
  bar.appendChild(toolbarControls());
  attachChip(bar);

  // starred lines panel (list lives in bookmarks.ts)
  const starTitles = new Map<string, string>();
  loadCatalog().then((catalog) => {
    for (const author of catalog.authors) {
      for (const w of author.works) starTitles.set(w.id, w.title);
    }
  }).catch(() => {});
  const starsBtn = el("button", undefined, "★ Saved") as HTMLButtonElement;
  starsBtn.type = "button";
  starsBtn.title = "Bookmarked lines";
  starsBtn.addEventListener("click", () => openStarPanel(starTitles));
  bar.appendChild(starsBtn);

  // --- TTS global toggle: ONE button, state-labelled ----------------
  // ▶ Play (idle) ↔ ⏸ Pause (playing) ↔ ▶ Resume (paused). Stop was removed:
  // pausing covers the toolbar need, and any per-unit 🔊 click restarts from
  // scratch, so a dedicated Stop button had no job left.
  const ttsStatus = el("span", "tts-status");
  ttsStatus.setAttribute("aria-live", "polite");
  const ttsToggle = el("button", undefined, "▶ Play") as HTMLButtonElement;
  ttsToggle.type = "button";
  const updateTTSButtons = (): void => {
    const s = getTTSStatus();
    if (s === "playing") {
      ttsToggle.textContent = "⏸ Pause";
      ttsToggle.disabled = false;
      ttsToggle.title = "Pause playback";
      ttsStatus.textContent = "playing…";
    } else if (s === "paused") {
      ttsToggle.textContent = "▶ Resume";
      ttsToggle.disabled = false;
      ttsToggle.title = "Resume playback";
      ttsStatus.textContent = "paused";
    } else if (s === "loading") {
      ttsToggle.textContent = "⏳ Loading";
      ttsToggle.disabled = true;
      ttsStatus.textContent = "loading voice…";
    } else if (s === "fallback") {
      ttsToggle.textContent = "▶ Play";
      ttsToggle.disabled = false;
      ttsStatus.textContent = "modern approx.";
      ttsStatus.title = "espeak-ng grc unavailable — using Web Speech modern Greek approximation";
    } else if (s === "error") {
      ttsToggle.textContent = "▶ Play";
      ttsToggle.disabled = false;
      ttsStatus.textContent = "TTS error";
    } else {
      ttsToggle.textContent = "▶ Play";
      ttsToggle.disabled = false;
      ttsStatus.textContent = "";
      ttsStatus.title = "";
      ttsToggle.title = "Play all visible Greek (espeak-ng grc, reconstr. ancient)";
    }
  };
  // multi-listener TTS bus: drop this bar's previous subscription (route
  // re-render) before adding the fresh one, then keep the unsubscriber
  ttsUiUnsub?.();
  ttsUiUnsub = onTTSStatus((s, msg) => {
    if (s === "fallback" && msg) {
      ttsStatus.textContent = "modern approx.";
      ttsStatus.title = msg;
    } else if (s === "error" && msg) {
      ttsStatus.textContent = msg.slice(0, 40);
    }
    updateTTSButtons();
  });
  ttsToggle.addEventListener("click", () => {
    const s = getTTSStatus();
    if (s === "playing") { pauseTTS(); return; }
    if (s === "paused") { resumeTTS(); return; }
    if (s === "loading") return; // button is disabled anyway
    // idle / fallback / error: start playing the visible Greek from the top.
    // Interacting with the toolbar cancels per-unit playback entirely.
    document
      .querySelectorAll<HTMLElement>(".tts-speaking")
      .forEach((r) => markSpeaking(r, false));
    document.querySelectorAll<HTMLButtonElement>(".tts-unit-btn").forEach((b) => {
      if (b.textContent === "⏹") {
        b.textContent = "🔊";
        b.classList.remove("tts-loading");
      }
    });
    const rows = Array.from(document.querySelectorAll<HTMLElement>(".line, .prose-unit"));
    const texts: string[] = [];
    for (const r of rows) {
      const ws = Array.from(r.querySelectorAll<HTMLElement>(".w"))
        .map((n) => n.textContent ?? "")
        .filter(Boolean)
        .join(" ")
        .trim();
      if (ws) texts.push(ws);
    }
    if (!texts.length) {
      ttsStatus.textContent = "No Greek to speak";
      return;
    }
    void speakQueue(texts).catch(() => {});
  });
  updateTTSButtons();
  bar.appendChild(ttsToggle);
  bar.appendChild(ttsStatus);

  bar.appendChild(lexiconButton());

  const greekSize = () =>
    parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue("--greek-size"),
    ) || 1.35;
  const setGreekSize = (rem: number) =>
    document.documentElement.style.setProperty(
      "--greek-size",
      `${Math.min(2.4, Math.max(0.9, rem)).toFixed(2)}rem`,
    );
  const minus = el("button", undefined, "A−");
  minus.addEventListener("click", () => {
    setGreekSize(greekSize() - 0.15);
    onReflowResize(); // glyph widths changed → re-pack visual lines
  });
  const plus = el("button", undefined, "A+");
  plus.addEventListener("click", () => {
    setGreekSize(greekSize() + 0.15);
    onReflowResize();
  });
  bar.appendChild(minus);
  bar.appendChild(plus);

  bar.appendChild(themeControl());

  return { root: bar };
}

/* ---------------- side panel ---------------- */

let panel: El | null = null;

function ensurePanel(): El {
  if (panel) return panel;
  panel = el("aside", "side-panel hidden");
  panel.setAttribute("aria-label", "Word details");
  const close = el("button", "close-btn", "×");
  close.setAttribute("aria-label", "Close details");
  close.addEventListener("click", hidePanel);
  panel.appendChild(close);
  const body = el("div", "panel-body");
  panel.appendChild(body);
  document.body.appendChild(panel);
  return panel;
}

export function hidePanel(): void {
  if (panel) panel.classList.add("hidden");
  document.body.classList.remove("panel-open");
  document.querySelectorAll(".w.active").forEach((n) => n.classList.remove("active"));
}

function openPanel(span: El, word: string, ctx: RenderCtx): void {
  const p = ensurePanel();
  const body = p.querySelector(".panel-body") as El;
  body.replaceChildren();

  document.querySelectorAll(".w.active").forEach((n) => n.classList.remove("active"));
  span.classList.add("active");

  body.appendChild(el("h2", undefined, word));
  const parses = ctx.morph.get(stripAccents(word)) ?? [];

  // vocabulary book: mark/unmark this form (stores stripped key + best lemma)
  const stripped = stripAccents(word);
  const vrow = el("p", "panel-vocab");
  const vbtn = el("button", "panel-vocab-btn") as HTMLButtonElement;
  vbtn.type = "button";
  const paintV = (): void => {
    const knownNow = isKnown(stripped);
    vbtn.textContent = knownNow ? "Unmark" : "Mark known ✓";
    vbtn.classList.toggle("marked", knownNow);
    if (knownNow) span.classList.add("vk");
    else span.classList.remove("vk");
    vbtn.title = knownNow
      ? `Remove ${stripped} from your vocabulary`
      : `Remember ${stripped} (dim it while reading)`;
  };
  vbtn.addEventListener("click", () => {
    if (isKnown(stripped)) unmarkKnown(stripped);
    else {
      const bestLemma = parses.length
        ? parses[rankParses(parses)[0]].l
        : undefined;
      markKnown(stripped, bestLemma);
    }
    paintV();
    applyClasses();
  });
  paintV();
  vrow.appendChild(vbtn);
  body.appendChild(vrow);

  if (parses.length === 0) {
    body.appendChild(el("p", "word-form", "No analyses available for this form."));
  } else {
    body.appendChild(
      el("p", "word-form", `${parses.length} analysis${parses.length > 1 ? "es" : ""}`),
    );
    const seenLemmas = new Set<string>();
    for (const parse of parses) {
      const entry = el("div", "entry");
      entry.appendChild(el("span", "lemma", parse.l || "?"));
      const feats = [parse.p, parse.f, parse.x].filter(Boolean).join(" · ");
      const fEl = el("span", "feats", feats);
      entry.appendChild(fEl);
      const gl = ctx.gloss.get(stripAccents(parse.l));
      if (gl) {
        entry.appendChild(el("div", "dict-gloss", `${gl.u}: ${gl.g}`));
      }
      body.appendChild(entry);
      seenLemmas.add(stripAccents(parse.l));
    }
  }

  // full dictionary entries for each distinct lemma of this form
  const dictEntries: Gloss[] = [];
  for (const parse of parses) {
    const gl = ctx.gloss.get(stripAccents(parse.l));
    if (gl && !dictEntries.some((d) => d.u === gl.u)) dictEntries.push(gl);
  }
  if (dictEntries.length) {
    body.appendChild(el("h3", undefined, "LSJ"));
    for (const d of dictEntries) {
      const entry = el("div", "entry");
      entry.appendChild(el("span", "lemma", d.u));
      entry.appendChild(el("div", "dict-gloss", d.g));
      body.appendChild(entry);
    }
  }

  // Homeric dictionaries below LSJ — Autenrieth first, then Cunliffe.
  // Only while reading Homer; lazy letter shards per dictionary; each
  // section hidden when the lemma has no entry there.
  if (parses.length) {
    const bestForDict = parses[rankParses(parses)[0]];
    const wantWord = word;
    void (async () => {
      if (!(await isHomerActive())) return;
      if (!bestForDict.l) return;
      const openWord = wantWord;
      for (const d of HOMER_DICTS) {
        const entries = await fetchHomerEntries(d.id, [bestForDict.l]);
        const entry = entries.get(stripAccents(bestForDict.l));
        if (!entry || !panel || panel.classList.contains("hidden")) continue;
        if ((body.querySelector("h2")?.textContent ?? "") !== openWord) return;
        body.appendChild(el("h3", "autenrieth-head",
          `${d.label} (Homeric)`));
        const entryDiv = el("div", "entry autenrieth-entry");
        entryDiv.appendChild(el("span", "lemma", entry.u));
        entryDiv.appendChild(el("div", "dict-gloss", entry.g));
        body.appendChild(entryDiv);
      }
    })();
  }

  // deep-link into the lexicon drawer, prefilled with the best lemma
  if (parses.length) {
    const best = parses[rankParses(parses)[0]];
    if (best.l) {
      const jump = el("button", undefined, "Open in Lexicon ↗") as HTMLButtonElement;
      jump.type = "button";
      jump.addEventListener("click", () => openLexicon(best.l));
      body.appendChild(jump);
    }
  }

  p.classList.remove("hidden");
  document.body.classList.add("panel-open"); // squeeze #app so controls stay clickable
}
