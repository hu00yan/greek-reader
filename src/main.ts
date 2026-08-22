// Hash router: '' → home (catalog), '#/<tlg>/<workId>' → reader,
// '#/paste' → paste & parse. Legacy '#/<workId>/<book>' routes redirect
// best-effort onto catalog ids.
import "./style.css";
import {
  loadCatalog, loadPart,
  type CatalogAuthor, type CatalogWork, type Unit,
} from "./api";
import {
  genreFor, hidePanel, mergeCtx, prepare, renderControls, renderUnits,
  tallyLemmas, type RenderCtx,
} from "./render";
import { openTranslation } from "./translation";
import { lexiconButton } from "./lexicon";
import { initPaste } from "./paste";
import { renderAbout, aboutLink } from "./about";
import { initLLM } from "./llm-panel";
import { renderHome } from "./home";

const app = document.getElementById("app") as HTMLElement;

const el = (tag: string, cls?: string, text?: string): HTMLElement => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

const TLG_RE = /^tlg\d{4}$/;
const BATCH_UNITS = 120; // units fetched per part top-up (render pages are smaller)
const PAGE_SIZE = 30; // units rendered per page — keeps scroll manageable

function go(hash: string): void {
  hidePanel();
  const route = hash.replace(/^#\/?/, "");
  if (route === "paste") return initPaste(app, () => (location.hash = ""));
  if (route === "about") return renderAbout(app);
  const m = route.match(/^([^/]+)\/([^/]+)$/);
  if (m) {
    if (TLG_RE.test(m[1])) return void openReader(m[1], m[2]);
    return void redirectLegacy(m[1], m[2]);
  }
  void goHome();
}

/* ---------------- home ---------------- */

function goHome(): void {
  renderHome(app);
}

async function redirectLegacy(first: string, second: string): Promise<void> {
  // e.g. '#/iliad/1' → '#/tlg0012/iliad'; book number is dropped.
  try {
    const catalog = await loadCatalog();
    const want = first.toLowerCase();
    for (const author of catalog.authors) {
      const hit = author.works.find((w) => w.id.toLowerCase() === want);
      if (hit) {
        location.hash = `#/${author.tlg}/${hit.id}`;
        return;
      }
    }
  } catch {
    /* fall through to home */
  }
  void second;
  location.hash = "";
}

/* ---------------- reader ---------------- */

interface PageInfo {
  rows: number; // DOM rows appended for this page (1 per unit)
}
interface ReaderState {
  work: CatalogWork;
  author: CatalogAuthor;
  queue: string[];       // part file paths not yet fetched
  buffer: Unit[];        // fetched but not yet rendered
  kind: "verse" | "prose";
  ctx: RenderCtx;
  body: HTMLElement;
  pager: {
    root: HTMLElement;
    info: HTMLElement;
    prev: HTMLButtonElement;
    next: HTMLButtonElement;
    jump: HTMLInputElement;
  };
  pages: PageInfo[];     // rendered pages, in order
  busy: boolean;
  atEnd: boolean;
  renderedUnits: number;
}

const PAGE_UNITS = PAGE_SIZE;

function totalPages(state: ReaderState): number {
  return Math.max(1, Math.ceil(state.work.unitCount / PAGE_UNITS));
}

function updatePager(state: ReaderState): void {
  const p = state.pages.length;
  const start = p ? state.renderedUnits - state.pages[p - 1].rows + 1 : 0;
  const end = state.renderedUnits;
  const total = state.work.unitCount;
  state.pager.info.textContent =
    `Units ${start.toLocaleString()}–${end.toLocaleString()} of ` +
    `${total.toLocaleString()} · Page ${p} of ${totalPages(state)}`;
  state.pager.prev.disabled = state.busy || p <= 1;
  state.pager.next.disabled =
    state.busy || state.atEnd || end >= total;
}

async function openReader(tlg: string, workId: string): Promise<void> {
  allUnits = [];
  app.replaceChildren();
  app.appendChild(el("p", "crumbs", "Loading…"));

  let author: CatalogAuthor | undefined;
  let work: CatalogWork | undefined;
  try {
    const catalog = await loadCatalog();
    author = catalog.authors.find((a) => a.tlg === tlg);
    work = author?.works.find((w) => w.id === workId);
  } catch (e) {
    app.replaceChildren(el("p", "unparsed-note",
      `Failed to load catalog: ${(e as Error).message}`));
    return;
  }
  if (!author || !work) {
    app.replaceChildren(el("p", "unparsed-note",
      `Unknown work ${tlg}/${workId}.`));
    return;
  }

  const controls = renderControls(`${author.name}, ${work.title}`,
    () => (location.hash = ""));
  app.replaceChildren(controls.root);

  // translation toggle only when the catalog ships translations
  if ((work as { translation?: { files?: string[] } }).translation
    ?.files?.length) {
    let trView: Awaited<ReturnType<typeof openTranslation>> = null;
    const trBtn = el("button", undefined, "English ▭") as HTMLButtonElement;
    trBtn.type = "button";
    trBtn.setAttribute("aria-pressed", "false");
    trBtn.addEventListener("click", async () => {
      if (!trView) {
        trView = await openTranslation(work!, () => allUnits);
        if (!trView) return;
      }
      trView.toggle();
      trBtn.setAttribute("aria-pressed", String(trView.isOpen()));
    });
    controls.root.appendChild(trBtn);
  }

  const body = el("div");
  app.appendChild(body);

  // pager footer replaces the bare Load-more button
  const info = el("span", "pager-info");
  const prev = el("button", undefined, "← Prev") as HTMLButtonElement;
  const next = el("button", undefined, "Next →") as HTMLButtonElement;
  prev.type = next.type = "button";
  const jump = el("input") as HTMLInputElement;
  jump.type = "number";
  jump.min = "1";
  jump.setAttribute("aria-label", "Jump to page");
  const pagerRoot = el("div", "pager");
  pagerRoot.appendChild(info);
  pagerRoot.appendChild(prev);
  pagerRoot.appendChild(next);
  pagerRoot.appendChild(jump);

  const state: ReaderState = {
    work, author,
    queue: [...work.files],
    buffer: [],
    kind: "verse",
    ctx: { morph: new Map(), gloss: new Map(), genre: genreFor(author.tlg) },
    body,
    pager: { root: pagerRoot, info, prev, next, jump },
    pages: [],
    busy: false,
    atEnd: false,
    renderedUnits: 0,
  };
  prev.addEventListener("click", () => void turnPage(state, -1));
  next.addEventListener("click", () => void turnPage(state, +1));
  jump.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    const target = Math.min(totalPages(state),
      Math.max(1, parseInt(jump.value || "1", 10) || 1));
    jump.value = String(target);
    void turnPage(state, target - state.pages.length);
  });

  await loadNextPage(state);
  app.appendChild(pagerRoot);
  updatePager(state);
}

