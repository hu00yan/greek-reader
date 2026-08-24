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
  setProsodyWorkId, tallyLemmas, type RenderCtx,
} from "./render";
import { createProsodyToggle, loadProsody } from "./prosody";
import { openTranslation } from "./translation";
import { attachDrawerResize, initDrawerWidth } from "./drawer-resize";
import { lexiconButton } from "./lexicon";
import { initPaste } from "./paste";
import { renderAbout, aboutLink } from "./about";
import { initLLM } from "./llm-panel";
import { initPWA } from "./pwa";
import { renderHome } from "./home";
import {
  continueReadingSection, getFocusedRef, getRecent, saveRecent,
  setFocusedRef, setUnitContext,
} from "./bookmarks";

const app = document.getElementById("app") as HTMLElement;

// -- drawer resize: shared implementation in src/drawer-resize.ts ---------------
// Both drawers (lexicon left / translation right) share ONE --drawer-width var
// and ONE pointer-event drag implementation (consolidated; previously two
// drifting copies lived here and in translation.ts).
initDrawerWidth();
// Watch for drawer creation (lexicon creates lazily) and attach handles
const drawerObserver = new MutationObserver(() => {
  const left = document.querySelector(".drawer.left") as HTMLElement | null;
  if (left) attachDrawerResize(left, "left");
  const right = document.getElementById("tr-drawer") as HTMLElement | null;
  if (right) attachDrawerResize(right, "right");
});
drawerObserver.observe(document.body, { childList: true, subtree: true });
// also periodically check (fallback for race)
setInterval(() => {
  const left = document.querySelector(".drawer.left") as HTMLElement | null;
  if (left && !left.querySelector(".resize-handle")) attachDrawerResize(left, "left");
  const right = document.getElementById("tr-drawer") as HTMLElement | null;
  if (right && !right.querySelector(".resize-handle")) attachDrawerResize(right, "right");
}, 1000);

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
  // clear prosody work context when leaving reader
  if (!hash.match(/^#\/tlg\d{4}\//)) setProsodyWorkId(null);
  const route = hash.replace(/^#\/?/, "");
  if (route === "paste") return initPaste(app, () => (location.hash = ""));
  if (route === "about") return renderAbout(app);
  setUnitContext(null, null); // star/copy buttons only make sense in a reader
  // deep links carry an optional ?ref= query: '#/tlg0059/ion?ref=1.42'
  const [routePart, queryPart] = route.split("?");
  let refParam: string | undefined;
  if (queryPart) {
    refParam =
      new URLSearchParams(queryPart).get("ref") ?? undefined;
  }
  const m = routePart.match(/^([^/]+)\/([^/]+)$/);
  if (m) {
    if (TLG_RE.test(m[1])) return void openReader(m[1], m[2], refParam);
    return void redirectLegacy(m[1], m[2]);
  }
  void goHome();
}

/* ---------------- home ---------------- */

function goHome(): void {
  renderHome(app);
  // "Continue reading" above the starter suggestions (home.ts not touched)
  const titles = new Map<string, string>();
  const sec = continueReadingSection(titles);
  if (!sec.hidden) {
    app.querySelector(".starters")?.before(sec);
    void loadCatalog().then((catalog) => {
      for (const author of catalog.authors) {
        for (const w of author.works) titles.set(w.id, w.title);
      }
      sec.replaceWith(continueReadingSection(titles));
    }).catch(() => {});
  }
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

async function openReader(
  tlg: string,
  workId: string,
  refParam?: string,
): Promise<void> {
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
  // readerState is assigned below; closure captures live reference for speaker parity
  let readerState: ReaderState | null = null;
  if ((work as { translation?: { files?: string[] } }).translation
    ?.files?.length) {
    let trView: Awaited<ReturnType<typeof openTranslation>> = null;
    const trBtn = el("button", "tr-toggle", "English ▭") as HTMLButtonElement;
    trBtn.type = "button";
    trBtn.title = "Toggle the English translation drawer";
    trBtn.setAttribute("aria-pressed", "false");
    trBtn.addEventListener("click", async () => {
      if (!trView) {
        trView = await openTranslation(work!, () => allUnits, readerState?.ctx);
        if (!trView) return;
        // keep the toggle honest no matter HOW the drawer closes
        // (Esc / outside click / sticky close all dispatch "tr-closed")
        trView.root.addEventListener("tr-closed", () => {
          trBtn.setAttribute("aria-pressed", "false");
        });
        trBtn.setAttribute("aria-pressed", String(trView.isOpen()));
        return;
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
  jump.placeholder = "Page";
  jump.setAttribute("aria-label", "Jump to page");
  const pagerRoot = el("div", "pager");
  pagerRoot.appendChild(info);
  // prev / jump / next share one joined control cluster (see .pager-group)
  const group = el("span", "pager-group");
  group.appendChild(prev);
  group.appendChild(jump);
  group.appendChild(next);
  pagerRoot.appendChild(group);

  const state: ReaderState = {
    work, author,
    queue: [...work.files],
    buffer: [],
    kind: "verse",
    ctx: { morph: new Map(), gloss: new Map(), genre: genreFor(author.tlg),
      tlg: author.tlg },
    body,
    pager: { root: pagerRoot, info, prev, next, jump },
    pages: [],
    busy: false,
    atEnd: false,
    renderedUnits: 0,
  };
  readerState = state;
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

  // Bug fix (round): context must exist BEFORE the first render so ★/⧉
  // buttons appear on page 1 without needing ?ref=
  setUnitContext(tlg, workId);

  await loadNextPage(state);
  app.appendChild(pagerRoot);
  updatePager(state);

  // resume: honor an explicit ?ref= deep link by paging forward to it
  if (refParam) {
    await jumpToRef(state, refParam);
  }
  // record position immediately from the CURRENT focused unit (jump target
  // when ?ref= was given, else the top of the rendered page), so
  // "Continue reading" never points at page[0] until the first scroll.
  const focusRef =
    getFocusedRef() ??
    state.body.querySelector<HTMLElement>("[data-ref]")?.dataset.ref ??
    null;
  setFocusedRef(focusRef);
  if (focusRef) saveRecent(tlg, workId, focusRef);

  // track reading position on scroll (debounced; topmost visible unit wins)
  let saveTimer = 0;
  const onScrollSave = (): void => {
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => {
      if (!location.hash.startsWith(`#/${tlg}/${workId}`)) return;
      const rows = state.body.querySelectorAll<HTMLElement>("[data-ref]");
      for (const r of Array.from(rows)) {
        if (r.getBoundingClientRect().bottom < 0) continue;
        setFocusedRef(r.dataset.ref!);
        saveRecent(tlg, workId, r.dataset.ref!);
        break;
      }
    }, 900);
  };
  window.addEventListener("scroll", onScrollSave, { passive: true });

  // prosody: scansion toggle for verse works only
  if (state.kind === "verse") {
    const prosodyKey = `${tlg}--${workId}`;
    setProsodyWorkId(prosodyKey);
    // eagerly load; button added only if data exists (i.e. confidence>0.85)
    const prosodyMap = await loadProsody(workId, tlg);
    if (prosodyMap && prosodyMap.size) {
      const btn = createProsodyToggle(workId, tlg);
      controls.root.appendChild(btn);
    }
  } else {
    setProsodyWorkId(null);
  }
}

/** All Greek units currently on screen (translation alignment source). */
let allUnits: Unit[] = [];

/** Page forward until the unit with this ref is rendered, then center it.
 *  Capped at ~40 pages (1200 units) so a bogus ref cannot load a whole work. */
async function jumpToRef(
  state: ReaderState,
  ref: string,
): Promise<void> {
  const find = (): HTMLElement | null =>
    state.body.querySelector<HTMLElement>(
      `[data-ref="${CSS.escape(ref)}"]`,
    );
  let target = find();
  let guard = 0;
  while (!target && !state.atEnd && guard < 40) {
    await loadNextPage(state);
    updatePager(state);
    target = find();
    guard += 1;
  }
  if (!target) return;
  setFocusedRef(ref);
  target.scrollIntoView({ block: "center" });
  target.classList.add("ref-flash");
  window.setTimeout(() => target!.classList.remove("ref-flash"), 2400);
}

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
initPWA(); // service worker + offline badge (see pwa.ts)
// floating Lexicon trigger: guarantees the drawer on every route,
// including paste (whose page module is not owned by the UI round)
const lexFab = lexiconButton("Lexicon");
lexFab.className = "lex-fab";
document.body.appendChild(lexFab);
go(location.hash);
