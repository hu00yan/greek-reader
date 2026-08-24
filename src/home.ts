// Home page: catalog of authors and works with a live search filter.
// Matching is a case- and accent-insensitive substring test over author
// names and work titles (stripAccents is the betacode-style normalizer
// shared with the morphology index). "/" focuses the search box.
import { loadCatalog, fetchJSON, stripAccents, type CatalogAuthor } from "./api";
import { fromBeta } from "./betacode";
import { lexiconButton } from "./lexicon";
import { themeControl } from "./theme";
import { aboutLink } from "./about";

const el = (tag: string, cls?: string, text?: string): HTMLElement => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text; // never innerHTML
  return e;
};

/** Defensive titleZh reader: catalog.json gains the field concurrently;
 *  absent / non-string / whitespace-only all yield "" → original title only. */
function zhTitleOf(w: unknown): string {
  const zh = (w as { titleZh?: unknown } | null)?.titleZh;
  return typeof zh === "string" ? zh.trim() : "";
}

export function renderHome(app: HTMLElement): void {
  app.replaceChildren();
  app.appendChild(el("h1", undefined, "Greek Reader"));
  app.appendChild(
    el("p", "subtitle",
      "An interlinear reading environment for Ancient Greek — Homer to " +
      "Plutarch, the New Testament and the Septuagint: morphology by " +
      "Morpheus, glosses from LSJ, all static JSON."),
  );

  // ---- prominent search box + header controls ----
  const searchWrap = el("div", "home-search");
  const input = el("input") as HTMLInputElement;
  input.type = "search";
  input.placeholder = "Search authors & works…";
  input.setAttribute("aria-label", "Filter catalog by author or work");
  input.autocomplete = "off";
  input.spellcheck = false;
  searchWrap.appendChild(input);
  searchWrap.appendChild(themeControl());
  searchWrap.appendChild(lexiconButton());
  // no visible "/" button here — the shortcut lives in the document
  // keydown listener below; a chip invited pointless clicking.
  app.appendChild(searchWrap);

  // ---- starter suggestions (routes verified against catalog.json) ----
  const startLink = (text: string, hash: string): HTMLAnchorElement => {
    const a = el("a", "starter-link", text) as HTMLAnchorElement;
    a.href = hash;
    return a;
  };
  const starters = el("p", "starters");
  starters.append("Not sure where to start? Try the ");
  starters.appendChild(startLink("Iliad", "#/tlg0012/iliad"));
  starters.append(", Xenophon’s ");
  starters.appendChild(startLink("Anabasis", "#/tlg0032/anabasis"));
  starters.append(", or Plato’s ");
  starters.appendChild(startLink("Symposium", "#/tlg0059/symposium"));
  starters.append(".");
  app.appendChild(starters);

  // "/" focuses search (until the home view is torn down)
  const onKey = (e: KeyboardEvent): void => {
    if (!input.isConnected) {
      document.removeEventListener("keydown", onKey);
      return;
    }
    if (e.key !== "/") return;
    const t = e.target as HTMLElement | null;
    const typing = t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" ||
      t.isContentEditable);
    if (!typing) {
      e.preventDefault();
      input.focus();
      input.select();
    }
  };
  document.addEventListener("keydown", onKey);

  // ---- result count ----
  const count = el("p", "search-count");
  count.setAttribute("aria-live", "polite");
  app.appendChild(count);

  // ---- paste card ----
  const cards = el("div", "cards");
  const pasteCard = el("a", "card") as HTMLAnchorElement;
  pasteCard.href = "#/paste";
  pasteCard.appendChild(el("div", "title", "Paste & Parse"));
  pasteCard.appendChild(
    el("div", "meta", "Analyse any Greek text you paste, on the fly."),
  );
  cards.appendChild(pasteCard);
  app.appendChild(cards);

  // footer: about / sources & licenses
  const footer = el("p", "about-footer");
  footer.appendChild(aboutLink());
  app.appendChild(footer);

  // ---- catalog ----
  let catalogAuthors: CatalogAuthor[] = [];
  loadCatalog().then((catalog) => {
    catalogAuthors = [...catalog.authors].sort((a, b) =>
      a.name.localeCompare(b.name));
    for (const author of catalogAuthors) app.appendChild(authorBlock(author));
    applyFilter();
  }).catch((e: Error) => {
    app.appendChild(el("p", "unparsed-note",
      `Could not load catalog.json: ${e.message}`));
  });

  /** One author section: heading + its work links. */
  function authorBlock(author: CatalogAuthor): HTMLElement {
    const block = el("section", "author-block");
    block.dataset.authorName = stripAccents(author.name);
    const head = el("h2", undefined, author.name);
    head.id = author.tlg;
    block.appendChild(head);
    const list = el("div", "work-list");
    for (const w of sortedWorks(author)) {
      const link = el("a", "work-link") as HTMLAnchorElement;
      link.href = `#/${author.tlg}/${w.id}`;
      link.dataset.title = stripAccents(w.title);
      // Bilingual card: titleZh (when the catalog ships it) is primary,
      // original title small + muted underneath; else original only.
      const zh = zhTitleOf(w);
      if (zh) {
        link.dataset.titleZh = zh; // raw zh — search filter target
        const titles = el("span", "work-titles");
        const zhEl = el("span", "work-title-zh", zh);
        zhEl.lang = "zh";
        titles.appendChild(zhEl);
        titles.appendChild(el("span", "work-title-orig", w.title));
        link.appendChild(titles);
      } else {
        link.appendChild(el("span", "work-title", w.title));
      }
      link.appendChild(el("span", "work-meta",
        `${w.unitCount.toLocaleString()} units`));
      link.title = w.license;
      list.appendChild(link);
    }
    block.appendChild(list);
    return block;
  }

  /** Natural sort so Iliad book parts / oration numbers read in order. */
  function sortedWorks(author: CatalogAuthor) {
    return [...author.works].sort((a, b) =>
      a.title.localeCompare(b.title, undefined, { numeric: true }));
  }

  /** Live filter: substring match on author name OR work title, plus a
   *  lazy full-text pass over the translation corpus (search-index.json,
   *  built by scripts/build-search-index.py). */
  function applyFilter(): void {
    const q = stripAccents(input.value.trim());
    let nAuthors = 0;
    let nWorks = 0;
    for (const block of Array.from(
      app.querySelectorAll<HTMLElement>(".author-block"),
    )) {
      const authorHit = !q || block.dataset.authorName!.includes(q);
      let shownInBlock = 0;
      for (const link of Array.from(
        block.querySelectorAll<HTMLAnchorElement>(".work-link"),
      )) {
        // match original title AND Chinese title (plain substring; zh needs
        // no accent folding, and the query is already lowercased)
        const hit = authorHit || !q ||
          link.dataset.title!.includes(q) ||
          (!!link.dataset.titleZh && link.dataset.titleZh.includes(q));
        link.hidden = !hit;
        if (hit) shownInBlock += 1;
      }
      block.hidden = shownInBlock === 0;
      if (!block.hidden) {
        nAuthors += 1;
        nWorks += shownInBlock;
      }
    }
    count.textContent = q
      ? `${nAuthors} author${nAuthors === 1 ? "" : "s"} · ` +
        `${nWorks} work${nWorks === 1 ? "" : "s"} matching “${input.value.trim()}”`
      : `${nAuthors} authors · ${nWorks} works`;
    void updateTextHits(q);
    void updateGrcHits(input.value);
  }

  let debounce = 0;
  input.addEventListener("input", () => {
    window.clearTimeout(debounce);
    debounce = window.setTimeout(applyFilter, 60);
  });

  // ---- full-text search over translations (lazy, build-time index) ----
  // Index shape (scripts/build-search-index.py):
  //   {v:1, w:["1-corinthians",...], e:[[widIdx,"10.1","snippet"], ...]}
  // Snippets are pre-normalized (lowercase, punctuation -> space), so the
  // query is normalized identically and substring-matched. Loaded ONCE on
  // the first qualifying search (query length > 3); filtering is a plain
  // array scan over ~40k snippets.
  interface SearchIndex {
    v: number;
    w: string[];
    e: Array<[number, string, string]>;
  }
  let idxPromise: Promise<SearchIndex | null> | null = null;
  let hitsToken = 0;
  const hits = el("div", "text-hits");
  hits.hidden = true;
  const catalogTitles = new Map<string, string>();
  const normEn = (s: string): string =>
    s
      .toLowerCase()
      .replace(/[^\p{L}\p{N}_\s]+/gu, " ")
      .replace(/\s+/g, " ")
      .trim();
  const workTlg = new Map<string, string>();
  loadCatalog().then((catalog) => {
    for (const author of catalog.authors) {
      for (const w of author.works) {
        workTlg.set(w.id, author.tlg);
        catalogTitles.set(w.id, w.title);
      }
    }
  }).catch(() => {});

  function ensureIndex(): Promise<SearchIndex | null> {
    if (!idxPromise) {
      idxPromise = fetchJSON<SearchIndex>("data/search-index.json").catch(
        () => null,
      );
    }
    return idxPromise;
  }

  /** Render up to 8 "In translations:" hits below the catalog matches. */
  async function updateTextHits(q: string): Promise<void> {
    const nq = normEn(q);
    if (nq.length <= 3) {
      hits.hidden = true;
      hits.replaceChildren();
      return;
    }
    const token = ++hitsToken;
    const idx = await ensureIndex();
    if (token !== hitsToken) return; // stale keystroke
    if (!idx) {
      app.appendChild(hits);
      hits.replaceChildren(
        el("p", "text-hits-note", "Text search unavailable."),
      );
      hits.hidden = false;
      return;
    }
    const found: Array<{ wid: string; ref: string; snip: string }> = [];
    let total = 0;
    for (const [wi, ref, sn] of idx.e) {
      const at = sn.indexOf(nq);
      if (at < 0) continue;
      total += 1;
      if (found.length < 8) {
        const wid = idx.w[wi];
        if (!workTlg.has(wid)) continue;
        found.push({ wid, ref, snip: window_(sn, at, nq.length) });
      }
    }
    hits.replaceChildren();
    if (!total) {
      hits.hidden = true;
      return;
    }
    const head = el("h3", "text-hits-head",
      `In translations: ${total.toLocaleString()} passage` +
      `${total === 1 ? "" : "s"} containing “${input.value.trim()}”`);
    head.title = "Full-text matches in translation corpus";
    hits.appendChild(head);
    const list = el("div", "text-hits-list");
    for (const f of found) {
      const tlg = workTlg.get(f.wid)!;
      const a = el("a", "text-hit") as HTMLAnchorElement;
      a.href = `#/${tlg}/${f.wid}`;
      const title = catalogTitles.get(f.wid) ?? f.wid;
      a.appendChild(el("span", "hit-title", title));
      a.appendChild(el("span", "hit-ref", ` ${f.ref}`));
      a.appendChild(el("span", "hit-snippet", f.snip));
      list.appendChild(a);
    }
    hits.appendChild(list);
    app.appendChild(hits); // force bottom-most position, below work matches
    hits.hidden = false;
  }
  /** ±60-char context window around the first match. */
  function window_(sn: string, at: number, len: number): string {
    const start = Math.max(0, at - 55);
    const end = Math.min(sn.length, at + len + 65);
    const body = sn.slice(start, end);
    return (start > 0 ? "…" : "") + body + (end < sn.length ? "…" : "");
  }

  // ---- Greek full-text WORK search (build-time inverted index) ----
  // Index (scripts/build_grc_index.py):
  //   {v,g:[tlg...],w:[workId...],e:{ "<norm>": [totalN, [[widIdx,"ref"]..]] }}
  // Keys are stripAccents-normalized with final sigma folded (ς→σ). Input may
  // be Unicode Greek OR betacode (lo/gos, qeo/s) — converted via fromBeta.
  interface GrcIndex {
    v: number;
    g: string[];
    w: string[];
    e: Record<string, [number, Array<[number, string]>]>;
  }
  let grcIdxPromise: Promise<GrcIndex | null> | null = null;
  let grcToken = 0;
  const grcHits = el("div", "text-hits grc-hits");
  grcHits.hidden = true;
  const GRC_RE = /[\u0370-\u03ff\u1f00-\uffff]/;
  // ascii letters adjacent to betacode diacritic markers (postfix / \ = | : ?
  // or prefix ( ) * capital marker)
  const BETACODE_MARK_RE = /[a-z][/\\=|:?]|[(*][a-z]/i;

  function ensureGrcIndex(): Promise<GrcIndex | null> {
    if (!grcIdxPromise) {
      grcIdxPromise = fetchJSON<GrcIndex>("data/search-index-grc.json").catch(
        () => null,
      );
    }
    return grcIdxPromise;
  }

  async function updateGrcHits(rawQ: string): Promise<void> {
    let q = rawQ.trim();
    if (!q) {
      grcHits.hidden = true;
      return;
    }
    if (!GRC_RE.test(q)) {
      // try betacode → unicode when ascii diacritic markers present
      if (BETACODE_MARK_RE.test(q)) {
        q = fromBeta(q);
      }
      if (!GRC_RE.test(q)) {
        grcHits.hidden = true;
        grcHits.replaceChildren();
        return;
      }
    }
    // stripAccents folds accents AND final sigma (λόγος → λογοσ)
    const nq = stripAccents(q);
    const token = ++grcToken;
    const idx = await ensureGrcIndex();
    if (token !== grcToken) return; // stale keystroke
    if (!idx) {
      app.appendChild(grcHits);
      grcHits.replaceChildren(
        el("p", "text-hits-note", "Greek text search unavailable."),
      );
      grcHits.hidden = false;
      return;
    }
    // exact match first, then final-sigma-stripped variant
    let hit = idx.e[nq];
    if (!hit && nq.endsWith("σ")) hit = idx.e[nq.slice(0, -1)];
    if (!hit) hit = idx.e[`${nq}σ`];
    grcHits.replaceChildren();
    app.appendChild(grcHits); // keep below the English "In translations" hits
    if (!hit || !hit[1].length) {
      grcHits.hidden = true;
      return;
    }
    const shown = Math.min(8, hit[1].length);
    const head = el("h3", "text-hits-head",
      `In Greek texts: ${hit[1].length.toLocaleString()} work${hit[1].length === 1 ? "" : "s"} containing “${rawQ.trim()}”`);
    head.title = `≈${hit[0].toLocaleString()} total occurrences`;
    grcHits.appendChild(head);
    const list = el("div", "text-hits-list");
    for (const [widIdx, ref] of hit[1].slice(0, shown)) {
      const wid = idx.w[widIdx];
      const tlg = workTlg.get(wid);
      if (!tlg) continue;
      const a = el("a", "text-hit grc-hit") as HTMLAnchorElement;
      a.href = `#/${tlg}/${wid}`;
      a.appendChild(el("span", "hit-title", catalogTitles.get(wid) ?? wid));
      a.appendChild(el("span", "hit-ref",
        ref ? ` — first seen at ${ref}` : ""));
      list.appendChild(a);
    }
    grcHits.appendChild(list);
    grcHits.hidden = false;
  }
}
