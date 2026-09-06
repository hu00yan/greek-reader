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
  const chCounts = new Map<string, number>(); // chapter key -> units known
  const usedRefs = new Set<string>();
  let partIndex = 0;
  let rendered = 0; // units painted into body
  let pageRows: Array<{ children: number; units: number }> = []; // per rendered page
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
    const start = shown ? rendered - pageRows[shown - 1].units + 1 : 0;
    info.textContent = busy ? "Loading page…"
      : `Units ${start.toLocaleString()}–${rendered.toLocaleString()} of ` +
        `${work.unitCount.toLocaleString()} · Page ${shown} of ${totalPages()}`;
    prev.disabled = busy || shown <= 1;
    next.disabled = busy || atEnd || rendered >= work.unitCount;
    jump.disabled = busy;
    chSel.disabled = busy;
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

  /* ---------------- chapter navigation ---------------- */
  // Chapter key: ref up to the first dot, keeping letter prefixes
  // ("steph.1.1" → "steph.1", "1.2.3" → "1", "260.2" → "260").
  function chapterKey(ref: string): string {
    const out: string[] = [];
    for (const seg of (ref || "").split(".")) {
      out.push(seg);
      if (!/^[A-Za-z]+$/.test(seg)) break;
    }
    return out.join(".");
  }
  interface Chapter { key: string; label: string; start: number }
  /** Chapters in unit order. Long digit runs (continuous line numbers of
   *  plays/hymns) collapse into hundred-blocks; citable keys (books,
   *  Stephanus pages, sections) always stay individual. */
  function buildChapters(): Chapter[] {
    const raw: Array<{ key: string; start: number }> = [];
    units.forEach((u, i) => {
      const k = u.chapter ?? "";
      if (!k) return;
      if (!raw.length || raw[raw.length - 1].key !== k) raw.push({ key: k, start: i });
    });
    const out: Chapter[] = [];
    let i = 0;
    while (i < raw.length) {
      let j = i;
      while (j < raw.length && /^\d+$/.test(raw[j].key)) j++;
      if (j - i > 40) {
        let b = -1; let lo = "";
        for (let k = i; k < j; k++) {
          const nb = Math.floor((Number(raw[k].key) - 1) / 100);
          if (nb !== b) {
            b = nb; lo = raw[k].key;
            out.push({ key: lo, label: lo, start: raw[k].start });
          } else {
            out[out.length - 1].label = `${lo}–${raw[k].key}`;
          }
        }
      } else {
        for (let k = i; k < j; k++) {
          out.push({ key: raw[k].key, label: raw[k].key, start: raw[k].start });
        }
      }
      if (j === i) { // non-digit key: its own entry
        out.push({ key: raw[i].key, label: raw[i].key, start: raw[i].start });
        j = i + 1;
      }
      i = j;
    }
    return out;
  }
  const chSel = node("select");
  chSel.className = "chapter-jump";
  chSel.setAttribute("aria-label", "Jump to chapter");
  chSel.hidden = true;
  pager.appendChild(chSel);
  let chapters: Chapter[] = [];
  /** Rebuild the menu from fetched units; shown only for long, sectioned works. */
  const rebuildChapters = () => {
    if (!current()) return;
    chapters = buildChapters();
    const show = chapters.length >= 3 && totalPages() >= 3;
    chSel.hidden = !show;
    if (!show) return;
    const keep = chSel.value;
    chSel.replaceChildren();
    const ph = document.createElement("option");
    ph.value = "";
    ph.textContent = "Chapter…";
    chSel.appendChild(ph);
    for (const c of chapters) {
      const o = document.createElement("option");
      o.value = String(c.start);
      o.textContent = c.label;
      chSel.appendChild(o);
    }
    if (keep) chSel.value = keep;
    chSel.disabled = busy;
  };
  chSel.onchange = () => {
    if (chSel.value === "") return;
    const start = Number(chSel.value);
    chSel.value = "";
    if (!Number.isInteger(start) || !units[start]) return;
    const ref = units[start].domRef;
    // Already on screen: just center it. Otherwise page there, then center.
    const target = Math.floor(start / PAGE_SIZE) + 1;
    const land = () => {
      if (!current() || !ref) return;
      const row = body.querySelector<HTMLElement>(`[data-ref="${CSS.escape(ref)}"]`);
      if (!row) return;
      savePosition(ref);
      row.scrollIntoView({ block: "center" });
      row.classList.add("ref-flash");
      window.setTimeout(() => row.classList.remove("ref-flash"), 2400);
    };
    if (target <= pageRows.length) land();
    else void turnPage(target - pageRows.length).then(() => land());
  };
  // Fetch remaining parts quietly so the menu covers the whole work.
  // Single-part works (733/755) already hold everything after page 1.
  let scanning = false;
  const scanChapters = async () => {
    if (scanning) return;
    scanning = true;
    try {
      while (partIndex < work.files.length && current()) await fetchPart();
      if (current()) rebuildChapters();
    } catch { /* menu stays partial; paging still extends it */ }
    finally { scanning = false; }
  };
  const chapterDivider = (label: string): HTMLElement => {
    const d = node("div", "chapter-div");
    d.setAttribute("aria-hidden", "true"); // decorative kicker; refs stay on rows
    d.appendChild(node("span", "chapter-div-label", label));
    return d;
  };

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
      const chapter = chapterKey(unit.ref);
      chCounts.set(chapter, (chCounts.get(chapter) ?? 0) + 1);
      units.push({ ...unit, domRef, occurrence, chapter });
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
      // Chapter dividers: split the batch into same-chapter runs so a
      // boundary renders a kicker wherever it falls (page start or mid-page).
      // Chapters are rebuilt here (not reused from menu state) so page 1 is
      // already correct before the background scan finishes.
      chapters = buildChapters();
      const chEligible = chapters.length >= 3 && totalPages() >= 3;
      const labelByStart = new Map(chapters.map((c) => [c.start, c.label]));
      const before = body.childElementCount;
      let off = 0;
      while (off < batch.length) {
        let end = off + 1;
        while (end < batch.length && batch[end].chapter === batch[off].chapter) end++;
        const ch = batch[off].chapter;
        const isFirst = rendered === 0 && off === 0;
        const prevCh = off === 0
          ? (rendered > 0 ? units[rendered - 1].chapter : undefined)
          : batch[off - 1].chapter;
        if (!isFirst && ch && ch !== prevCh && chEligible && (chCounts.get(ch) ?? 0) >= 4) {
          body.appendChild(chapterDivider(
            labelByStart.get(rendered + off) ?? ch));
        }
        renderUnits(body, batch.slice(off, end), ctx, kind, rendered + off);
        off = end;
      }
      rendered += batch.length;
      pageRows.push({ children: body.childElementCount - before, units: batch.length });
      rebuildChapters();
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
    const page = pageRows.pop();
    if (!page) return;
    for (let i = 0; i < page.children; i++) body.lastElementChild?.remove();
    rendered -= page.units;
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
        while (pageRows.length < target && !atEnd && current()) {
          await loadNextPage();
          paintPager(); // progress feedback on long multi-page jumps
        }
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
      if (!current()) return;
      const toolbarBottom = controls.root.getBoundingClientRect().bottom;
      const row = Array.from(body.querySelectorAll<HTMLElement>("[data-ref]"))
        .find((item) => item.getBoundingClientRect().bottom > Math.max(0, toolbarBottom));
      savePosition(row?.dataset.ref);
      // Keep the chapter menu honest about reading position.
      const idx = Number(row?.dataset.idx);
      if (!chSel.hidden && Number.isInteger(idx)) {
        let v = "";
        for (const c of chapters) {
          if (c.start <= idx) v = String(c.start);
          else break;
        }
        if (v && chSel.querySelector(`option[value="${v}"]`)) chSel.value = v;
      }
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
  rebuildChapters();
  void scanChapters(); // complete the chapter menu quietly in the background
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
