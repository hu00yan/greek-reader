// AI assist UI wiring:
//   ⚙ gear button + active-profile dropdown (fixed, top-right) → settings
//   per-word "AI 精译 / AI Translate" button inside the word side panel
//   small per-row "AI" button at the end of every line/unit (reader + paste)
//
// render.ts stays untouched: a MutationObserver sweeps the DOM for
// .side-panel/.panel-body and .line/.prose-unit containers and attaches
// buttons idempotently (data-ai attributes prevent re-attachment loops).
//
// Anti-runaway invariant: runAI() asserts event.isTrusted — every LLM call
// originates from ONE real user click; there is no bulk/loop path.
//
// Everything is built with createElement/textContent — no innerHTML.

import {
  MAX_DISPLAY_CHARS,
  RateLimitError,
  buildPrompt,
  callLLM,
  getActiveProfile,
  isReady,
  loadProfiles,
  setActiveProfile,
  type PromptContext,
} from "./llm";
import { openSettings } from "./settings";
import { initToolbarExtras } from "./toolbar-extras";

export function initLLM(): void {
  installGear();
  installSweeper();
  initToolbarExtras();
  // Abort in-flight streams when navigating between routes.
  window.addEventListener("hashchange", () => abortAll());
}

/* ---------------- gear + profile switcher ---------------- */

function installGear(): void {
  const wrap = document.createElement("div");
  wrap.id = "ai-gear-wrap";
  wrap.className = "ai-gear-wrap";

  const sel = document.createElement("select");
  sel.className = "ai-profile-select";
  sel.title = "Active AI profile";
  sel.setAttribute("aria-label", "Active AI profile");

  const refreshSel = (): void => {
    const st = loadProfiles();
    sel.replaceChildren();
    const active = getActiveProfile();
    for (const p of st.profiles) {
      const o = document.createElement("option");
      o.value = p.id;
      o.textContent =
        `${p.name} · ${p.model || "(no model)"}${p.id === st.defaultId ? " ★" : ""}`;
      if (p.id === active.id) sel.value = p.id;
      sel.appendChild(o);
    }
  };
  refreshSel();

  sel.addEventListener("change", () => {
    setActiveProfile(sel.value);
    refreshSel(); // re-render star/model info for the new active profile
  });
  (window as unknown as Record<string, unknown>).__refreshAiProfileSelect = refreshSel;

  const gear = document.createElement("button");
  gear.id = "ai-gear";
  gear.className = "ai-gear";
  gear.setAttribute("aria-label", "AI settings");
  gear.title = "AI 设置 / AI Settings";
  gear.textContent = "⚙";

  gear.addEventListener("click", () => {
    openSettings({
      hint: hintIfUnconfigured(),
      onSaved: refreshSel,
    });
  });

  wrap.append(gear, sel);
  document.body.appendChild(wrap);
}

function hintIfUnconfigured(): string | undefined {
  return isReady()
    ? undefined
    : "No API key configured yet — pick a protocol, fill in Key and Model.";
}

/* ---------------- DOM sweeper ---------------- */

let scheduled = false;

function installSweeper(): void {
  const sweep = (): void => {
    scheduled = false;
    attachWordButton();
    attachRowButtons();
  };
  const schedule = (): void => {
    if (!scheduled) {
      scheduled = true;
      requestAnimationFrame(sweep);
    }
  };
  new MutationObserver(schedule).observe(document.body, {
    childList: true,
    subtree: true,
  });
  schedule();
}

/** Side panel for the selected word → append AI block if not there yet. */
function attachWordButton(): void {
  const panel = document.querySelector(".side-panel:not(.hidden)");
  if (!panel) return;
  const body = panel.querySelector(".panel-body");
  if (!body || body.querySelector("[data-ai='word']")) return;

  const block = document.createElement("div");
  block.className = "ai-block";
  block.setAttribute("data-ai", "word");

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "ai-btn ai-btn-word";
  btn.textContent = "AI 精译 / AI Translate";

  const out = makeOutput();
  btn.addEventListener("click", (ev) => {
    assertTrusted(ev);
    const ctx = contextFromPanel(body as HTMLElement);
    void runAI(btn, out, ctx);
  });

  block.append(btn, out.root);
  body.appendChild(block);
}

