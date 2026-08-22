// Paste & Parse: client-side tokenization, then the shared interlinear
// renderer against the same static shards.
import { stripAccents } from "./api";
import { prepare, renderLines } from "./render";

// edge punctuation to trim; apostrophes are kept when internal (elision)
const PUNCT = ",.;:·«»()[]\"‘’“”!?—–-/";

export function tokenize(text: string): string[] {
  return text
    .split(/\s+/)
    .map((raw) => {
      let w = raw;
      while (w.length && PUNCT.includes(w[0])) w = w.slice(1);
      while (w.length && PUNCT.includes(w[w.length - 1])) {
        // keep elision apostrophes attached: ’ / ' / ʼ
        if (
          /[ʼ’']$/.test(w) &&
          w.length >= 2 &&
          !PUNCT.includes(w[w.length - 2])
        ) {
          break;
        }
        w = w.slice(0, -1);
      }
      return w;
    })
    .filter((w) => w.length > 0 && /[\u0370-\u03ff\u1f00-\u1fff]/.test(w));
}

export function initPaste(root: HTMLElement, onBack: () => void): void {
  root.replaceChildren();

  const nav = document.createElement("button");
  nav.textContent = "← Home";
  nav.addEventListener("click", onBack);
  root.appendChild(nav);

  const h1 = document.createElement("h1");
  h1.textContent = "Paste & Parse";
  root.appendChild(h1);

  const p = document.createElement("p");
  p.className = "subtitle";
  p.textContent = "Paste Ancient Greek text; every token is analysed with " +
    "Morpheus and glossed with LSJ.";
  root.appendChild(p);

  const ta = document.createElement("textarea");
  ta.placeholder = "μῆνιν ἄειδε θεὰ Πηληϊάδεω Ἀχιλῆος…";
  root.appendChild(ta);

  const btn = document.createElement("button");
  btn.className = "primary";
  btn.textContent = "Analyze";
  root.appendChild(btn);

  const note = document.createElement("p");
  note.className = "unparsed-note";
  root.appendChild(note);

  const out = document.createElement("div");
  root.appendChild(out);

  btn.addEventListener("click", async () => {
    const tokens = tokenize(ta.value);
    out.replaceChildren();
    if (tokens.length === 0) {
      note.textContent = "No Greek tokens found.";
      return;
    }
    btn.disabled = true;
    note.textContent = "Analysing…";
    try {
      const ctx = await prepare([{ n: "1", words: tokens }]);
      renderLines(out, [{ n: "1", words: tokens }], ctx);
      const unparsed = tokens.filter(
        (t) => !(ctx.morph.get(stripAccents(t)) ?? []).length,
      ).length;
      note.textContent =
        `${tokens.length} tokens analysed` +
        (unparsed ? ` · ${unparsed} not found in Morpheus` : " · all parsed");
    } catch (e) {
      note.textContent = `Analysis failed: ${(e as Error).message}`;
    } finally {
      btn.disabled = false;
    }
  });
}