/** All Greek units currently on screen (translation alignment source). */
let allUnits: Unit[] = [];

/** Render exactly one more page (fetching as needed). */
async function loadNextPage(state: ReaderState): Promise<void> {
  try {
    while (state.buffer.length < PAGE_UNITS && state.queue.length) {
      const part = await loadPart(state.queue.shift()!);
      state.kind = state.kind === "prose" ? "prose"
        : part.kind === "prose" ? "prose" : state.kind;
      state.buffer.push(...part.units);
    }
    if (!state.buffer.length) {
      state.atEnd = true;
      return;
    }
    const batch = state.buffer.splice(0, PAGE_UNITS);
    const freshCtx = await prepare(batch);
    mergeCtx(state.ctx, freshCtx.morph, freshCtx.gloss);
    tallyLemmas(state.ctx, batch); // grow the work-view frequency signal
    renderUnits(state.body, batch, state.ctx, state.kind,
      state.renderedUnits);
    allUnits.push(...batch);
    state.pages.push({ rows: batch.length });
    state.renderedUnits += batch.length;
  } catch (e) {
    state.pager.info.textContent = `Load failed: ${(e as Error).message}`;
    state.atEnd = true;
  }
}

/** Remove the last rendered page from screen and memory. */
function popPage(state: ReaderState): void {
  const last = state.pages.pop();
  if (!last) return;
  for (let i = 0; i < last.rows; i++) {
    state.body.lastElementChild?.remove();
  }
  allUnits.length -= last.rows;
  state.renderedUnits -= last.rows;
}

/** Page turning: delta ±1 steps or a positive jump target. */
async function turnPage(
  state: ReaderState,
  delta: number,
): Promise<void> {
  if (state.busy || !delta) return;
  const cur = state.pages.length;
  const target = Math.max(1,
    Math.min(totalPages(state), cur + delta));
  if (target === cur) return;
  state.busy = true;
  updatePager(state);
  try {
    if (delta > 0) {
      while (state.pages.length < target && !state.atEnd) {
        await loadNextPage(state);
      }
    } else {
      while (state.pages.length > target && state.pages.length > 1) {
        popPage(state);
      }
    }
    window.scrollTo({ top: 0 });
  } finally {
    state.busy = false;
    updatePager(state);
  }
}

window.addEventListener("hashchange", () => go(location.hash));
initLLM(); // gear button + AI assist hooks (see llm-panel.ts)
// floating Lexicon trigger: guarantees the drawer on every route,
// including paste (whose page module is not owned by the UI round)
const lexFab = lexiconButton("Lexicon");
lexFab.className = "lex-fab";
document.body.appendChild(lexFab);
go(location.hash);
