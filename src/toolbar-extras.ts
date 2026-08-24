// Reader-toolbar extras WITHOUT touching render.ts: appends
//   [Expand all] [Collapse all]
// buttons to any .controls bar (reader pages) and binds the "E" keyboard
// shortcut to toggle. Uses the expandAll/collapseAll exports the concurrent
// renderer refactor already ships (per-form expansion state stays in
// render.ts's expandedForms registry; our flag only tracks the last global
// action so "E" can flip).

import { collapseAll, expandAll } from "./render";

let expanded = false;

function toggle(): void {
  expanded = !expanded;
  if (expanded) {
    expandAll();
    updateLabels("collapse");
  } else {
    collapseAll();
    updateLabels("expand");
  }
}

function updateLabels(state: "expand" | "collapse"): void {
  const ex = document.querySelector<HTMLButtonElement>("[data-toolbar='expand-all']");
  const co = document.querySelector<HTMLButtonElement>("[data-toolbar='collapse-all']");
  if (ex) ex.setAttribute("aria-pressed", state === "collapse" ? "true" : "false");
  if (co) co.setAttribute("aria-pressed", state === "collapse" ? "true" : "false");
}

function attach(root: ParentNode): void {
  const bars = root.querySelectorAll<HTMLElement>(
    ".controls:not([data-tb-extras])",
  );
  for (const bar of bars) {
    bar.setAttribute("data-tb-extras", "1");
    // Deduplicate: render.ts already provides Expand all / Collapse all / Hide glosses.
    // Do not add duplicates — keep toolbar to exactly those 3.
    const texts = Array.from(bar.querySelectorAll("button")).map((b) => (b.textContent ?? "").trim().toLowerCase());
    const hasExpand = texts.some((t) => t === "expand all" || t === "expand all analyses");
    const hasCollapse = texts.some((t) => t === "collapse all");
    const hasHide = texts.some((t) => t.includes("hide gloss") || t.includes("show gloss"));
    if (hasExpand && hasCollapse && hasHide) continue;
    // If render's buttons already exist, skip adding extras entirely.
    if (hasExpand && hasCollapse) continue;
    const mk = (label: string, attr: string, fn: () => void): HTMLButtonElement => {
      const b = document.createElement("button");
      b.type = "button";
      b.dataset.toolbar = attr;
      b.textContent = label;
      b.addEventListener("click", () => {
        expanded = attr === "expand-all";
        fn();
        updateLabels(attr === "expand-all" ? "collapse" : "expand");
      });
      return b;
    };
    if (!hasExpand) {
      const exp = mk("Expand all", "expand-all", expandAll);
      const spacer = bar.querySelector<HTMLElement>(".spacer");
      if (spacer) bar.insertBefore(exp, spacer);
      else bar.appendChild(exp);
    }
    if (!hasCollapse) {
      const col = mk("Collapse all", "collapse-all", collapseAll);
      const spacer = bar.querySelector<HTMLElement>(".spacer");
      if (spacer) bar.insertBefore(col, spacer);
      else bar.appendChild(col);
    }
  }
}

let scheduled = false;

export function initToolbarExtras(): void {
  const schedule = (): void => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      attach(document);
    });
  };
  new MutationObserver(schedule).observe(document.body, {
    childList: true,
    subtree: true,
  });
  schedule();

  // Deduplicated E toggle: render.ts already handles 'E' globally.
  // Keep listener only as fallback when render's handler is absent,
  // but guard against double-toggle by checking toolbar state.
  document.addEventListener("keydown", (e) => {
    if (e.key !== "e" && e.key !== "E") return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target as HTMLElement | null;
    if (t && /^(input|textarea|select)$/i.test(t.tagName)) return;
    // If render.ts already registered its handler, let it handle toggle;
    // our toggle would duplicate. Check for existing .controls expand buttons.
    const hasRenderExpand = !!document.querySelector(".controls button");
    if (hasRenderExpand) return;
    toggle();
  });
}
