// Translation drawer: unit-aligned English text beside the reader.
// Catalog shape (defensive — corpus agent may add these concurrently):
//   work.translation = { files: string[], translator?: string,
//                        year?: string|number, license: string }
// Alignment: verse units match by ref; prose aligns best-effort by sequence.
// Scroll sync is approximate (proportional), highlighting the current unit.
import { fetchJSON, type CatalogWork, type Unit, type WorkPart } from "./api";

type El = HTMLElement;
const el = (tag: string, cls?: string, text?: string): El => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text; // never innerHTML
  return e;
};

interface TrMeta {
  files?: string[];
  translator?: string;
  year?: string | number;
  license?: string;
}

export interface TranslationView {
  root: El;
  toggle(): void;
  isOpen(): boolean;
}

let scrollCleanup: (() => void) | null = null;

/** "Trans. A. T. Murray (1924) · Public domain" / "KJV 1769 · Public domain". */
export function creditLine(t: TrMeta): string {
  const bits: string[] = [];
  const who: string[] = [];
  if (t.translator) who.push(`Trans. ${t.translator}`);
  if (t.year !== undefined && t.year !== "") {
    who.push(String(t.year));
  }
  // bare year without translator reads like an edition ("KJV 1769")
  if (!t.translator && t.year !== undefined) {
    return [String(t.year), t.license].filter(Boolean).join(" · ");
  }
  if (who.length) bits.push(who.join(" "));
  if (t.license) bits.push(t.license);
  return bits.join(" · ");
}

export async function openTranslation(
  work: CatalogWork,
  greekUnits: () => Unit[],
): Promise<TranslationView | null> {
  const meta = (work as { translation?: TrMeta }).translation;
  const files = meta?.files ?? [];
  if (!files.length) return null;

  let panel = document.getElementById("tr-drawer") as El | null;
  if (!panel) {
    panel = el("aside", "drawer right hidden");
    panel.id = "tr-drawer";
    panel.setAttribute("aria-label", "English translation");
    document.body.appendChild(panel);
  }
  panel.replaceChildren();

  const close = el("button", "close-btn", "×");
  close.setAttribute("aria-label", "Close translation");
  close.addEventListener("click", () => panel!.classList.add("hidden"));
  panel.appendChild(close);

  panel.appendChild(el("h2", undefined, `English — ${work.title}`));

  const credits = el("p", "tr-credits");
  const credit = creditLine(meta ?? {});
  if (credit) credits.textContent = credit;
  else credits.textContent = "Translation";
  panel.appendChild(credits);

  const body = el("div", "tr-body");
  panel.appendChild(body);
  const note = el("p", "tr-credits", "Loading translation…");
  panel.appendChild(note);

  // fetch all translation parts (same WorkPart shape as Greek texts)
  let trUnits: Unit[] = [];
  try {
    const parts = await Promise.all(
      files.map((f) => fetchJSON<WorkPart>(`data/${f}`)),
    );
    for (const p of parts) trUnits.push(...p.units);
    note.textContent = trUnits.length
      ? ""
      : "Translation file has no units.";
  } catch (e) {
    note.textContent = `Translation unavailable: ${(e as Error).message}`;
  }

  // render English rows; verse aligns by ref, prose by sequence index
  body.replaceChildren();
  const greek = greekUnits();
  const rows: El[] = [];
  const used = new Set<number>();
  for (let i = 0; i < greek.length; i++) {
    const gu = greek[i];
    let j = -1;
    if (gu.ref) {
      j = trUnits.findIndex((t, k) => t.ref === gu.ref && !used.has(k));
    }
    if (j < 0 && i < trUnits.length && !used.has(i)) j = i;
    const row = el("div", "tr-unit");
    const refTxt = gu.ref || trUnits[j]?.ref || "";
    if (refTxt) row.appendChild(el("span", "tr-ref", refTxt));
    const txt = j >= 0 ? trUnits[j].words.join(" ") : "—";
    row.appendChild(el("div", "tr-text", txt || "—"));
    if (j >= 0) used.add(j);
    body.appendChild(row);
    rows.push(row);
  }
  // leftover translation units with no Greek counterpart (rare)
  for (let k = 0; k < trUnits.length; k++) {
    if (used.has(k)) continue;
    const row = el("div", "tr-unit");
    if (trUnits[k].ref) row.appendChild(el("span", "tr-ref", trUnits[k].ref));
    row.appendChild(el("div", "tr-text", trUnits[k].words.join(" ")));
    body.appendChild(row);
    rows.push(row);
  }

  // rough scroll sync: proportional mapping + nearest-row highlight
  if (scrollCleanup) {
    scrollCleanup();
    scrollCleanup = null;
  }
  const onScroll = (): void => {
    if (panel!.classList.contains("hidden")) return;
    const doc = document.scrollingElement ?? document.documentElement;
    const max = doc.scrollHeight - window.innerHeight;
    const frac = max > 0 ? Math.min(1, Math.max(0, window.scrollY / max)) : 0;
    const dMax = panel!.scrollHeight - panel!.clientHeight;
    panel!.scrollTop = frac * Math.max(0, dMax);
    const idx = Math.min(rows.length - 1,
      Math.floor(frac * rows.length));
    rows.forEach((r, i2) => r.classList.toggle("current", i2 === idx));
  };
  window.addEventListener("scroll", onScroll, { passive: true });
  scrollCleanup = () => window.removeEventListener("scroll", onScroll);
  onScroll();

  panel.classList.remove("hidden");

  return {
    root: panel,
    toggle() {
      panel!.classList.toggle("hidden");
      if (!panel!.classList.contains("hidden")) onScroll();
    },
    isOpen: () => !panel!.classList.contains("hidden"),
  };
}