/** Every reader/paste line or prose unit gets a tiny AI button at row end. */
function attachRowButtons(): void {
  const rows = document.querySelectorAll(
    ".line:not([data-ai]), .prose-unit:not([data-ai])",
  );
  for (const row of rows) {
    row.setAttribute("data-ai", "row");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "ai-btn ai-btn-line";
    btn.textContent = "AI";
    btn.title = "AI 精译 / AI Translate this line";
    btn.addEventListener("click", (ev) => {
      assertTrusted(ev);
      // fresh output area per click, below the parse cards
      const old = row.querySelector(":scope > .ai-out");
      if (old) old.remove();
      const out = makeOutput();
      row.appendChild(out.root);
      const ctx = contextFromRow(row as HTMLElement);
      void runAI(btn, out, ctx);
    });
    row.appendChild(btn);
  }
}

/** C2 enforcement point: refuse synthetic/programmatic clicks. */
function assertTrusted(ev: Event): void {
  if (!ev.isTrusted) {
    throw new Error("AI calls must originate from a real user click");
  }
}

/* ---------------- context extraction ---------------- */

/** Greek sentence text of a row, ref labels stripped. */
function rowSentence(row: HTMLElement): string {
  const greek = row.querySelector(".greek-line");
  if (!greek) return "";
  const clone = greek.cloneNode(true) as HTMLElement;
  clone.querySelectorAll(".ref-label, .ref-badge").forEach((n) => n.remove());
  return (clone.textContent ?? "").replace(/\s+/g, " ").trim();
}

function contextFromPanel(body: HTMLElement): PromptContext {
  const word = body.querySelector("h2")?.textContent?.trim() ?? "";
  const parses: string[] = [];
  const glosses: string[] = [];
  for (const entry of Array.from(body.querySelectorAll(".entry"))) {
    const lemma = entry.querySelector(".lemma")?.textContent?.trim() ?? "";
    const feats = entry.querySelector(".feats")?.textContent?.trim() ?? "";
    if (lemma || feats) parses.push([lemma, feats].filter(Boolean).join(" — "));
    const dg = entry.querySelector(".dict-gloss")?.textContent?.trim();
    if (dg) glosses.push(dg);
  }
  // Sentence context from the row the active word belongs to.
  const active = document.querySelector(".w.active");
  const row = active?.closest(".line, .prose-unit") as HTMLElement | null;
  const sentence = row ? rowSentence(row) : word;
  return { sentence, word, parses, glosses };
}

function contextFromRow(row: HTMLElement): PromptContext {
  const words = Array.from(row.querySelectorAll(".w"))
    .map((w) => w.textContent ?? "")
    .filter(Boolean);
  const parses: string[] = [];
  const glosses: string[] = [];
  for (const col of Array.from(row.querySelectorAll(".pcol"))) {
    const first = col.querySelector(".pcard");
    if (!first || first.classList.contains("pcard-unknown")) continue;
    const lemma = first.querySelector(".lemma")?.textContent?.trim() ?? "";
    const feats = first.querySelector(".feats")?.textContent?.trim() ?? "";
    if (lemma) parses.push([lemma, feats].filter(Boolean).join(" — "));
    const gl = first.querySelector(".gloss")?.textContent?.trim();
    if (gl) glosses.push(`${lemma}: ${gl}`);
  }
  void words;
  return { sentence: rowSentence(row), word: "", parses, glosses };
}

/* ---------------- output area ---------------- */

interface OutputRefs {
  root: HTMLElement;
  answer: HTMLElement;
  status: HTMLElement;
  setTitle: (t: string) => void;
  setCtrl: (c: AbortController | null) => void;
}

const controllers = new Set<AbortController>();

function abortAll(): void {
  for (const c of controllers) c.abort();
  controllers.clear();
}

function makeOutput(): OutputRefs {
  const root = document.createElement("div");
  root.className = "ai-out hidden";

  const head = document.createElement("div");
  head.className = "ai-out-head";
  const title = document.createElement("span");
  title.className = "ai-out-title";
  const close = document.createElement("button");
  close.type = "button";
  close.className = "ai-out-close";
  close.textContent = "×";
  close.setAttribute("aria-label", "Dismiss AI output");
  const holder: { ctrl: AbortController | null } = { ctrl: null };
  close.addEventListener("click", () => {
    holder.ctrl?.abort();
    root.remove();
  });
  head.append(title, close);

  const answer = document.createElement("div");
  answer.className = "ai-answer"; // plain textContent only

  const status = document.createElement("p");
  status.className = "ai-status";
  status.setAttribute("aria-live", "polite");

  root.append(head, answer, status);

  return {
    root,
    answer,
    status,
    setTitle: (t) => {
      title.textContent = t;
    },
    setCtrl: (c) => {
      holder.ctrl = c;
    },
  };
}

