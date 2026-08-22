// Hash router: '' → home, '#/<work>/<book>' → reader, '#/paste' → paste.
import "./style.css";
import { fetchJSON, type Work } from "./api";
import { prepare, renderControls, renderLines, hidePanel, type RenderCtx } from "./render";
import { initPaste } from "./paste";

const app = document.getElementById("app") as HTMLElement;

const el = (tag: string, cls?: string, text?: string): HTMLElement => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

function go(hash: string): void {
  hidePanel();
  const route = hash.replace(/^#\/?/, "");
  if (route === "paste") return renderHomeChromeless(() => initPaste(app, () => location.hash = ""));
  const m = route.match(/^([^/]+)\/([^/]+)$/);
  if (m) return void openReader(m[1], m[2]);
  renderHome();
}

/* ---------------- home ---------------- */

async function renderHome(): Promise<void> {
  app.replaceChildren();
  app.appendChild(el("h1", undefined, "Greek Reader"));
  app.appendChild(
    el("p", "subtitle",
      "An interlinear reading environment for Ancient Greek: morphology by " +
      "Morpheus, glosses from LSJ — all static JSON, no backend."),
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

  try {
    const works = await fetchJSON<Work[]>("data/works.json");
    for (const w of works) {
      const card = el("a", "card") as HTMLAnchorElement;
      card.href = `#/${w.id}/${w.n}`;
      const t = el("div", "title");
      t.textContent = `${w.author}, ${w.title} ${w.n}`;
      card.appendChild(t);
      card.appendChild(
        el("div", "meta", `${w.lines.length} lines · click to read with interlinear glosses`),
      );
      cards.insertBefore(card, pasteCard);
    }
  } catch (e) {
    const warn = el("p", "unparsed-note");
    warn.textContent = `Could not load work list: ${(e as Error).message}`;
    app.appendChild(warn);
  }
}

function renderHomeChromeless(show: () => void): void {
  show();
}

/* ---------------- reader ---------------- */

async function openReader(workId: string, bookN: string): Promise<void> {
  app.replaceChildren();
  app.appendChild(el("p", "crumbs", `Loading ${workId} ${bookN}…`));
  let work: Work;
  try {
    work = await fetchJSON<Work>(`data/${workId}.${bookN}.json`);
  } catch (e) {
    app.replaceChildren(
      el("p", "unparsed-note", `Failed to load: ${(e as Error).message}`),
    );
    return;
  }

  app.replaceChildren(renderControls(
    `${work.author}, ${work.title} ${work.n}`,
    () => (location.hash = ""),
  ).root);

  const body = el("div");
  app.appendChild(body);

  const ctxPromise = prepare(work.lines);
  // draw the bare text immediately, then attach parse columns
  const ctx = await ctxPromise;
  renderLines(body, work.lines, ctx);
}

window.addEventListener("hashchange", () => go(location.hash));
go(location.hash);
