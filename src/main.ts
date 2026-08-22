// Hash router: '' → home (catalog), '#/<tlg>/<workId>' → reader,
// '#/paste' → paste & parse. Legacy '#/<workId>/<book>' routes redirect
// best-effort onto catalog ids.
import "./style.css";
import {
  loadCatalog, loadPart,
  type CatalogAuthor, type CatalogWork, type Unit,
} from "./api";
import {
  mergeCtx, prepare, renderControls, renderUnits, hidePanel,
  type RenderCtx,
} from "./render";
import { initPaste } from "./paste";

const app = document.getElementById("app") as HTMLElement;

const el = (tag: string, cls?: string, text?: string): HTMLElement => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

const TLG_RE = /^tlg\d{4}$/;
const BATCH_UNITS = 120; // units rendered per "Load more" step

function go(hash: string): void {
  hidePanel();
  const route = hash.replace(/^#\/?/, "");
  if (route === "paste") return initPaste(app, () => (location.hash = ""));
  const m = route.match(/^([^/]+)\/([^/]+)$/);
  if (m) {
    if (TLG_RE.test(m[1])) return void openReader(m[1], m[2]);
    return void redirectLegacy(m[1], m[2]);
  }
  void renderHome();
}

/* ---------------- home ---------------- */

async function renderHome(): Promise<void> {
  app.replaceChildren();
  app.appendChild(el("h1", undefined, "Greek Reader"));
  app.appendChild(
    el("p", "subtitle",
      "An interlinear reading environment for Ancient Greek — Homer to " +
      "Plutarch, the New Testament and the Septuagint: morphology by " +
      "Morpheus, glosses from LSJ, all static JSON."),
  );

  const cards = el("div", "cards");
  app.appendChild(cards);

  const pasteCard = el("a", "card") as HTMLAnchorElement;
  pasteCard.href = "#/paste";
  pasteCard.appendChild(el("div", "title", "Paste & Parse"));
  pasteCard.appendChild(
    el("div", "meta", "Analyse any Greek text you paste, on the fly."),
  );
  cards.appendChild(pasteCard);

  let catalog;
  try {
    catalog = await loadCatalog();
  } catch (e) {
    app.appendChild(el("p", "unparsed-note",
      `Could not load catalog.json: ${(e as Error).message}`));
    return;
  }

  const authors = [...catalog.authors].sort((a, b) =>
    a.name.localeCompare(b.name));
  for (const author of authors) {
    const block = el("section", "author-block");
    const head = el("h2", undefined, author.name);
    head.id = author.tlg;
    block.appendChild(head);
    const list = el("div", "work-list");
    for (const w of sortedWorks(author)) {
      const link = el("a", "work-link") as HTMLAnchorElement;
      link.href = `#/${author.tlg}/${w.id}`;
      const t = el("span", "work-title", w.title);
      link.appendChild(t);
      link.appendChild(el("span", "work-meta",
        `${w.unitCount.toLocaleString()} units`));
      link.title = w.license;
      list.appendChild(link);
    }
    block.appendChild(list);
    app.appendChild(block);
  }
}

/** Natural sort so Iliad book parts / oration numbers read in order. */
function sortedWorks(author: CatalogAuthor): CatalogWork[] {
  return [...author.works].sort((a, b) =>
    a.title.localeCompare(b.title, undefined, { numeric: true }));
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

interface ReaderState {
  work: CatalogWork;
  author: CatalogAuthor;
  queue: string[];       // part file paths not yet fetched
  buffer: Unit[];        // fetched but not yet rendered
  kind: "verse" | "prose";
  ctx: RenderCtx;
  body: HTMLElement;
  moreBtn: HTMLButtonElement;
  status: HTMLElement;
  renderedUnits: number;
}

async function openReader(tlg: string, workId: string): Promise<void> {
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

  app.replaceChildren(renderControls(`${author.name}, ${work.title}`,
    () => (location.hash = "")).root);

  const body = el("div");
  app.appendChild(body);

  const state: ReaderState = {
    work, author,
    queue: [...work.files],
    buffer: [],
    kind: "verse",
    ctx: { morph: new Map(), gloss: new Map() },
    body,
    moreBtn: el("button", "load-more", "Load more") as HTMLButtonElement,
    status: el("p", "reader-status"),
    renderedUnits: 0,
  };
  state.moreBtn.addEventListener("click", () => void loadMore(state));
  state.moreBtn.hidden = true;
  app.appendChild(state.status);
  app.appendChild(state.moreBtn);

  await loadMore(state);
}

async function loadMore(state: ReaderState): Promise<void> {
  const btn = state.moreBtn;
  btn.disabled = true;
  state.status.textContent = "Loading…";
  try {
    // top up the buffer from part files until we have a full batch
    while (state.buffer.length < BATCH_UNITS && state.queue.length) {
      const part = await loadPart(state.queue.shift()!);
      state.kind = state.kind === "prose" ? "prose"
        : part.kind === "prose" ? "prose" : state.kind;
      state.buffer.push(...part.units);
    }
    if (!state.buffer.length) {
      state.status.textContent =
        `${state.renderedUnits.toLocaleString()} units · end of text`;
      btn.hidden = true;
      return;
    }

    const batch = state.buffer.splice(0, BATCH_UNITS);
    const freshCtx = await prepare(batch);
    mergeCtx(state.ctx, freshCtx.morph, freshCtx.gloss);
    renderUnits(state.body, batch, state.ctx, state.kind);
    state.renderedUnits += batch.length;

    const total = state.work.unitCount;
    state.status.textContent =
      `${Math.min(state.renderedUnits, total).toLocaleString()} / ` +
      `${total.toLocaleString()} units`;
    btn.hidden = false;
    btn.textContent = `Load more (${state.work.files.length - state.queue.length}` +
      `/${state.work.files.length} files loaded)`;
  } catch (e) {
    state.status.textContent = `Load failed: ${(e as Error).message}`;
  } finally {
    btn.disabled = false;
  }
}

window.addEventListener("hashchange", () => go(location.hash));
go(location.hash);
