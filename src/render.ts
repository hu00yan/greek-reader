// Shared interlinear rendering: Greek units (verse lines or prose chunks)
// with per-word parse cards, controls bar, and the click-for-details panel.
import { loadGloss, loadMorph, stripAccents, type Gloss, type Parse, type Unit } from "./api";

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
  const parses = ctx.morph.get(stripAccents(word));
  if (!parses || parses.length === 0) {
    if (ctx.unknown?.has(stripAccents(word))) {
      // confirmed unknown after both index and live lookup
      col.appendChild(el("div", "pcard pcard-unknown", "—"));
    } else {
      col.appendChild(el("span", "noparse", "—"));
    }
    return col;
  }
  for (const p of parses.slice(0, 3)) col.appendChild(parseCard(p, ctx));
  if (parses.length > 3) {
    col.appendChild(
      el("span", "noparse", `+${parses.length - 3} more…`),
    );
  }
  return col;
}

function parseCard(p: Parse, ctx: RenderCtx): El {
  const card = el("div", "pcard");
  card.appendChild(el("span", "lemma", p.l || "?"));
  const feats = [p.p, p.f, p.x].filter(Boolean).join(" · ");
  card.appendChild(el("div", "feats", feats));
  const g = ctx.gloss.get(stripAccents(p.l));
  card.appendChild(el("div", "gloss", g ? g.g : ""));
  return card;
}

/** Render interlinear units into container.
 *  kind "verse": one row per unit — ref label, Greek line, cards beneath.
 *  kind "prose": ref badge + flowing paragraph of words, cards beneath. */
export function renderUnits(
  container: El,
  units: Unit[],
  ctx: RenderCtx,
  kind: "verse" | "prose" = "verse",
): void {
  for (const unit of units) {
    const row = el("div", kind === "prose" ? "unit prose-unit" : "line");
    if (kind === "prose") {
      const head = el("div", "prose-head");
      if (unit.ref) head.appendChild(el("span", "ref-badge", unit.ref));
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

    unit.words.forEach((w, i) => {
      const span = el("span", "w", w);
      span.addEventListener("click", () => openPanel(span, w, ctx));
      greek.appendChild(span);
      if (i < unit.words.length - 1) {
        greek.appendChild(document.createTextNode(" "));
      }
      parseRow.appendChild(parseCards(w, ctx));
    });

    row.appendChild(greek);
    row.appendChild(parseRow);
    container.appendChild(row);
  }
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
  minus.addEventListener("click", () => setGreekSize(greekSize() - 0.15));
  const plus = el("button", undefined, "A+");
  plus.addEventListener("click", () => setGreekSize(greekSize() + 0.15));
  bar.appendChild(minus);
  bar.appendChild(plus);

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

  p.classList.remove("hidden");
}
