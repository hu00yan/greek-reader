// Paste & Parse: client-side tokenization, then the shared interlinear
// renderer against the same static shards. Forms missing from the shipped
// index get a second chance via /api/morph (Cloudflare Pages Function
// proxying Tufts Morpheus); on static hosts that degrades to index-only
// results with a badge — rendering is never blocked on it.
import { fetchLiveParse, loadGloss, stripAccents, type Parse } from "./api";
import { prepare, renderLines, type RenderCtx } from "./render";

const MAX_CHARS = 50_000;
// Politeness cap: unique unresolved forms sent to the live service per run.
const LIVE_CAP = 100;
const CHUNK = 8;

// edge punctuation stripped from token ends — mirrors pipeline
// build_work.py PUNCT exactly; elision apostrophes are NOT edge-stripped:
// ’/ʼ/' are normalised to a plain apostrophe first and kept attached,
// like the Python tokenizer does.
const PUNCT = ",.;:·«»()[]‹›…—?!“”„‘’\"*_";

function trimEdges(w: string): string {
  let i = 0;
  let j = w.length;
  while (i < j && PUNCT.includes(w[i])) i += 1;
  while (j > i && PUNCT.includes(w[j - 1])) j -= 1;
  return w.slice(i, j);
}

export function tokenize(text: string): string[] {
  return text
    .replace(/[\u02bc\u2019]/g, "'") // elision apostrophes -> plain '
    .split(/\s+/)
    .map(trimEdges)
    .filter((w) => w.length > 0 && /[\u0370-\u03ff\u1f00-\u1fff]/.test(w));
}

// Live results are cached per accent-stripped form across runs; null means
// "analysed fine, form unknown" so we don't re-query. Transport failures set
// a sticky flag for the session: once the endpoint proves absent/down we
// stop hitting it and stay index-only.
const liveCache = new Map<string, Parse[] | null>();
let liveUnavailable = false;

interface AnalyzeStats {
  tokens: number;
  fromIndex: number;
  viaLive: number;
  unknown: number;
  capped?: boolean;
}

