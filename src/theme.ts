// Three-state theme (Auto/Light/Dark). Auto follows prefers-color-scheme.
// Choice persists in localStorage ("greek-reader.theme"); applied via
// [data-theme] on <html> so only colors change — no layout shift.

export type ThemeChoice = "auto" | "light" | "dark";
const KEY = "greek-reader.theme";

const mq = window.matchMedia("(prefers-color-scheme: dark)");

function choice(): ThemeChoice {
  const v = localStorage.getItem(KEY);
  return v === "light" || v === "dark" ? v : "auto";
}

/** Resolve the effective theme and reflect it on the document. */
function apply(): void {
  const c = choice();
  const dark = c === "dark" || (c === "auto" && mq.matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
}

export function setTheme(c: ThemeChoice): void {
  localStorage.setItem(KEY, c);
  apply();
}

// keep Auto live if the OS flips while the page is open
mq.addEventListener?.("change", () => {
  if (choice() === "auto") apply();
});

// apply persisted choice immediately at module load
apply();

/** Segmented Auto/Light/Dark control for headers. */
export function themeControl(): HTMLElement {
  const wrap = document.createElement("span");
  wrap.className = "theme-ctl";
  wrap.setAttribute("role", "group");
  wrap.setAttribute("aria-label", "Color theme");
  const mk = (label: string, value: ThemeChoice) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    b.setAttribute("aria-pressed", String(choice() === value));
    b.addEventListener("click", () => {
      setTheme(value);
      for (const btn of Array.from(wrap.children)) {
        (btn as HTMLElement).setAttribute(
          "aria-pressed",
          String(btn === b),
        );
      }
    });
    return b;
  };
  wrap.appendChild(mk("Auto", "auto"));
  wrap.appendChild(mk("Light", "light"));
  wrap.appendChild(mk("Dark", "dark"));
  return wrap;
}
