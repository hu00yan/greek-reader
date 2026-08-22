// Lexicon drawer: one search box resolving ANY Greek input.
// Two lookup paths, results merged:
//   1. morph shards (accent-stripped form -> candidate lemma cards + glosses)
//   2. direct LSJ headword prefix scan over the gloss shard of the query's
//      first letter.
// Beta Code input is detected by TLG markers (* ) ( ) / \ = | +) and
// converted via fromBeta before lookup; raw input is always tried too.
// Keyboard: Enter focuses first result; ArrowUp/Down navigate; Esc closes.
import { fromBeta } from "./betacode";
import { fetchJSON, loadMorph, loadGloss, stripAccents,
  type Gloss, type Parse } from "./api";

type El = HTMLElement;
const el = (tag: string, cls?: string, text?: string): El => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text; // never innerHTML
  return e;
};

// TLG Beta Code markers; also plain digits-as-homonym style like "o9eos"
const BETA_RE = /[*()\\\/+=|\d]/;

let drawer: El | null = null;
let input: HTMLInputElement | null = null;
let hint: El | null = null;
let results: El | null = null;
let searchSeq = 0;

function ensureDrawer(): El {
  if (drawer) return drawer;
  drawer = el("aside", "drawer left hidden");
  drawer.setAttribute("aria-label", "Lexicon");

  const close = el("button", "close-btn", "×");
  close.setAttribute("aria-label", "Close lexicon");
  close.addEventListener("click", closeLexicon);
  drawer.appendChild(close);

  drawer.appendChild(el("h2", undefined, "Lexicon"));

  input = el("input", "lex-search") as HTMLInputElement;
  input.type = "search";  input.placeholder = "Greek or Beta Code — λόγος or lo/gos";
  input.setAttribute("aria-label", "Lexicon search");
  input.autocomplete = "off";
  input.spellcheck = false;
  drawer.appendChild(input);

  hint = el("p", "lex-beta-hint");
  hint.setAttribute("aria-live", "polite");
  drawer.appendChild(hint);

  results = el("div", "lex-results");
  drawer.appendChild(results);

  input.addEventListener("input", () => void runSearch());
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      focusResult(0);
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      moveFocus(e.key === "ArrowDown" ? 1 : -1);
    }
  });
  document.body.appendChild(drawer);
  return drawer;
}

export function openLexicon(prefill?: string): void {
  const d = ensureDrawer();
  d.classList.remove("hidden");
  if (prefill && input) {
    input.value = prefill;
  }
  if (input) {
    void runSearch();
    input.focus();
    input.select();
  }
}

export function closeLexicon(): void {
  drawer?.classList.add("hidden");
}

export function toggleLexicon(): void {
  if (!drawer || drawer.classList.contains("hidden")) openLexicon();
  else closeLexicon();
}

export function lexiconButton(label = "Lexicon"): El {
  const b = el("button", undefined, label) as HTMLButtonElement;
  b.type = "button";
  b.addEventListener("click", () => toggleLexicon());
  return b;
}

/* ---------------- lookups ---------------- */

interface LemmaHit {
  lemma: string;       // Unicode lemma as stored
  parses: Parse[];
  gloss?: Gloss;
  src: "morph" | "lsj";
}

async function runSearch(): Promise<void> {
  const d = ensureDrawer();
  const raw = input?.value ?? "";
  const q = raw.trim();
  const seq = ++searchSeq;
  results!.replaceChildren();

  // beta-code conversion (raw input is always tried as well)
  let converted: string | null = null;
  if (q && BETA_RE.test(q)) {
    try {
      const u = fromBeta(q);
      if (u !== q) converted = u;
    } catch { /* fall back to raw only */ }
  }
  hint!.textContent =
    converted !== null ? "β-code detected" : "";

  if (!q) {
    results!.appendChild(
      el("p", "lex-hint-empty",
        "Type a Greek form (exact or accent-less) or an LSJ headword prefix."),
    );
    return;
  }

  const queries = Array.from(new Set(
    [converted, q].filter((x): x is string => !!x),
  ));
  const hits = await Promise.all(queries.map(lookupAll));
  if (seq !== searchSeq) return; // stale keystroke
  const seen = new Set<string>();
  let shown = 0;
  for (const list of hits) {
    for (const h of list) {
      const k = `${stripAccents(h.lemma)}|${h.src}`;
      if (seen.has(k)) continue;
      seen.add(k);
      results!.appendChild(hitCard(h));
      shown += 1;
      if (shown >= 40) break;
    }
    if (shown >= 40) break;
  }
  if (!shown) {
    results!.appendChild(
      el("p", "lex-hint-empty",
        `No matches for “${converted ?? q}”.`),
    );
  }
  void d;
}

