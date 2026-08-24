// Vocabulary book: pure-localStorage known-words tracking (schema v1).
// Keyed by accent-stripped surface form (stripAccents output), with the
// best current lemma stored as info. Rendering hooks live in render.ts;
// this module owns storage, stats, bulk-confirm modal, and the toolbar
// controls. All DOM via textContent — never innerHTML.

type El = HTMLElement;
const el = (tag: string, cls?: string, text?: string): El => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

const KEY = "greek-reader.vocab";

export type VocabMode = "highlight-unknown" | "off";

export interface VocabEntry {
  lemma?: string;
  ts: number;
}

interface VocabData {
  v: 1;
  known: Record<string, VocabEntry>;
  settings: { mode: VocabMode };
}

function defaults(): VocabData {
  return { v: 1, known: {}, settings: { mode: "highlight-unknown" } };
}

let cache: VocabData | null = null;

function load(): VocabData {
  if (cache) return cache;
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const d = JSON.parse(raw) as Partial<VocabData>;
      cache = {
        v: 1,
        known: d.known && typeof d.known === "object" ? d.known : {},
        settings: {
          mode:
            d.settings?.mode === "off" ? "off" : "highlight-unknown",
        },
      };
      return cache;
    }
  } catch {
    /* corrupted store -> reset */
  }
  cache = defaults();
  return cache;
}

function save(): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(load()));
  } catch {
    /* private mode / quota — features degrade silently */
  }
}

export function isKnown(stripped: string): boolean {
  return Object.prototype.hasOwnProperty.call(load().known, stripped);
}

export function markKnown(stripped: string, lemma?: string): void {
  const d = load();
  d.known[stripped] = { lemma: lemma || undefined, ts: Date.now() };
  save();
}

export function unmarkKnown(stripped: string): void {
  const d = load();
  delete d.known[stripped];
  save();
}

export function getMode(): VocabMode {
  return load().settings.mode;
}

export function setMode(mode: VocabMode): void {
  load().settings.mode = mode;
  save();
}

export function knownCount(): number {
  return Object.keys(load().known).length;
}

/** Serialize for export (About page download). */
export function exportJSON(): string {
  return JSON.stringify(load(), null, 1);
}

/** Merge an imported blob; returns unique forms added. */
export function importJSON(text: string): { added: number; bad: boolean } {
  let parsed: Partial<VocabData>;
  try {
    parsed = JSON.parse(text) as Partial<VocabData>;
  } catch {
    return { added: 0, bad: true };
  }
  if (!parsed || typeof parsed !== "object" ||
    typeof parsed.known !== "object" || parsed.known === null) {
    return { added: 0, bad: true };
  }
  const d = load();
  let added = 0;
  for (const [k, v] of Object.entries(parsed.known as Record<string, VocabEntry>)) {
    if (!k) continue;
    if (!Object.prototype.hasOwnProperty.call(d.known, k)) added += 1;
    d.known[k] = {
      lemma: typeof v?.lemma === "string" ? v.lemma : undefined,
      ts: typeof v?.ts === "number" ? v.ts : Date.now(),
    };
  }
  save();
  return { added, bad: false };
}

// ---- toolbar wiring -------------------------------------------------------

let chipEl: El | null = null;

/** Toolbar stats chip; render.ts creates it once per controls bar. */
export function attachChip(target: El): El {
  chipEl = el("span", "vocab-chip");
  chipEl.title = "Unknown / total word forms on this page";
  chipEl.setAttribute("aria-live", "polite");
  target.appendChild(chipEl);
  refreshChip();
  return chipEl;
}

/** Recompute the chip from the word spans currently on screen. */
export function refreshChip(): void {
  if (!chipEl) return;
  let total = 0;
  let unknown = 0;
  const mode = getMode();
  document
    .querySelectorAll<HTMLElement>(".greek-line .w:not(.speaker)")
    .forEach((sp) => {
      total += 1;
      if (mode === "off") return;
      const key = sp.dataset.stripped ?? "";
      if (!key || !isKnown(key)) unknown += 1;
    });
  if (!total) {
    chipEl.textContent = "";
    chipEl.hidden = true;
    return;
  }
  chipEl.hidden = false;
  chipEl.textContent = mode === "off"
    ? `${total} words`
    : `unknown ${unknown} / ${total}`;
}

