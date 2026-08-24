// Bookmarks & resume: pure localStorage under "greek-reader.bookmarks".
//   auto:  one resume position per work (tlg/workId), updated on scroll/page
//          change by main.ts.
//   stars: explicit per-unit bookmarks toggled from the unit header ★.
// All DOM via textContent — never innerHTML.

type El = HTMLElement;
const el = (tag: string, cls?: string, text?: string): El => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

const KEY = "greek-reader.bookmarks";

export interface Mark {
  tlg: string;
  workId: string;
  ref: string;
  ts: number;
}

interface BookmarkData {
  v: 1;
  auto: Record<string, Mark>;
  stars: Mark[];
}

function defaults(): BookmarkData {
  return { v: 1, auto: {}, stars: [] };
}

let cache: BookmarkData | null = null;

function load(): BookmarkData {
  if (cache) return cache;
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const d = JSON.parse(raw) as Partial<BookmarkData>;
      cache = {
        v: 1,
        auto: d.auto && typeof d.auto === "object" ? d.auto : {},
        stars: Array.isArray(d.stars) ? d.stars : [],
      };
      return cache;
    }
  } catch {
    /* corrupted -> reset */
  }
  cache = defaults();
  return cache;
}

function save(): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(load()));
  } catch {
    /* degrade silently */
  }
}

const kOf = (tlg: string, wid: string): string => `${tlg}/${wid}`;

/** Save/refresh the resume position for one work. */
export function saveRecent(tlg: string, workId: string, ref: string): void {
  if (!ref || !tlg || !workId) return;
  const d = load();
  d.auto[kOf(tlg, workId)] = { tlg, workId, ref, ts: Date.now() };
  save();
}

export function getRecent(tlg: string, workId: string): Mark | null {
  return load().auto[kOf(tlg, workId)] ?? null;
}

/** Up to `limit` most recent works (newest first). */
export function listRecent(limit = 4): Mark[] {
  return Object.values(load().auto)
    .sort((a, b) => b.ts - a.ts)
    .slice(0, limit);
}

export function isStarred(tlg: string, wid: string, ref: string): boolean {
  return load().stars.some(
    (s) => s.tlg === tlg && s.workId === wid && s.ref === ref,
  );
}

/** Toggle a unit star; returns the new state. */
export function toggleStar(tlg: string, wid: string, ref: string): boolean {
  const d = load();
  const i = d.stars.findIndex(
    (s) => s.tlg === tlg && s.workId === wid && s.ref === ref,
  );
  let now: boolean;
  if (i >= 0) {
    d.stars.splice(i, 1);
    now = false;
  } else {
    d.stars.push({ tlg, workId: wid, ref, ts: Date.now() });
    now = true;
  }
  save();
  return now;
}

export function listStars(): Mark[] {
  return [...load().stars].sort((a, b) => b.ts - a.ts);
}

export function exportJSON(): string {
  return JSON.stringify(load(), null, 1);
}

export function importJSON(text: string): { added: number; bad: boolean } {
  let parsed: Partial<BookmarkData>;
  try {
    parsed = JSON.parse(text) as Partial<BookmarkData>;
  } catch {
    return { added: 0, bad: true };
  }
  if (!parsed || typeof parsed !== "object") return { added: 0, bad: true };
  const d = load();
  let added = 0;
  if (parsed.auto && typeof parsed.auto === "object") {
    for (const [k, v] of Object.entries(parsed.auto)) {
      if (!v?.tlg || !v?.workId || !v?.ref) continue;
      if (!d.auto[k]) added += 1;
      d.auto[k] = v;
    }
  }
  if (Array.isArray(parsed.stars)) {
    for (const s of parsed.stars) {
      if (!s?.tlg || !s?.workId || !s?.ref) continue;
      if (!isStarred(s.tlg, s.workId, s.ref)) {
        d.stars.push({ tlg: s.tlg, workId: s.workId, ref: s.ref, ts: s.ts ?? Date.now() });
        added += 1;
      }
    }
  }
  save();
  return { added, bad: false };
}

// ---- context for unit star buttons (set by main.ts on reader routes) -----

let ctxTlg: string | null = null;
let ctxWid: string | null = null;
let ctxRef: string | null = null;

export function setUnitContext(
  tlg: string | null,
  wid: string | null,
  ref?: string,
): void {
  ctxTlg = tlg;
  ctxWid = wid;
  if (ref !== undefined) ctxRef = ref;
}

/** Track the unit the reader is currently focused on (deep-link target or
 *  topmost visible row); saveRecent uses this instead of page[0]. */
export function setFocusedRef(ref: string | null): void {
  ctxRef = ref;
}

export function getFocusedRef(): string | null {
  return ctxRef;
}

