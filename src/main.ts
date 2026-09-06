// Hash routes own their asynchronous work. Only the current route may paint.
import "./style.css";
import { loadCatalog, loadPart, type CatalogWork, type Unit } from "./api";
import { genreFor, hidePanel, mergeCtx, prepare, renderControls, renderUnits,
  setProsodyWorkId, tallyLemmas, type RenderCtx } from "./render";
import { createProsodyToggle, loadProsody } from "./prosody";
import { closeTranslation, openTranslation } from "./translation";
import { initDrawerWidth } from "./drawer-resize";
import { closeLexicon, lexiconButton } from "./lexicon";
import { initPaste } from "./paste";
import { renderAbout } from "./about";
import { initLLM } from "./llm-panel";
import { initPWA } from "./pwa";
import { renderHome } from "./home";
import { continueReadingSection, saveRecent, setFocusedRef, setUnitContext } from "./bookmarks";
import { stopTTS } from "./tts";

const app = document.getElementById("app")!;
const PAGE_SIZE = 30;
let routeVersion = 0;
let cleanup = (): void => {};
initDrawerWidth();

function node<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text = ""): HTMLElementTagNameMap[K] {
  const item = document.createElement(tag);
  item.className = cls;
  item.textContent = text;
  return item;
}

function showError(message: string): void {
  const note = node("p", "reader-error", message);
  note.setAttribute("role", "alert");
  const retry = node("button", "", "Retry");
  retry.onclick = () => void go();
  const home = node("a", "", "Back to catalog");
  home.href = "#/";
  app.replaceChildren(note, retry, home);
}