/** Apply the current mode's dimming to every word span on screen.
 *  Spans carry data-stripped (set at render time). */
export function applyClasses(): void {
  const mode = getMode();
  // body-level state so CSS can gate dimming globally
  document.body.classList.toggle("vocab-highlight", mode === "highlight-unknown");
  document.querySelectorAll<HTMLElement>(".greek-line .w:not(.speaker)").forEach((sp) => {
    const key = sp.dataset.stripped ?? "";
    sp.classList.toggle("vk", mode === "highlight-unknown" && !!key && isKnown(key));
  });
  refreshChip();
}

/** Toggle group + bulk helper button; returns the root to append. */
export function toolbarControls(): El {
  const group = el("span", "vocab-group");

  const label = el("span", "vocab-label", "Vocab:");
  group.appendChild(label);

  const offBtn = el("button", undefined, "Off") as HTMLButtonElement;
  const hiBtn = el("button", undefined, "Highlight unknown") as HTMLButtonElement;
  offBtn.type = hiBtn.type = "button";
  const paint = (): void => {
    const m = getMode();
    offBtn.setAttribute("aria-pressed", String(m === "off"));
    hiBtn.setAttribute("aria-pressed", String(m === "highlight-unknown"));
  };
  offBtn.addEventListener("click", () => {
    setMode("off");
    paint();
    applyClasses();
  });
  hiBtn.addEventListener("click", () => {
    setMode("highlight-unknown");
    paint();
    applyClasses();
  });
  paint();
  group.appendChild(offBtn);
  group.appendChild(hiBtn);

  const markAll = el("button", undefined, "Mark page known") as HTMLButtonElement;
  markAll.type = "button";
  markAll.title = "Mark every word form on this page as known";
  markAll.addEventListener("click", () => {
    const forms = new Set<string>();
    document
      .querySelectorAll<HTMLElement>(".greek-line .w:not(.speaker)")
      .forEach((sp) => {
        const key = sp.dataset.stripped ?? "";
        if (key && !isKnown(key)) forms.add(key);
      });
    confirmModal(
      forms.size,
      () => {
        const lemmaSample: string | undefined = undefined;
        for (const f of forms) markKnown(f, lemmaSample);
        applyClasses();
      },
    );
  });
  group.appendChild(markAll);

  return group;
}

/** Explicit-click confirmation modal for bulk marking. */
function confirmModal(uniqueCount: number, onConfirm: () => void): void {
  if (uniqueCount === 0) return;
  const backdrop = el("div", "modal-backdrop");
  const card = el("div", "modal-card");
  card.setAttribute("role", "dialog");
  card.setAttribute("aria-modal", "true");
  card.appendChild(el("h3", undefined, "Mark whole page known?"));
  card.appendChild(el("p", "modal-text",
    `${uniqueCount} unknown word form${uniqueCount === 1 ? "" : "s"} on this ` +
    `page will be added to your vocabulary book.`,
  ));
  const row = el("div", "modal-row");
  const cancel = el("button", undefined, "Cancel") as HTMLButtonElement;
  cancel.type = "button";
  const ok = el("button", "modal-ok", `Mark ${uniqueCount} known`) as HTMLButtonElement;
  ok.type = "button";
  cancel.addEventListener("click", () => backdrop.remove());
  ok.addEventListener("click", () => {
    onConfirm();
    backdrop.remove();
  });
  row.appendChild(cancel);
  row.appendChild(ok);
  card.appendChild(row);
  backdrop.appendChild(card);
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) backdrop.remove();
  });
  document.body.appendChild(backdrop);
  ok.focus();
}
