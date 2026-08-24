// Translation drawer: unit-aligned English text beside the reader.
// Catalog shape (defensive — corpus agent may add these concurrently):
//   work.translation = { files: string[], translator?: string,
//                        year?: string|number, license: string }
// Alignment: verse units match by ref; prose aligns best-effort by sequence.
// Scroll sync is approximate (proportional), highlighting the current unit.
import { fetchJSON, stripAccents, type CatalogWork, type Unit, type WorkPart } from "./api";
import { getSpeakerLabel, hashColor, SPEAKER_LEMMAS } from "./render";
import type { RenderCtx } from "./render";
import { attachDrawerResize } from "./drawer-resize";

type El = HTMLElement;
const el = (tag: string, cls?: string, text?: string): El => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text; // never innerHTML
  return e;
};

// -- speaker detection helpers (module-level for test hook) -----------------
// Greek -> English speaker map for fallback (Platonic cast etc.)
// Includes stripped accent-lower keys for all case forms and abbreviations.
const GREEK_TO_EN = new Map<string, string>([
  ["σωκρατησ", "Socrates"], ["σωκρατεσ", "Socrates"], ["σω", "Socrates"], ["σοκ", "Socrates"],
  ["ιων", "Ion"], ["ιωνα", "Ion"], ["ιωνοσ", "Ion"],
  ["πλατων", "Plato"], ["πλατωνοσ", "Plato"],
  ["φαιδροσ", "Phaedrus"], ["γλαυκων", "Glaucon"],
  ["αδειμαντοσ", "Adeimantus"], ["θρασυμαχοσ", "Thrasymachus"],
  ["πολεμαρχοσ", "Polemarchus"], ["κεφαλοσ", "Cephalus"],
  ["κριτων", "Crito"], ["κριτωνα", "Crito"], ["κριτωνοσ", "Crito"], ["κρ", "Crito"], ["κρι", "Crito"],
  ["κεβεισ", "Cebes"], ["σιμμιασ", "Simmias"], ["ευθυφρων", "Euthyphro"], ["μενων", "Meno"],
  ["λυσις", "Lysis"], ["χαρμιδησ", "Charmides"], ["ιππιασ", "Hippias"], ["πρωταγορασ", "Protagoras"],
]);
// Verbs of saying for strict start detection: "Socrates said:" / "Ion said"
const SAY_VERBS = "(said|says|replied|answered|asked|exclaimed|continued|rejoined|added|observed|remarked|returned|responded|cried|declared|stated|inquired|asked|replied|answered)";
// Pronouns / common words that should NOT be treated as speaker even if before "said"
const NON_SPEAKER_TOKENS = new Set(["He","She","They","It","We","You","I","The","This","That","There","Here","Then","When","Why","How","What","Where","Which","Who","Whom","A","An","And","But","Or","If","So","Because","Since","Although"]);
// Keep EN_KNOWN for backward compat but not used for permissive fallback; any TitleCase before colon/verb is allowed.
const EN_KNOWN = new Set(["Socrates", "Ion", "Plato", "Phaedrus", "Glaucon", "Adeimantus", "Thrasymachus", "Polemarchus", "Cephalus", "Crito", "Cebes", "Simmias", "Euthyphro", "Meno"]);

/** Strict speaker detection: only if name at VERY START followed by colon or verb-of-saying.
 *  Prevents coloring inline mentions like "Socrates mentions Crito mid-sentence".
 *  Returns canonical English name or null. High confidence only for colon/verb pattern. */