async function go(): Promise<void> {
  const version = ++routeVersion;
  cleanup();
  cleanup = () => {};
  stopTTS();
  hidePanel();
  closeTranslation();
  closeLexicon();
  setProsodyWorkId(null);
  setUnitContext(null, null);
  document.querySelector(".star-panel")?.remove();
  // Preserve shared chrome before replacing a reader that contains it.
  const gear = document.getElementById("ai-gear-wrap");
  if (gear) document.body.appendChild(gear);
  window.scrollTo(0, 0);
  document.title = "Greek Reader";
  const [route, query] = location.hash.replace(/^#\/?/, "").split("?");
  const current = () => version === routeVersion;
  if (route === "paste") { initPaste(app, () => { location.hash = "#/"; }); return; }
  if (route === "about") { renderAbout(app); return; }
  if (!route) {
    renderHome(app);
    const titles = new Map<string, string>();
    const sec = continueReadingSection(titles);
    if (!sec.hidden) app.querySelector(".starters")?.before(sec);
    void loadCatalog().then((catalog) => {
      if (!current()) return;
      for (const author of catalog.authors) for (const work of author.works)
        titles.set(`${author.tlg}/${work.id}`,
          work.titleZh ? `${work.title} · ${work.titleZh}` : work.title);
      sec.replaceWith(continueReadingSection(titles));
    }).catch(() => {});
    return;
  }
  app.replaceChildren(node("p", "reader-status", "Loading text…"));
  try {
    const catalog = await loadCatalog();
    if (!current()) return;
    const [tlg, id] = route.split("/");
    if (!/^tlg\d{4}$/.test(tlg)) {
      const author = catalog.authors.find((a) => a.works.some((w) => w.id === tlg));
      if (author) { location.hash = `#/${author.tlg}/${tlg}`; return; }
    }
    const author = catalog.authors.find((a) => a.tlg === tlg);
    const work = author?.works.find((w) => w.id === id);
    if (!author || !work) { showError("This work could not be found. Check the link or return to the catalog."); return; }
    document.title = `${work.title} · ${author.name} — Greek Reader`;
    setUnitContext(tlg, id);
    await reader(work, author.name, tlg, new URLSearchParams(query).get("ref"), current);
  } catch (error) {
    if (current()) showError(`Could not load this text: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function reader(work: CatalogWork, author: string, tlg: string, ref: string | null, current: () => boolean): Promise<void> {
  const controls = renderControls(`${author}, ${work.title}`, () => { location.hash = "#/"; });
  const heading = node("h1", "reader-title", work.titleZh || work.title);
  const help = node("p", "reader-guide", "Read the Greek first; each word’s lemma, grammar and dictionary gloss stay underneath it. Select a word for details. + shows alternative analyses, not certainty.");
  const body = node("div", "reader-body");
  const status = node("p", "reader-error");
  status.setAttribute("role", "status");
  const pager = node("nav", "pager");
  pager.setAttribute("aria-label", "Text pages");
  const info = node("span", "pager-info");
  const prev = node("button", "", "← Prev");
  const next = node("button", "", "Next →");
  const jump = node("input");
  jump.type = "number"; jump.min = "1";
  jump.setAttribute("aria-label", "Jump to page");
  const group = node("span", "pager-group");
  group.append(prev, jump, next);
  pager.append(info, group);
  app.replaceChildren(controls.root, heading, help, body, status, pager);

  // Paged accumulation: pages append forward and pop backward, so scroll-back,
  // find-in-page and the translation drawer keep working across turns while
  // the DOM stays bounded by how far the reader actually went.
  const units: Unit[] = []; // fetched (rendered or buffered), domRef pre-assigned
  const counts = new Map<string, number>();
  const usedRefs = new Set<string>();
  let partIndex = 0;
  let rendered = 0; // units painted into body
  let pageRows: number[] = []; // DOM rows per rendered page
  let busy = false;
  let atEnd = false;
  let kind: "verse" | "prose" = "verse";
  const ctx: RenderCtx = { morph: new Map(), gloss: new Map(), genre: genreFor(tlg), tlg };
  let translationWanted = false;
  let translationVersion = 0;
  const totalPages = () => Math.max(1, Math.ceil(work.unitCount / PAGE_SIZE));
  jump.max = String(totalPages());
  const paintPager = () => {
    const shown = pageRows.length;
    const start = shown ? rendered - pageRows[shown - 1] + 1 : 0;
    info.textContent = busy ? "Loading page…"
      : `Units ${start.toLocaleString()}–${rendered.toLocaleString()} of ` +
        `${work.unitCount.toLocaleString()} · Page ${shown} of ${totalPages()}`;
    prev.disabled = busy || shown <= 1;
    next.disabled = busy || atEnd || rendered >= work.unitCount;
    jump.disabled = busy;
    if (document.activeElement !== jump) jump.value = String(Math.max(1, shown));
    body.setAttribute("aria-busy", String(busy));
  };
  const trBtn = node("button", "tr-toggle", "English ▭");
  trBtn.setAttribute("aria-pressed", "false");
  trBtn.title = "Toggle the English translation drawer";
  const renderedUnits = (): Unit[] => units.slice(0, rendered);
  const refreshTranslation = async () => {
    const token = ++translationVersion;
    if (!translationWanted) return;
    trBtn.disabled = true;
    try {
      const view = await openTranslation(work, renderedUnits, ctx);
      if (!current() || token !== translationVersion) return;
      trBtn.setAttribute("aria-pressed", String(!!view));
    } finally { if (current()) trBtn.disabled = false; }
  };
  const onTrClosed = () => {
    translationWanted = false;
    trBtn.setAttribute("aria-pressed", "false");
  };
  document.addEventListener("tr-closed", onTrClosed);
  trBtn.onclick = () => {
    if (translationWanted) closeTranslation();
    else { translationWanted = true; void refreshTranslation(); }
  };
  if (work.translation?.files.length) controls.root.appendChild(trBtn);

  // Consume a part only after successful decoding. Retry never skips text.
  const fetchPart = async () => {
    const part = await loadPart(work.files[partIndex]);
    if (!current()) return;
    if (kind !== "prose" && part.kind === "prose") kind = "prose";
    for (const unit of part.units) {
      const occurrence = counts.get(unit.ref) ?? 0;
      counts.set(unit.ref, occurrence + 1);
      let domRef = occurrence === 0 ? unit.ref : occurrence <= 26
        ? `${unit.ref}${String.fromCharCode(96 + occurrence)}` : `${unit.ref}${occurrence}`;
      while (usedRefs.has(domRef)) domRef += "~";
      usedRefs.add(domRef);
      units.push({ ...unit, domRef, occurrence });
    }
    partIndex++;
  };
  const savePosition = (value: string | undefined) => {
    if (!value || !current()) return;
    setFocusedRef(value);
    saveRecent(tlg, work.id, value);
  };
  /** Render exactly one more page (fetching as needed), appended to the view. */
  const loadNextPage = async (): Promise<void> => {
    try {
      while (rendered + PAGE_SIZE > units.length && partIndex < work.files.length && current()) {
        await fetchPart();
      }
      if (!current()) return;
      const batch = units.slice(rendered, rendered + PAGE_SIZE);
      if (!batch.length) { atEnd = true; return; }
      const fresh = await prepare(batch);
      if (!current()) return;
      mergeCtx(ctx, fresh.morph, fresh.gloss);
      tallyLemmas(ctx, batch); // grow the work-view frequency signal
      renderUnits(body, batch, ctx, kind, rendered);
      rendered += batch.length;
      pageRows.push(batch.length);
      savePosition(batch[0].domRef);
      if (translationWanted) void refreshTranslation();
    } catch (error) {
      if (!current()) return;
      status.textContent =
        `Could not load page ${pageRows.length + 1}: ${error instanceof Error ? error.message : String(error)} `;
      const retry = node("button", "", "Retry page");
      retry.onclick = () => { status.replaceChildren(); void turnPage(1); };
      status.appendChild(retry);
    }
  };
  /** Remove the last rendered page from screen (data stays cached for re-entry). */
  const popPage = (): void => {
    const rows = pageRows.pop();
    if (!rows) return;
    for (let i = 0; i < rows; i++) body.lastElementChild?.remove();
    rendered -= rows;
    if (translationWanted) void refreshTranslation();
  };
  /** Page turning: delta ±1 steps or a jump to an absolute page number. */
  const turnPage = async (delta: number): Promise<void> => {
    if (busy || !delta || !current()) return;
    const target = Math.max(1, Math.min(totalPages(), pageRows.length + delta));
    if (target === pageRows.length) return;
    busy = true; status.replaceChildren(); paintPager();
    try {
      if (delta > 0) {
        while (pageRows.length < target && !atEnd && current()) await loadNextPage();
      } else {
        while (pageRows.length > target && pageRows.length > 1) popPage();
      }
      stopTTS(); hidePanel();
      window.scrollTo({ top: 0 });
    } finally { busy = false; if (current()) paintPager(); }
  };
  /** Page forward until the unit with this ref is rendered, then center it.
   *  Capped at ~40 pages (1200 units) so a bogus ref cannot load a whole work. */
  const jumpToRef = async (ref: string): Promise<void> => {
    const find = (): HTMLElement | null =>
      body.querySelector<HTMLElement>(`[data-ref="${CSS.escape(ref)}"]`);
    let target = find();
    let guard = 0;
    while (!target && !atEnd && guard < 40 && current()) {
      busy = true; paintPager();
      await loadNextPage();
      busy = false; paintPager();
      target = find();
      guard += 1;
    }
    if (!target || !current()) return;
    savePosition(ref);
    target.scrollIntoView({ block: "center" });
    target.classList.add("ref-flash");
    window.setTimeout(() => target!.classList.remove("ref-flash"), 2400);
  };
  prev.onclick = () => void turnPage(-1);
  next.onclick = () => void turnPage(1);
  jump.onkeydown = (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      const value = Number(jump.value);
      if (Number.isInteger(value) && value >= 1) void turnPage(value - pageRows.length);
    }
  };
  let saveTimer = 0;
  const onScroll = () => {
    clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => {
      const toolbarBottom = controls.root.getBoundingClientRect().bottom;
      const row = Array.from(body.querySelectorAll<HTMLElement>("[data-ref]"))
        .find((item) => item.getBoundingClientRect().bottom > Math.max(0, toolbarBottom));
      savePosition(row?.dataset.ref);
    }, 500);
  };
  window.addEventListener("scroll", onScroll, { passive: true });
  cleanup = () => {
    clearTimeout(saveTimer);
    window.removeEventListener("scroll", onScroll);
    document.removeEventListener("tr-closed", onTrClosed);
    translationVersion++;
  };
  await loadNextPage();
  if (!current()) return;
  paintPager();
  // resume: honor an explicit ?ref= deep link by paging forward to it.
  // A bogus ref falls back to page 1 with an explanatory note.
  if (ref) {
    if (!body.querySelector(`[data-ref="${CSS.escape(ref)}"]`)) await jumpToRef(ref);
    else {
      savePosition(ref);
      const target = body.querySelector<HTMLElement>(`[data-ref="${CSS.escape(ref)}"]`);
      target?.scrollIntoView({ block: "center" });
      target?.classList.add("ref-flash");
    }
    if (current() && !body.querySelector(`[data-ref="${CSS.escape(ref)}"]`)) {
      status.textContent = `Reference “${ref}” was not found. Showing the beginning instead.`;
    }
  }
  if (!current() || kind !== "verse") return;
  setProsodyWorkId(`${tlg}--${work.id}`);
  const patterns = await loadProsody(work.id, tlg);
  if (current() && patterns?.size) controls.root.appendChild(createProsodyToggle(work.id, tlg));
}

window.addEventListener("hashchange", () => void go());
initLLM();
initPWA();
const lexFab = lexiconButton("Lexicon");
lexFab.className = "lex-fab";
document.body.appendChild(lexFab);
void go();
