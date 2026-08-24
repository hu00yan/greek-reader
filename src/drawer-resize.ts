// Shared drawer resizing — ONE implementation used by both drawers
// (lexicon left / translation right). Previously duplicated in main.ts and
// translation.ts; the copies had drifted, which is why the 8px gutter
// sometimes appeared dead. Consolidated + rewritten on Pointer Events with
// pointer capture (one code path for mouse/touch/pen, no stuck-drag states).
//
// Width model: --drawer-width on <html>, clamped [280px, 60vw], persisted in
// localStorage("drawer-width"), consumed by:
//   body.lexicon-open #app        { margin-left: min(var(--drawer-width),94vw) }
//   body.translation-open #app    { margin-right: … }

type El = HTMLElement;

export const DRAWER_LS_KEY = "drawer-width";
export const DRAWER_MIN_PX = 280;
export const DRAWER_MAX_VW = 0.6;

export function clampDrawerWidth(px: number): number {
  const max = window.innerWidth * DRAWER_MAX_VW;
  return Math.max(DRAWER_MIN_PX, Math.min(max, px));
}

export function setDrawerWidthPx(px: number): void {
  const clamped = clampDrawerWidth(px);
  document.documentElement.style.setProperty("--drawer-width", `${clamped}px`);
  try { localStorage.setItem(DRAWER_LS_KEY, String(clamped)); } catch {}
  // notify tests / other consumers
  try { (window as unknown as Record<string, unknown>).__drawerWidth = clamped; } catch {}
}

export function getDrawerWidthPx(): number {
  const raw = getComputedStyle(document.documentElement)
    .getPropertyValue("--drawer-width")
    .trim();
  if (raw.endsWith("px")) {
    const n = parseFloat(raw);
    if (!Number.isNaN(n)) return n;
  }
  if (raw.endsWith("rem")) {
    const n = parseFloat(raw);
    if (!Number.isNaN(n)) {
      return n * parseFloat(getComputedStyle(document.documentElement).fontSize || "16");
    }
  }
  try {
    const ls = localStorage.getItem(DRAWER_LS_KEY);
    if (ls) {
      const n = parseFloat(ls);
      if (!Number.isNaN(n)) return clampDrawerWidth(n);
    }
  } catch {}
  return 384; // 24rem default
}

/** Apply any saved width once at startup; re-clamp on viewport resize. */
export function initDrawerWidth(): void {
  try {
    const ls = localStorage.getItem(DRAWER_LS_KEY);
    if (ls) {
      const n = parseFloat(ls);
      if (!Number.isNaN(n)) {
        document.documentElement.style.setProperty(
          "--drawer-width",
          `${clampDrawerWidth(n)}px`,
        );
      }
    }
  } catch {}
  try {
    (window as unknown as Record<string, unknown>).__setDrawerWidth = setDrawerWidthPx;
    (window as unknown as Record<string, unknown>).__getDrawerWidth = getDrawerWidthPx;
  } catch {}
  window.addEventListener("resize", () => {
    const cur = getDrawerWidthPx();
    const clamped = clampDrawerWidth(cur);
    if (clamped !== cur) setDrawerWidthPx(clamped);
  });
}

/**
 * Attach an 8px draggable gutter to `panel`.
 * Idempotent: a second call on a panel that already has a handle is a no-op,
 * so the MutationObserver/interval watchers in main.ts never double-bind.
 */
export function attachDrawerResize(panel: El, side: "left" | "right"): void {
  if (panel.querySelector(".resize-handle")) return;
  const handle = document.createElement("div");
  handle.className = "resize-handle";
  handle.setAttribute("aria-label", "Resize drawer");
  handle.setAttribute("role", "separator");
  handle.setAttribute("aria-orientation", "vertical");
  handle.setAttribute("data-testid", `drawer-gutter-${side}`);
  handle.tabIndex = 0;
  panel.appendChild(handle);

  const applyDrag = (clientX: number): void => {
    // Right drawer grows leftward (width = innerWidth - x); left drawer grows
    // rightward (width = x). Delta fallback keeps the grab point stable when
    // the pointer jumps (edge cases, multi-monitor).
    const newAbs = side === "right" ? window.innerWidth - clientX : clientX;
    if (newAbs < DRAWER_MIN_PX * 0.4 || newAbs > window.innerWidth) return;
    setDrawerWidthPx(newAbs);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  };

  handle.addEventListener("pointerdown", (e: PointerEvent) => {
    if (!e.isPrimary) return;
    e.preventDefault();
    handle.classList.add("dragging");
    panel.style.transition = "none";
    try { handle.setPointerCapture(e.pointerId); } catch {}
    applyDrag(e.clientX);
  });
  handle.addEventListener("pointermove", (e: PointerEvent) => {
    if (!handle.classList.contains("dragging")) return;
    e.preventDefault();
    applyDrag(e.clientX);
  });
  const endDrag = (e: PointerEvent): void => {
    if (!handle.classList.contains("dragging")) return;
    handle.classList.remove("dragging");
    panel.style.transition = "";
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    try { handle.releasePointerCapture(e.pointerId); } catch {}
  };
  handle.addEventListener("pointerup", endDrag);
  handle.addEventListener("pointercancel", endDrag);
  // lostpointercapture fires even if release threw — belt and braces
  handle.addEventListener("lostpointercapture", () => {
    handle.classList.remove("dragging");
    panel.style.transition = "";
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  });

  // keyboard accessibility: ←/→ (or ↑/↓) nudges width by 24px
  handle.addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight" &&
      e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    e.preventDefault();
    const grow = side === "left"
      ? e.key === "ArrowRight" || e.key === "ArrowDown"
      : e.key === "ArrowLeft" || e.key === "ArrowUp";
    setDrawerWidthPx(getDrawerWidthPx() + (grow ? 24 : -24));
  });
}
