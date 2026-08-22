// AI assist UI wiring:
//   ⚙ gear button (fixed, top-right) → settings modal
//   per-word "AI 精译 / AI Translate" button inside the word side panel
//   small per-row "AI" button at the end of every line/unit (reader + paste)
//
// render.ts stays untouched: a MutationObserver sweeps the DOM for
// .side-panel/.panel-body and .line/.prose-unit containers and attaches
// buttons idempotently (data-ai attributes prevent re-attachment loops).
// Everything is built with createElement/textContent — no innerHTML.

import {
  buildMessages,
  callLLM,
  isReady,
  loadConfig,
  type PromptContext,
} from "./llm";
import { openSettings } from "./settings";

export function initLLM(): void {
  installGear();
  installSweeper();
  // Abort in-flight streams when navigating between routes.
  window.addEventListener("hashchange", () => abortAll());
}

/* ---------------- gear button ---------------- */

function installGear(): void {
  const gear = document.createElement("button");
  gear.id = "ai-gear";
  gear.className = "ai-gear";
  gear.setAttribute("aria-label", "AI settings");
  gear.title = "AI 设置 / AI Settings";
  gear.textContent = "⚙";
  let spin = false;
  gear.addEventListener("click", () => {
    if (!spin) openSettings({ hint: hintIfUnconfigured() });
    spin = false;
  });
  document.body.appendChild(gear);
}

function hintIfUnconfigured(): string | undefined {
  return loadConfig().apiKey
    ? undefined
    : "No API key configured yet — fill in Base URL, Key and Model below.";
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
  btn.className = "ai-btn ai-btn-word";
  btn.textContent = "AI 精译 / AI Translate";

  const out = makeOutput();
  btn.addEventListener("click", () => {
    const ctx = contextFromPanel(body as HTMLElement);
    runAI(btn, out, ctx);
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
    btn.className = "ai-btn ai-btn-line";
    btn.textContent = "AI";
    btn.title = "AI 精译 / AI Translate this line";
    btn.addEventListener("click", () => {
      // fresh output area per click, below the parse cards
      const old = row.querySelector(":scope > .ai-out");
      if (old) old.remove();
      const out = makeOutput();
      row.appendChild(out.root);
      const ctx = contextFromRow(row as HTMLElement);
      runAI(btn, out, ctx);
    });
    row.appendChild(btn);
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
  const word =
    body.querySelector("h2")?.textContent?.trim() ?? "";
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
  return { sentence: rowSentence(row), word: "", parses, glosses };
}

/* ---------------- execution + rendering ---------------- */

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

async function runAI(
  btn: HTMLButtonElement,
  out: OutputRefs,
  ctx: PromptContext,
): Promise<void> {
  // No key configured → open Settings with an explanatory hint instead.
  if (!loadConfig().apiKey || !isReady()) {
    openSettings({ hint: hintIfUnconfigured() });
    return;
  }

  const cfg = loadConfig();
  const setTitle = out.setTitle;
  const setCtrl = out.setCtrl;
  setTitle(`AI · ${cfg.model || "model"} · ${cfg.baseUrl}`);

  btn.disabled = true;
  out.root.classList.remove("hidden");
  out.answer.textContent = "";
  out.status.className = "ai-status";
  out.status.textContent = "Thinking…";

  const ctrl = new AbortController();
  controllers.add(ctrl);
  setCtrl(ctrl);

  try {
    await callLLM(buildMessages(ctx), {
      stream: true,
      signal: ctrl.signal,
      onDelta: (piece) => {
        out.answer.textContent += piece; // progressive, textContent-only
        out.status.textContent = "";
      },
    });
    out.status.className = "ai-status ai-ok";
    out.status.textContent = "Done.";
  } catch (e) {
    const err = e as Error;
    if (err.name === "AbortError") {
      out.status.className = "ai-status";
      out.status.textContent = "Cancelled.";
    } else {
      out.status.className = "ai-status ai-error";
      out.status.textContent = `Failed: ${err.message}`;
    }
  } finally {
    controllers.delete(ctrl);
    btn.disabled = false;
  }
}