function englishSpeakerFromText(txt: string): string | null {
  const res = englishSpeakerFromTextStrict(txt);
  return res ? res.label : null;
}
function englishSpeakerFromTextStrict(txt: string): { label: string; high: boolean } | null {
  // 1) Name(s) directly before colon at very start: "Socrates:" or "Socrates Ion:" (rare)
  const m = txt.match(/^\s*([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\s*:/);
  if (m) {
    const name = m[1].trim();
    const firstTok = name.split(/\s+/)[0];
    if (NON_SPEAKER_TOKENS.has(firstTok)) return null;
    return { label: normalizeEngLabel(name), high: true };
  }
  // 2) Abbreviated forms before colon/dot: "Soc.:" / "Soc:" / "Ion:" (case-insensitive)
  const m2 = txt.match(/^\s*(Soc\.?|Ion\.?|Cri\.?|Ceb\.?|Sim\.?)\s*[:.]/i);
  if (m2) {
    const v = m2[1].toLowerCase();
    if (v.startsWith("soc")) return { label: "Socrates", high: true };
    if (v.startsWith("ion")) return { label: "Ion", high: true };
    if (v.startsWith("cri")) return { label: "Crito", high: true };
    if (v.startsWith("ceb")) return { label: "Cebes", high: true };
    if (v.startsWith("sim")) return { label: "Simmias", high: true };
  }
  // 3) Name + verb of saying at very start: "Socrates said:" / "Ion replied" etc.
  const verbRe = new RegExp(`^\\s*([A-Z][a-z]+(?:\\s+[A-Z][a-z]+)?)\\s+${SAY_VERBS}\\b\\s*:?`, "i");
  const m3 = txt.match(verbRe);
  if (m3) {
    const name = m3[1].trim();
    if (/^[A-Z][a-z]/.test(name)) {
      const firstTok = name.split(/\s+/)[0];
      if (NON_SPEAKER_TOKENS.has(firstTok)) return null;
      return { label: normalizeEngLabel(name), high: true };
    }
  }
  return null;
}
function normalizeEngLabel(raw: string): string {
  const t = raw.trim();
  return t.split(/\s+/).map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(" ");
}
// Expose for Playwright tests (window hook) at module load
try {
  if (typeof window !== "undefined") {
    (window as unknown as Record<string, unknown>).__englishSpeakerForTest = englishSpeakerFromText;
    (window as unknown as Record<string, unknown>).__englishSpeakerStrictForTest = englishSpeakerFromTextStrict;
    (window as unknown as Record<string, unknown>).__GREEK_TO_EN = GREEK_TO_EN;
  }
} catch {}

interface TrMeta {
  files?: string[];
  translator?: string;
  year?: string | number;
  license?: string;
}

export interface TranslationView {
  root: El;
  toggle(): void;
  isOpen(): boolean;
}

let scrollCleanup: (() => void) | null = null;

// drawer resizing lives in src/drawer-resize.ts (single shared implementation)

/** "Trans. A. T. Murray (1924) · Public domain" / "KJV 1769 · Public domain". */
export function creditLine(t: TrMeta): string {
  const bits: string[] = [];
  const who: string[] = [];
  if (t.translator) who.push(`Trans. ${t.translator}`);
  if (t.year !== undefined && t.year !== "") {
    who.push(String(t.year));
  }
  // bare year without translator reads like an edition ("KJV 1769")
  if (!t.translator && t.year !== undefined) {
    return [String(t.year), t.license].filter(Boolean).join(" · ");
  }
  if (who.length) bits.push(who.join(" "));
  if (t.license) bits.push(t.license);
  return bits.join(" · ");
}

// Close on Escape (global, idempotent) + outside-pointerdown backdrop.
// Both paths funnel through closeTrDrawer() so every closer stays consistent.
if (!(globalThis as unknown as Record<string, unknown>).__trEscBound) {
  (globalThis as unknown as Record<string, unknown>).__trEscBound = true;
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      const p = document.getElementById("tr-drawer");
      if (p && !p.classList.contains("hidden")) {
        p.classList.add("hidden");
        document.body.classList.remove("translation-open");
        p.dispatchEvent(new CustomEvent("tr-closed", { bubbles: false }));
      }
    }
  });
  // Invisible "backdrop": a pointerdown anywhere outside the drawer closes it.
  // Interactive chrome (toolbar, other drawers/panels, modals, gear) is
  // excluded so those clicks keep working instead of being swallowed.
  document.addEventListener("pointerdown", (e) => {
    const p = document.getElementById("tr-drawer");
    if (!p || p.classList.contains("hidden")) return;
    const t = e.target;
    if (!(t instanceof Element)) return;
    if (p.contains(t)) return;
    if (t.closest(
      ".controls, .side-panel, .drawer.left, .ai-modal-backdrop, .ai-gear-wrap, .lex-fab",
    )) return;
    p.classList.add("hidden");
    document.body.classList.remove("translation-open");
    p.dispatchEvent(new CustomEvent("tr-closed", { bubbles: false }));
  }, true);
}

