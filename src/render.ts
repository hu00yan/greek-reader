// Shared interlinear rendering: Greek units (verse lines or prose chunks)
// with per-word parse cards, controls bar, and the click-for-details panel.
import { loadGloss, loadMorph, stripAccents, type Gloss, type Parse, type Unit } from "./api";
import { openLexicon, lexiconButton } from "./lexicon";
import { themeControl } from "./theme";

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
 *  Refs render VERBATIM — Stephanus/Bekker/book.line strings as shipped. */
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
    if (kind === "prose") {
      const head = el("div", "prose-head");
      if (unit.ref && (baseIndex + uIdx) % 5 === 0) {
        head.appendChild(el("span", "ref-badge", unit.ref));
      }
      row.appendChild(head);
    }
    const greek = el("div", "greek-line");
    greek.setAttribute("lang", "grc");
    const parseRow = el("div", "parse-row");

    if (kind === "verse" && unit.ref) {
      const refLabel = el("span", "ref-label", unit.ref);
      refLabel.title = `ref ${unit.ref}`;
      greek.appendChild(refLabel);
    }

    // unit-initial person name => speaker label (v1: leading tokens only)
    const spkCount = speakerSpanCount(unit, ctx);

    unit.words.forEach((w, i) => {
      const parses = ctx.morph.get(stripAccents(w)) ?? [];
      const span = el("span", "w", w);
      if (i < spkCount) markSpeaker(span, w, parses);
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
      if (i < unit.words.length - 1) {
        greek.appendChild(document.createTextNode(" "));
      }
      parseRow.appendChild(col);
    });

    row.appendChild(greek);
    row.appendChild(parseRow);
    container.appendChild(row);
    registerForReflow(row);
  });
}

/* ---------------- speaker labels ---------------- */

/** Morpheus marks person names with a "pers" feature token; the shipped
 *  static shards carry no such tag, so frequent dialogue speakers are
 *  also matched through this lemma config map. Extend as works ship. */
const SPEAKER_LEMMAS = new Set<string>([
  // Platonic cast
  "σωκρατησ", "πλατων", "φαιδρος", "γλαυκων", "αδειμαντοσ",
  "θρασυμαχοσ", "πολεμαρχοσ", "κεφαλοσ", "λυσις", "μενοξενοσ",
  "χαρμιδησ", "ιππιας", "πρωταγορας", "μενων", "κριτιας", "τιμαιοσ",
  "ερμογονης", "απολλοδωρος", "παμφιλος", "εικρατης",
  // NT / LXX frequent actors
  "ιησους", "πετρος", "παυλος", "ιωαννησ", "μωυσησ", "πιλατος",
  "ηρως", "δαβιδ", "αβρααμ",
]);

function isPersonParse(p: Parse): boolean {
  return (
    /\bpers\b/.test(p.f ?? "") ||
    /\bpers\b/.test(p.x ?? "") ||
    SPEAKER_LEMMAS.has(stripAccents(p.l ?? ""))
  );
}

/** How many LEADING words are person names (cap 2). */
function speakerSpanCount(unit: Unit, ctx: RenderCtx): number {
  const n = Math.min(2, unit.words.length);
  let count = 0;
  for (let i = 0; i < n; i++) {
    const parses = ctx.morph.get(stripAccents(unit.words[i])) ?? [];
    if (parses.some(isPersonParse)) count += 1;
    else break;
  }
  return count;
}

function hashColor(s: string): number {
  let h = 0;
  for (const ch of s) h = (h * 31 + (ch.codePointAt(0) ?? 0)) >>> 0;
  return h % 10;
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
  document.fonts?.ready.then(() => repackAll()).catch(() => {});
  window.addEventListener("resize", onReflowResize);
  return reflowIO;
}

function onReflowResize(): void {
  window.clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(repackAll, 150);
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
  const head = row.querySelector(".prose-head");
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
  row.appendChild(parseRow);
}

/** Split one rendered row into per-visual-line blocks using the
 *  browser's own wrap points (offsetTop of the word spans). */
function reflowRow(entry: ReflowEntry): void {
  const { row } = entry;
  const greek = row.querySelector(".greek-line") as El | null;
  const parseRow = row.querySelector(".parse-row") as El | null;
  if (!greek || !parseRow || row.querySelector(".vline")) return;
  const spans = Array.from(greek.querySelectorAll<HTMLElement>(".w"));
  if (spans.length < 2) return;

  // group word indices by visual line via offsetTop
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

  // bucket every child node under its word: a .w span opens its own
  // bucket; spaces/ref-labels attach to the current (preceding) word
  const buckets: Node[][] = spans.map(() => []);
  let wi = 0;
  for (const n of Array.from(greek.childNodes)) {
    const isW = n.nodeType === 1 &&
      (n as Element).classList.contains("w");
    if (!isW && wi === 0) buckets[0].push(n); // ref label / leading junk
    else if (isW) buckets[Math.min(wi, spans.length - 1)].push(n);
    else buckets[Math.max(0, wi - 1)].push(n); // trailing space
    if (isW) wi += 1;
  }

  const head = row.querySelector(".prose-head");
  const frag = document.createDocumentFragment();
  let colCursor = 0;
  let bucketCursor = 0;
  for (const g of groups) {
    const block = el("div", "vline");
    const gl = el("div", "greek-line");
    gl.setAttribute("lang", "grc");
    const pr = el("div", "parse-row");
    while (bucketCursor <= g[g.length - 1]) {
      for (const n of buckets[bucketCursor]) gl.appendChild(n);
      bucketCursor += 1;
    }
    const takeCols = g.length;
    while (colCursor < takeCols && parseRow.firstElementChild) {
      pr.appendChild(parseRow.firstElementChild);
      colCursor += 1;
    }
    block.appendChild(gl);
    block.appendChild(pr);
    frag.appendChild(block);
  }
  row.replaceChildren();
  if (head) row.appendChild(head);
  row.appendChild(frag);
}

/** Back-compat alias used by the paste page. */
export const renderLines = renderUnits;

/* ---------------- controls ---------------- */

export interface Controls {
  root: El;
}

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
}