/** Morph-form lookup + LSJ headword prefix for one query string. */
async function lookupAll(q: string): Promise<LemmaHit[]> {
  const out: LemmaHit[] = [];
  const stripped = stripAccents(q);
  try {
    const morph = await loadMorph([q]);
    const parses = morph.get(stripped) ?? [];
    if (parses.length) {
      const lemmas = Array.from(new Set(parses.map((p) => p.l)));
      const glosses = await loadGloss(lemmas).catch(() =>
        new Map<string, Gloss>());
      for (const l of lemmas) {
        out.push({
          lemma: l,
          parses: parses.filter((p) => p.l === l),
          gloss: glosses.get(stripAccents(l)),
          src: "morph",
        });
      }
    }
  } catch { /* shards missing — LSJ path may still answer */ }

  // LSJ headword prefix over the first-letter shard
  const letter = /^[a-z]$/.test(firstBetaLetter(stripped))
    ? firstBetaLetter(stripped)
    : null;
  if (letter) {
    const shard = await fetchJSON<Record<string, Gloss>>(
      `data/gloss/${letter}.json`,
    ).catch(() => null);
    if (shard) {
      const keys = Object.keys(shard)
        .filter((k) => k.startsWith(stripped))
        .sort()
        .slice(0, 25);
      for (const k of keys) {
        const g = shard[k];
        out.push({
          lemma: g?.u ?? k,
          parses: [],
          gloss: g,
          src: "lsj",
        });
      }
    }
  }
  return out;
}

function firstBetaLetter(s: string): string {
  const BETA: Record<string, string> = {
    α: "a", β: "b", γ: "g", δ: "d", ε: "e", ζ: "z", η: "h", θ: "q",
    ι: "i", κ: "k", λ: "l", μ: "m", ν: "n", ξ: "c", ο: "o", π: "p",
    ρ: "r", σ: "s", τ: "t", υ: "u", φ: "f", χ: "x", ψ: "y", ω: "w",
  };
  for (const ch of s.replace(/ς/g, "σ")) {
    const b = BETA[ch];
    if (b) return b;
  }
  return "";
}

function hitCard(h: LemmaHit): El {
  const card = el("button", "lex-card") as HTMLButtonElement;
  card.type = "button";
  card.appendChild(el("span", "lex-src",
    h.src === "morph" ? "form" : "LSJ"));
  const head = el("div");
  head.appendChild(el("span", "lemma", h.lemma || "?"));
  card.appendChild(head);
  if (h.parses.length) {
    card.appendChild(el("div", "feats",
      h.parses.slice(0, 2)
        .map((p) => [p.p, p.f].filter(Boolean).join(" "))
        .filter(Boolean)
        .join(" | ")));
  }
  if (h.gloss) card.appendChild(el("div", "gloss", h.gloss.g));
  return card;
}

/* ---------------- keyboard navigation ---------------- */

function resultCards(): HTMLElement[] {
  return Array.from(
    results?.querySelectorAll<HTMLElement>(".lex-card") ?? [],
  );
}

function focusResult(i: number): void {
  const cards = resultCards();
  cards[i]?.focus();
}

function moveFocus(delta: number): void {
  const cards = resultCards();
  const cur = cards.indexOf(document.activeElement as HTMLElement);
  const next = cur < 0 ? 0 : Math.min(cards.length - 1,
    Math.max(0, cur + delta));
  cards[next]?.focus();
}