/** Sticky drawer header: title + close button stay visible while scrolled. */
function buildHeadbar(title: string, onClose: () => void): El {
  const bar = el("div", "tr-headbar");
  const h = el("h2", undefined, title);
  h.id = "tr-title";
  const close = el("button", "close-btn", "×");
  close.setAttribute("aria-label", "Close translation");
  close.addEventListener("click", onClose);
  bar.append(h, close);
  return bar;
}

export async function openTranslation(
  work: CatalogWork,
  greekUnits: () => Unit[],
  ctx?: RenderCtx,
): Promise<TranslationView | null> {
  const meta = (work as { translation?: TrMeta }).translation;
  const files = meta?.files ?? [];
  if (!files.length) return null;

  let panel = document.getElementById("tr-drawer") as El | null;
  if (!panel) {
    panel = el("aside", "drawer right hidden");
    panel.id = "tr-drawer";
    panel.setAttribute("aria-label", "English translation");
    document.body.appendChild(panel);
  }
  panel.replaceChildren();

  const hide = (): void => {
    panel!.classList.add("hidden");
    document.body.classList.remove("translation-open");
    panel!.dispatchEvent(new CustomEvent("tr-closed", { bubbles: false }));
  };
  panel.appendChild(buildHeadbar(`English — ${work.title}`, hide));

  const credits = el("p", "tr-credits");
  const credit = creditLine(meta ?? {});
  if (credit) credits.textContent = credit;
  else credits.textContent = "Translation";
  panel.appendChild(credits);

  const body = el("div", "tr-body");
  panel.appendChild(body);
  const note = el("p", "tr-credits", "Loading translation…");
  panel.appendChild(note);

  // fetch all translation parts (Greek WorkPart shape or trans {text} shape)
  let trUnits: Unit[] = [];
  try {
    const parts = await Promise.all(
      files.map((f) => fetchJSON<WorkPart & { units: Array<Unit & { text?: string; w?: string }> }>(`data/${f}`)),
    );
    for (const p of parts) {
      for (const u of p.units as Array<Unit & { text?: string; w?: string }>) {
        // normalize trans shape: {ref,text} or compact {w} -> {words}
        if (Array.isArray((u as Unit).words)) {
          trUnits.push(u as Unit);
        } else if (typeof u.text === "string") {
          trUnits.push({ ref: u.ref, words: u.text.split(/\s+/).filter(Boolean) } as Unit);
          // keep original text for exact rendering
          (trUnits[trUnits.length - 1] as unknown as { _text: string })._text = u.text;
        } else if (typeof u.w === "string") {
          trUnits.push({ ref: u.ref, words: (u.w as string).split(" ").filter(Boolean) } as Unit);
        } else {
          trUnits.push({ ref: u.ref, words: [] } as Unit);
        }
      }
    }
    note.textContent = trUnits.length
      ? ""
      : "Translation file has no units.";
  } catch (e) {
    note.textContent = `Translation unavailable: ${(e as Error).message}`;
  }

  // render English rows; verse aligns by ref, prose by sequence index
  // Speaker coloring: use English speaker names extracted from translation text's
  // first words before colon, mapped via same hashColor as Greek. Preserve original
  // casing from public/data/trans/*.json (no toUpperCase).
  body.replaceChildren();
  const greek = greekUnits();

  // (uses module-level GREEK_TO_EN, EN_KNOWN, englishSpeakerFromText etc.)
  // still build Greek speaker map as fallback provenance
  const greekSpeakerByIdx = new Map<number, string>();
  for (let i = 0; i < greek.length; i++) {
    const gu = greek[i];
    let label: string | null = null;
    if (ctx) label = getSpeakerLabel(gu, ctx);
    else if (gu.words.length) {
      const w0 = gu.words[0];
      const key = stripAccents(w0).toLowerCase();
      const isCap = w0[0] !== w0[0].toLowerCase() && w0[0] === w0[0].toUpperCase();
      const isAllCaps = w0.length >= 2 && w0 === w0.toUpperCase() && w0 !== w0.toLowerCase();
      if (SPEAKER_LEMMAS.has(key) || (isCap && w0.length > 2) || isAllCaps) label = w0;
    }
    if (label) greekSpeakerByIdx.set(i, label);
  }

  // Confidence for translation speaker coloring:
  // If Greek fallback mapping success rate < threshold, English/Greek alignment is uncertain
  // => render all translation labels black (no spk- color) as user prefers over wrong colors.
  // Also compute English strict high-confidence count for reporting.
  let highEnglishCount = 0;
  let greekSpeakerRows = 0;
  let greekMappedCount = 0;
  for (let i = 0; i < greek.length; i++) {
    const gu = greek[i];
    let j = -1;
    if (gu.ref) j = trUnits.findIndex((t, k) => t.ref === gu.ref);
    if (j < 0 && i < trUnits.length) j = i;
    const raw = trUnits[j] as unknown as { _text?: string; words: string[] } | undefined;
    const txt = j >= 0 ? (raw?._text ?? raw?.words.join(" ") ?? "") : "";
    if (englishSpeakerFromText(txt)) highEnglishCount++;
    const gLabel = greekSpeakerByIdx.get(i);
    if (gLabel) {
      greekSpeakerRows++;
      const key = stripAccents(gLabel).toLowerCase();
      let mapped = GREEK_TO_EN.get(key) ?? (EN_KNOWN.has(gLabel) ? gLabel : null);
      if (!mapped && gLabel === "ΣΩ") mapped = "Socrates";
      if (!mapped && gLabel === "ΙΩΝ") mapped = "Ion";
      if (!mapped && gLabel === "ΚΡ") mapped = "Crito";
      if (mapped) greekMappedCount++;
    }
  }
  const mappingConfidence = greekSpeakerRows ? greekMappedCount / greekSpeakerRows : 1;
  const englishHighRatio = greek.length ? highEnglishCount / greek.length : 0;
  // Thresholds: mapping must be >=0.75 otherwise disable; also if English strict is the primary expected
  // but none found while Greek speakers abound, we still rely on Greek mapping (high mappingConfidence keeps colors).
  // Only disable when mapping is poor (inconsistent Crito case before fix).
  const COLOR_CONFIDENCE_THRESHOLD = 0.75;
  const disableTranslationColor = mappingConfidence < COLOR_CONFIDENCE_THRESHOLD;
  // Also expose for tests
  try {
    if (typeof window !== "undefined") {
      (window as unknown as Record<string, unknown>).__translationColorDisabled = disableTranslationColor;
      (window as unknown as Record<string, unknown>).__translationMappingConfidence = mappingConfidence;
      (window as unknown as Record<string, unknown>).__translationHighEnglishCount = highEnglishCount;
    }
  } catch {}

  const rows: El[] = [];
  const used = new Set<number>();
  for (let i = 0; i < greek.length; i++) {
    const gu = greek[i];
    let j = -1;
    if (gu.ref) {
      j = trUnits.findIndex((t, k) => t.ref === gu.ref && !used.has(k));
    }
    if (j < 0 && i < trUnits.length && !used.has(i)) j = i;
    const row = el("div", "tr-unit");
    const raw = trUnits[j] as unknown as { _text?: string; words: string[] };
    // preserve original casing — no toUpperCase
    const txt = j >= 0 ? (raw?._text ?? raw?.words.join(" ") ?? "—") : "—";
    // determine English speaker for coloring: prefer strict extraction from txt, fallback to Greek->English
    // Do not color inline mentions; only very start colon/verb or Greek first token.
    let engLabel: string | null = englishSpeakerFromText(txt);
    let engSource: "english" | "greek" | null = engLabel ? "english" : null;
    if (!engLabel) {
      const gLabel = greekSpeakerByIdx.get(i);
      if (gLabel) {
        const key = stripAccents(gLabel).toLowerCase();
        let mapped: string | null = GREEK_TO_EN.get(key) ?? (EN_KNOWN.has(gLabel) ? gLabel : null);
        if (!mapped && gLabel === "ΣΩ") mapped = "Socrates";
        if (!mapped && gLabel === "ΙΩΝ") mapped = "Ion";
        if (!mapped && gLabel === "ΚΡ") mapped = "Crito";
        // Also handle stripped Greek abbreviation already in map (κρ -> Crito, σω -> Socrates)
        if (mapped) {
          engLabel = mapped;
          engSource = "greek";
        }
      }
    }
    if (engLabel) {
      // If confidence low, render black (no spk- color) per spec
      if (disableTranslationColor) {
        const lbl = el("span", "tr-speaker", engLabel);
        // no spk- class, keep black; add data attribute for test to verify fallback-black path
        lbl.setAttribute("data-speaker-disabled", "true");
        (lbl as HTMLElement).title = `speaker: ${engLabel} (low confidence)`;
        row.appendChild(lbl);
        // do not add speaker color class to row
        row.setAttribute("data-speaker-fallback", engSource ?? "");
      } else {
        const color = hashColor(engLabel.toLowerCase());
        row.classList.add("speaker", `spk-${color}`);
        const lbl = el("span", "tr-speaker", engLabel);
        lbl.classList.add(`spk-${color}`);
        (lbl as HTMLElement).title = `speaker: ${engLabel}`;
        lbl.setAttribute("data-speaker-source", engSource ?? "");
        row.appendChild(lbl);
      }
    }
    const refTxt = gu.ref || trUnits[j]?.ref || "";
    if (refTxt) row.appendChild(el("span", "tr-ref", refTxt));
    row.appendChild(el("div", "tr-text", txt || "—"));
    if (j >= 0) used.add(j);
    body.appendChild(row);
    rows.push(row);
  }
  // leftover translation units with no Greek counterpart (rare)
  for (let k = 0; k < trUnits.length; k++) {
    if (used.has(k)) continue;
    const raw = trUnits[k] as unknown as { _text?: string; words: string[] };
    const txt = raw?._text ?? raw?.words.join(" ") ?? "";
    const row = el("div", "tr-unit");
    if (trUnits[k].ref) row.appendChild(el("span", "tr-ref", trUnits[k].ref));
    row.appendChild(el("div", "tr-text", txt || "—"));
    body.appendChild(row);
    rows.push(row);
  }

  // Scroll sync by REF MAPPING (not scroll ratio): find the Greek row whose
  // center is nearest the viewport focus line, then scroll the drawer so the
  // translation row with the SAME index is at the top of its viewport.
  // rows[] is built 1:1 with the greek units (leftover translation units are
  // appended after), so index mapping IS the ref mapping. Throttled to one
  // run per animation frame. Manual drawer scrolling pauses auto-sync
  // briefly so the reader never fights the user.
  if (scrollCleanup) {
    scrollCleanup();
    scrollCleanup = null;
  }
  let rafPending = 0;
  let drawerScrollUntil = 0; // timestamp: skip auto-sync while user scrolls drawer
  const FOCUS_Y = () => window.innerHeight * 0.42;

  const syncFromGreek = (): void => {
    rafPending = 0;
    if (!panel || panel.classList.contains("hidden")) return;
    if (!rows.length) return;
    // nearest Greek unit to the viewport focus line
    const greekRows = document.querySelectorAll(".line, .prose-unit");
    if (!greekRows.length) return;
    const fy = FOCUS_Y();
    let best = 0;
    let bestDist = Infinity;
    greekRows.forEach((r, i) => {
      const rc = (r as HTMLElement).getBoundingClientRect();
      if (rc.bottom < -80 || rc.top > window.innerHeight + 80) return; // far offscreen
      const c = rc.top + rc.height / 2;
      const d = Math.abs(c - fy);
      if (d < bestDist) { bestDist = d; best = i; }
    });
    const tr = rows[Math.min(best, rows.length - 1)];
    if (!tr) return;
    // Align the matched translation row's top with the focused Greek row's
    // viewport position (NOT the drawer top — that clipped the row half out
    // of view under the sticky header). Clamp inside the drawer box so the
    // first/last units never overshoot the scrollable range.
    const gTop = (greekRows[best] as HTMLElement).getBoundingClientRect().top;
    const dRect = panel.getBoundingClientRect();
    const headH =
      panel.querySelector<HTMLElement>(".tr-headbar")?.offsetHeight ?? 0;
    const trRect = tr.getBoundingClientRect();
    const minY = dRect.top + headH + 4;
    const maxY = Math.max(minY, dRect.bottom - trRect.height - 8);
    const wantY = Math.min(Math.max(gTop, minY), maxY);
    lastWrite = performance.now(); // mark echo so onDrawerScroll ignores it
    panel.scrollTop = Math.max(0, panel.scrollTop + (trRect.top - wantY));
    rows.forEach((r, i2) => r.classList.toggle("current", i2 === best));
  };
  const scheduleSync = (): void => {
    if (rafPending) return;
    rafPending = requestAnimationFrame(syncFromGreek);
  };
  let lastWrite = 0;
  const onWinScroll = (): void => {
    if (Date.now() < drawerScrollUntil) return; // user just scrolled the drawer
    scheduleSync();
  };
  const onDrawerScroll = (): void => {
    // ignore echoes of OUR programmatic writes; real user scrolling pauses
    // auto-sync briefly so the reader never fights the user
    if (performance.now() - lastWrite < 80) return;
    drawerScrollUntil = Date.now() + 1500;
  };
  window.addEventListener("scroll", onWinScroll, { passive: true });
  panel.addEventListener("scroll", onDrawerScroll, { passive: true });
  scheduleSync(); // highlight + align immediately on open, not just on scroll
  scrollCleanup = () => {
    window.removeEventListener("scroll", onWinScroll);
    panel!.removeEventListener("scroll", onDrawerScroll);
    if (rafPending) cancelAnimationFrame(rafPending);
    rafPending = 0;
  };

  panel.classList.remove("hidden");
  document.body.classList.add("translation-open");
  attachDrawerResize(panel, "right"); // shared 8px gutter (idempotent)
  // (__setDrawerWidth / __getDrawerWidth test hooks are installed by
  // initDrawerWidth() in src/drawer-resize.ts)

  // initial alignment once layout settles (fonts may still swap)
  requestAnimationFrame(() => requestAnimationFrame(scheduleSync));

  return {
    root: panel,
    toggle() {
      const nowHidden = panel!.classList.toggle("hidden");
      // toggle returns true if now contains hidden
      if (nowHidden) {
        document.body.classList.remove("translation-open");
        panel!.dispatchEvent(new CustomEvent("tr-closed", { bubbles: false }));
      } else {
        document.body.classList.add("translation-open");
        scheduleSync();
      }
    },
    isOpen: () => !panel!.classList.contains("hidden"),
  };
}