/* ---------------- execution ---------------- */

async function runAI(
  btn: HTMLButtonElement,
  out: OutputRefs,
  ctx: PromptContext,
): Promise<void> {
  // No usable profile → open Settings with an explanatory hint instead.
  if (!isReady()) {
    openSettings({ hint: hintIfUnconfigured() });
    return;
  }

  try {
    await execute(btn, out, ctx, false);
  } catch (e) {
    if (e instanceof RateLimitError) {
      const go = await confirmRate(e); // explicit consent modal
      if (go) {
        try {
          await execute(btn, out, ctx, true);
        } catch (e2) {
          showFailure(out, e2);
        }
      } else {
        out.status.className = "ai-status";
        out.status.textContent = "Cancelled by user.";
      }
    } else {
      showFailure(out, e);
    }
  }
}

async function execute(
  btn: HTMLButtonElement,
  out: OutputRefs,
  ctx: PromptContext,
  ignoreRateOnce: boolean,
): Promise<void> {
  const profile = getActiveProfile();
  out.setTitle(`AI · ${profile.name} · ${profile.model} · ${profile.protocol}`);
  btn.disabled = true;
  out.root.classList.remove("hidden");
  out.answer.textContent = "";
  out.status.className = "ai-status";
  out.status.textContent = "Thinking…";

  const ctrl = new AbortController();
  controllers.add(ctrl);
  out.setCtrl(ctrl);

  let displayed = 0;
  try {
    await callLLM(buildPrompt(ctx), {
      stream: true,
      signal: ctrl.signal,
      ignoreRateOnce,
      onDelta: (piece) => {
        // hard display cap (D): never paint more than MAX_DISPLAY_CHARS
        if (displayed >= MAX_DISPLAY_CHARS) return;
        const room = MAX_DISPLAY_CHARS - displayed;
        const part = piece.length > room ? piece.slice(0, room) : piece;
        displayed += part.length;
        out.answer.textContent += part; // textContent only
        if (piece.length > room) {
          out.status.textContent =
            `output truncated at ${MAX_DISPLAY_CHARS.toLocaleString()} chars`;
          ctrl.abort();
        } else {
          out.status.textContent = "";
        }
      },
    });
    out.status.className = "ai-status ai-ok";
    out.status.textContent =
      out.answer.textContent.length >= MAX_DISPLAY_CHARS
        ? `Done (truncated at ${MAX_DISPLAY_CHARS.toLocaleString()} chars).`
        : "Done.";
  } finally {
    controllers.delete(ctrl);
    btn.disabled = false;
  }
}

function showFailure(out: OutputRefs, e: unknown): void {
  const err = e as Error;
  if (err?.name === "AbortError") {
    out.status.className = "ai-status";
    out.status.textContent = "Cancelled.";
  } else {
    out.status.className = "ai-status ai-error";
    out.status.textContent = `Failed: ${err?.message ?? String(e)}`;
  }
}

/** Explicit-consent modal for exceeding the hourly cap (C1). */
function confirmRate(e: RateLimitError): Promise<boolean> {
  const backdrop = document.createElement("div");
  backdrop.className = "ai-modal-backdrop";
  const modal = document.createElement("div");
  modal.className = "ai-modal ai-modal-confirm";

  const h = document.createElement("h2");
  h.textContent = "Hourly limit reached";
  const mins = Math.ceil(e.resetMs / 60000);
  const p = document.createElement("p");
  p.className = "ai-hint";
  p.textContent =
    `You have used ${e.count}/${e.cap} AI calls in the last hour. ` +
    `The window frees up in ~${mins} min.`;
  const q = document.createElement("p");
  q.className = "ai-hint";
  q.textContent = "Proceed with one more call anyway?";
  const row = document.createElement("div");
  row.className = "ai-btn-row";
  const yes = document.createElement("button");
  yes.type = "button";
  yes.className = "ai-primary";
  yes.textContent = "Proceed once";
  const no = document.createElement("button");
  no.type = "button";
  no.className = "ai-secondary";
  no.textContent = "Cancel";
  row.append(yes, no);
  modal.append(h, p, q, row);
  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);

  return new Promise<boolean>((resolve) => {
    const done = (v: boolean): void => {
      backdrop.remove();
      resolve(v);
    };
    yes.addEventListener("click", () => done(true));
    no.addEventListener("click", () => done(false));
    backdrop.addEventListener("mousedown", (ev) => {
      if (ev.target === backdrop) done(false);
    });
  });
}