export function initPaste(root: HTMLElement, onBack: () => void): void {
  root.replaceChildren();

  const nav = document.createElement("button");
  nav.textContent = "← Home";
  nav.addEventListener("click", onBack);
  root.appendChild(nav);

  const h1 = document.createElement("h1");
  h1.textContent = "Paste & Parse";
  root.appendChild(h1);

  const p = document.createElement("p");
  p.className = "subtitle";
  p.textContent = "Paste Ancient Greek text; every token is analysed with " +
    "Morpheus and glossed with LSJ.";
  root.appendChild(p);

  const ta = document.createElement("textarea");
  ta.placeholder = "μῆνιν ἄειδε θεὰ Πηληϊάδεω Ἀχιλῆος…";
  ta.setAttribute("maxlength", String(MAX_CHARS));
  ta.setAttribute("aria-label", "Greek text to analyse");
  root.appendChild(ta);

  const toolbar = document.createElement("div");
  toolbar.className = "paste-toolbar";
  root.appendChild(toolbar);

  const btn = document.createElement("button");
  btn.className = "primary";
  btn.textContent = "Analyze";
  toolbar.appendChild(btn);

  const counter = document.createElement("span");
  counter.className = "char-counter";
  const updateCounter = () => {
    let v = ta.value;
    if (v.length > MAX_CHARS) {
      v = v.slice(0, MAX_CHARS);
      ta.value = v;
    }
    counter.textContent =
      `${v.length.toLocaleString()} / ${MAX_CHARS.toLocaleString()}`;
    counter.classList.toggle("over", v.length >= MAX_CHARS);
  };
  ta.addEventListener("input", updateCounter);
  updateCounter();
  toolbar.appendChild(counter);

  const progress = document.createElement("span");
  progress.className = "paste-progress";
  progress.setAttribute("aria-live", "polite");
  toolbar.appendChild(progress);

  const badge = document.createElement("p");
  badge.className = "live-badge";
  badge.hidden = true;
  badge.textContent =
    "live analysis unavailable offline — showing index results only";
  root.appendChild(badge);

  const note = document.createElement("p");
  note.className = "unparsed-note";
  note.setAttribute("aria-live", "polite");
  root.appendChild(note);

  const out = document.createElement("div");
  root.appendChild(out);

  async function analyze(): Promise<void> {
    const tokens = tokenize(ta.value);
    out.replaceChildren();
    note.textContent = "";
    if (tokens.length === 0) {
      note.textContent = "No Greek tokens found.";
      return;
    }
    btn.disabled = true;
    ta.disabled = true;
    try {
      // pass 1: static shards (same data as the reader)
      progress.textContent = "Loading index…";
      const ctx = await prepare([{ ref: "", words: tokens }]);

      // pass 2: live analyzer for forms the index doesn't know
      const stats: AnalyzeStats = {
        tokens: tokens.length,
        fromIndex: 0,
        viaLive: 0,
        unknown: 0,
      };
      const original = new Map<string, string>(); // stripped -> first form seen
      const unresolved = new Set<string>();
      for (const t of tokens) {
        const s = stripAccents(t);
        if ((ctx.morph.get(s) ?? []).length) continue; // counted in final pass
        unresolved.add(s);
        if (!original.has(s)) original.set(s, t);
      }

      if (unresolved.size && !liveUnavailable) {
        const queue = Array.from(unresolved).filter(
          (s) => !liveCache.has(s),
        ).slice(0, LIVE_CAP);
        if (unresolved.size > LIVE_CAP) stats.capped = true;
        let done = 0;
        for (let i = 0; i < queue.length; i += CHUNK) {
          progress.textContent =
            `Live analysis ${Math.min(done + CHUNK, queue.length)}` +
            `/${queue.length}…`;
          const chunk = queue.slice(i, i + CHUNK);
          const settled = await Promise.allSettled(
            chunk.map(async (s) => [s, await fetchLiveParse(original.get(s)!)] as const),
          );
          for (let j = 0; j < chunk.length; j++) {
            const r = settled[j];
            const s = chunk[j];
            done += 1;
            if (r.status === "fulfilled") {
              liveCache.set(s, r.value[1]);
              if (r.value[1].length) ctx.morph.set(s, r.value[1]);
            } else {
              // endpoint absent (static host) or down: degrade, don't retry
              liveUnavailable = true;
              badge.hidden = false;
              break;
            }
          }
          if (liveUnavailable) break;
        }
      }

      // fold cached live parses into the context and gloss their lemmas
      const newLemmas: string[] = [];
      for (const s of unresolved) {
        const cached = liveCache.get(s);
        if (!cached?.length) continue;
        if (!(ctx.morph.get(s) ?? []).length) ctx.morph.set(s, cached);
        for (const c of cached) newLemmas.push(c.l);
      }
      if (newLemmas.length) {
        try {
          const gloss = await loadGloss(newLemmas);
          for (const g of gloss.values()) ctx.gloss.set(stripAccents(g.u), g);
        } catch {
          // gloss shards failed to load; parse cards still render
        }
      }

      for (const t of tokens) {
        const s = stripAccents(t);
        if ((ctx.morph.get(s) ?? []).length) {
          if (liveCache.has(s) && liveCache.get(s)!.length) stats.viaLive += 1;
          else stats.fromIndex += 1;
        } else stats.unknown += 1;
      }
      ctx.unknown = new Set(
        Array.from(unresolved).filter(
          (s) => !(ctx.morph.get(s) ?? []).length,
        ),
      );

      renderLines(out, [{ ref: "", words: tokens }], ctx);
      note.textContent =
        `${stats.tokens} tokens · ${stats.fromIndex} parsed from index` +
        ` · ${stats.viaLive} via live service · ${stats.unknown} unknown` +
        (stats.capped ? ` · live lookups capped at ${LIVE_CAP} forms` : "");
    } catch (e) {
      note.textContent = `Analysis failed: ${(e as Error).message}`;
    } finally {
      progress.textContent = "";
      btn.disabled = false;
      ta.disabled = false;
    }
  }

  btn.addEventListener("click", () => void analyze());
  ta.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      if (!btn.disabled) void analyze();
    }
  });
}