/** Per-unit star button for unit-actions; hidden without reader context. */
export function starButtonFor(ref: string): El | null {
  if (!ctxTlg || !ctxWid || !ref) return null;
  const b = el("button", "star-btn") as HTMLButtonElement;
  b.type = "button";
  const paint = (): void => {
    const saved = isStarred(ctxTlg!, ctxWid!, ref);
    b.textContent = saved ? "★" : "☆";
    b.classList.toggle("saved", saved);
    b.title = saved ? "Remove bookmark" : "Bookmark this line";
    b.setAttribute("aria-pressed", String(saved));
    b.setAttribute("aria-label", `${saved ? "Remove bookmark" : "Bookmark"} ${ref}`);
  };
  paint();
  b.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleStar(ctxTlg!, ctxWid!, ref);
    paint();
  });
  return b;
}

/** Per-unit copy-link button: copies a deep link that jumps to this unit. */
export function copyLinkButtonFor(ref: string): El | null {
  if (!ctxTlg || !ctxWid || !ref) return null;
  const b = el("button", "copy-link-btn") as HTMLButtonElement;
  b.type = "button";
  b.textContent = "⧉";
  b.title = `Copy deep link to ${ref}`;
  b.setAttribute("aria-label", `Copy link to ${ref}`);
  b.addEventListener("click", (e) => {
    e.stopPropagation();
    const url =
      `${location.origin}${location.pathname}` +
      `#/${ctxTlg}/${ctxWid}?ref=${encodeURIComponent(ref)}`;
    const done = (): void => {
      b.textContent = "✓";
      window.setTimeout(() => {
        b.textContent = "⧉";
      }, 1200);
    };
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(url).then(done, () => {
        b.title = "Copy failed";
      });
    } else {
      const ta = document.createElement("textarea");
      ta.value = url;
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
        done();
      } catch {
        b.title = "Copy failed";
      }
      ta.remove();
    }
  });
  return b;
}

/** Relative time like "2h ago" / "3d ago". */
export function relTime(ts: number): string {
  const s = Math.max(1, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const dd = Math.round(h / 24);
  return `${dd}d ago`;
}

/** "Continue reading" section for the home page (inserted by main.ts). */
export function continueReadingSection(titles: Map<string, string>): El {
  const sec = el("section", "continue-reading");
  sec.appendChild(el("h2", undefined, "Continue reading"));
  const list = el("div", "cards continue-cards");
  const recents = listRecent(4);
  if (!recents.length) {
    sec.hidden = true;
    return sec;
  }
  for (const m of recents) {
    const a = el("a", "card cont-card") as HTMLAnchorElement;
    a.href = `#/${m.tlg}/${m.workId}?ref=${encodeURIComponent(m.ref)}`;
    a.appendChild(el("div", "title", titles.get(m.workId) ?? m.workId));
    a.appendChild(el(
      "div",
      "meta",
      `${m.ref} · ${relTime(m.ts)}`,
    ));
    list.appendChild(a);
  }
  sec.appendChild(list);
  return sec;
}

/** Simple starred-lines panel (toolbar ★ opens it). */
export function openStarPanel(titles: Map<string, string>): void {
  document.querySelector(".star-panel")?.remove();
  const panel = el("div", "star-panel");
  const head = el("div", "star-panel-head");
  head.appendChild(el("strong", undefined, "Bookmarked lines"));
  const close = el("button", "close-btn", "×") as HTMLButtonElement;
  close.type = "button";
  close.setAttribute("aria-label", "Close bookmarks");
  close.addEventListener("click", () => panel.remove());
  head.appendChild(close);
  panel.appendChild(head);

  const stars = listStars();
  if (!stars.length) {
    panel.appendChild(el("p", "star-panel-empty",
      "No bookmarks yet — tap ☆ next to any line."));
  } else {
    const ul = el("ul", "star-list");
    for (const s of stars.slice(0, 100)) {
      const li = el("li");
      const a = el("a") as HTMLAnchorElement;
      a.href = `#/${s.tlg}/${s.workId}?ref=${encodeURIComponent(s.ref)}`;
      a.appendChild(el("span", "hit-title", titles.get(s.workId) ?? s.workId));
      a.appendChild(document.createTextNode(` ${s.ref}`));
      li.appendChild(a);
      const rm = el("button", "star-rm", "✕") as HTMLButtonElement;
      rm.type = "button";
      rm.title = "Remove";
      rm.addEventListener("click", () => {
        toggleStar(s.tlg, s.workId, s.ref);
        li.remove();
      });
      li.appendChild(rm);
      ul.appendChild(li);
    }
    panel.appendChild(ul);
  }
  document.body.appendChild(panel);
}
