// About page: data sources & licenses, tech stack, acknowledgments.
// Facts mirror README.md so the page stays consistent with repo docs.
// Built exclusively with textContent — no innerHTML anywhere.

import { exportJSON as exportVocab, importJSON as importVocab } from "./vocab";
import {
  exportJSON as exportBookmarks,
  importJSON as importBookmarks,
} from "./bookmarks";

type El = HTMLElement;
const el = (tag: string, cls?: string, text?: string): El => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text; // never innerHTML
  return e;
};

const h2 = (t: string): El => el("h2", undefined, t);
const p = (t: string): El => el("p", "about-p", t);
const li = (t: string): El => el("li", undefined, t);
const aLink = (href: string, text: string): El => {
  const a = el("a") as HTMLAnchorElement;
  a.href = href;
  a.textContent = text;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  return a;
};
function liWithLinks(parts: Array<string | El>): El {
  const item = el("li");
  for (const part of parts) {
    if (typeof part === "string") item.appendChild(document.createTextNode(part));
    else item.appendChild(part);
  }
  return item;
}

function licenseList(): El {
  const ul = el("ul", "about-list");
  ul.appendChild(liWithLinks([
    "Morphological analysis — ",
    aLink("https://github.com/PerseusDL/morpheus", "Morpheus"),
    ", Perseus Digital Library, Tufts University (",
    aLink("https://creativecommons.org/licenses/by-sa/3.0/us/", "CC BY-SA 3.0 US"),
    "). Local build patches in ",
    aLink("https://github.com/PerseusDL/morpheus", "third_party/morpheus-patches/"),
    ".",
  ]));
  ul.appendChild(liWithLinks([
    "Glosses — Liddell & Scott (rev. Jones), A Greek–English Lexicon, 9th ed., Oxford 1940. Digitized by ",
    aLink("https://github.com/helmadik/LSJLogeion", "LSJLogeion"),
    " (Helma Dik / Logeion, Univ. of Chicago, ",
    aLink("https://creativecommons.org/licenses/by-sa/4.0/", "CC BY-SA 4.0"),
    ") and ",
    aLink("https://www.perseus.tufts.edu", "Perseus Digital Library"),
    " (Tufts, ",
    aLink("https://creativecommons.org/licenses/by-sa/3.0/us/", "CC BY-SA 3.0 US"),
    "); we credit both as requested.",
  ]));
  ul.appendChild(liWithLinks([
    "Greek text — classical corpus (Homer through Plutarch + adjacent 2nd-c. AD) — ",
    aLink("https://github.com/PerseusDL/canonical-greekLit", "PerseusDL/canonical-greekLit"),
    " (TEI XML, CTS URNs, ",
    aLink("https://creativecommons.org/licenses/by-sa/3.0/", "CC BY-SA 3.0"),
    "); editions cited per work in catalog.json.",
  ]));
  ul.appendChild(liWithLinks([
    "Greek text — New Testament — Novum Testamentum Graece, Westcott & Hort (Cambridge 1881); Greek text public domain, TEI via ",
    aLink("https://github.com/PerseusDL/canonical-greekLit", "canonical-greekLit"),
    " (CC BY-SA 3.0). The restricted-licence SBLGNT is deliberately not used.",
  ]));
  ul.appendChild(liWithLinks([
    "Greek text — Septuagint — Septuaginta, ed. Henry Barclay Swete (Cambridge 1895–1907, public domain), TEI by ",
    aLink("https://github.com/OpenGreekAndLatin/First1KGreek", "OpenGreekAndLatin/First1KGreek"),
    " (with Leipzig / Open Greek & Latin, ",
    aLink("https://creativecommons.org/licenses/by-sa/4.0/", "CC BY-SA 4.0"),
    "). 55 books, Genesis through Bel et Draco.",
  ]));
  ul.appendChild(liWithLinks([
    "Greek text — Philo, Nicander, Epicurus, pseudo-Menander — also from ",
    aLink("https://github.com/OpenGreekAndLatin/First1KGreek", "First1KGreek"),
    " (CC BY-SA 4.0).",
  ]));
  ul.appendChild(liWithLinks([
    "English — King James Version (KJV, 1769 standard text), via ",
    aLink("https://github.com/aruljohn/Bible-kjv", "aruljohn/Bible-kjv"),
    " JSON mirror; public domain. Covers all 27 NT books; Septuagint English is Brenton, not KJV.",
  ]));
  ul.appendChild(liWithLinks([
    "English — Septuagint — Sir Lancelot C. L. Brenton, tr. (Samuel Bagster, London 1844; Apocrypha 1851), via ",
    aLink("https://ebible.org/find/show.php?id=engBrenton", "eBible.org"),
    " USFX; public domain. Used for ~50 Septuagint books.",
  ]));
  ul.appendChild(liWithLinks([
    "English — classical translations (354 works) — paired editions from ",
    aLink("https://github.com/PerseusDL/canonical-greekLit", "canonical-greekLit"),
    " (e.g. Murray's Homer 1924, Godley's Hdt. 1920, Crawley's Thuc. 1914, Jebb, Smyth, Fowler); only imprints \u2264 1929 are ingested, public domain, translator/year/license per work.",
  ]));
  ul.appendChild(liWithLinks([
    "Code — dual-licensed MIT OR Apache-2.0 at your choice (see ",
    aLink("https://github.com/hu00yan/greek-reader/blob/main/LICENSE", "LICENSE"),
    ", ",
    aLink("https://github.com/hu00yan/greek-reader/blob/main/LICENSE-MIT", "LICENSE-MIT"),
    ", ",
    aLink("https://github.com/hu00yan/greek-reader/blob/main/LICENSE-APACHE", "LICENSE-APACHE"),
    "); SPDX MIT OR Apache-2.0. Data under public/data/ remains CC BY-SA ShareAlike, separate from code.",
  ]));
  return ul;
}

function inspirationList(): El {
  const ul = el("ul", "about-list");
  ul.appendChild(liWithLinks([
    aLink("https://www.nodictionaries.com", "nodictionaries.com"),
    " — early interlinear word-by-word gloss model; showed demand for instant parse+gloss under each word.",
  ]));
  ul.appendChild(liWithLinks([
    aLink("https://github.com/johnhboyer-sys/plato-reader", "johnhboyer-sys/plato-reader"),
    " — minimal static reader that pairs Greek sentences with Perseus morphology; informed our static-JSON, no-backend approach.",
  ]));
  ul.appendChild(liWithLinks([
    aLink("https://scaife.perseus.org", "scaife.perseus.org"),
    " (Scaife Viewer) — Perseus's CTS/TEI reading environment; reference for CTS URNs, passage references, and translation alignment UX.",
  ]));
  ul.appendChild(li(
    "These sites inspired the UX goal — click any word for full Morpheus + LSJ — but this project builds its own offline-first pipeline and interlinear layout.",
  ));
  return ul;
}

function dependencyList(): El {
  const ul = el("ul", "about-list");
  ul.appendChild(liWithLinks([
    aLink("https://vitejs.dev", "Vite"),
    " 6.x (MIT) — dev server + production bundler (Rollup + esbuild); emits dist/ + precompressed .gz/.br.",
  ]));
  ul.appendChild(liWithLinks([
    aLink("https://www.typescriptlang.org", "TypeScript"),
    " 5.6+ (Apache-2.0) — static typing; no runtime dependency, compiled away by Vite.",
  ]));
  ul.appendChild(liWithLinks([
    aLink("https://github.com/ianmarmour/espeak-ng.js", "espeak-ng"),
    " 1.0.2 (GPL-3.0-or-later) — Ancient Greek TTS; grc voice via WASM (public/espeak-ng.wasm, loaded dynamically, not MIT/Apache; see LICENSE). Fallback is Web Speech API (browser, no dep).",
  ]));
  ul.appendChild(liWithLinks([
    aLink("https://playwright.dev", "playwright-core"),
    " 1.49+ (Apache-2.0 / MIT) — browser automation for interaction tests (not shipped to users).",
  ]));
  ul.appendChild(liWithLinks([
    aLink("https://esbuild.github.io", "esbuild"),
    " (MIT, via Vite) — fast JS/TS bundling and minification; transitive via Vite.",
  ]));
  ul.appendChild(liWithLinks([
    aLink("https://rollupjs.org", "Rollup"),
    " (MIT, via Vite) — production chunking; transitive via Vite.",
  ]));
  ul.appendChild(li(
    "No runtime tracking, no database, no server framework — all data is static JSON fetched lazily per page.",
  ));
  return ul;
}

function forkGuide(): El {
  const wrap = el("div");
  wrap.appendChild(p(
    "Fork-friendly: this repo is static. To make your own version:",
  ));
  const ol = el("ol", "about-list") as HTMLOListElement;
  const steps = [
    "Fork on GitHub and clone; npm install.",
    "Replace or extend the corpus: edit pipeline/make_manifest.py (change the two source GitHub repos / CTS prefixes) or add TEI files to .cache-corpus/texts/.",
    "Rebuild: python3 pipeline/fetch_sources.py && python3 pipeline/build_corpus.py && python3 pipeline/build_glosses.py && python3 pipeline/build_translations.py — outputs to public/data/.",
    "Rebuild morphology only if needed: requires the patched Morpheus cruncher in third_party/morpheus-patches/ (see pipeline/build_corpus.py header).",
    "Customize UI: src/style.css + src/render.ts (interlinear), src/tts.ts (voice), src/translation.ts (translations).",
    "Configure deploy: wrangler.toml for Cloudflare Pages, or any static host (dist/ is self-contained). Keep public/data/ licenses intact and preserve CC BY-SA attribution if you redistribute data.",
  ];
  for (const s of steps) {
    const item = el("li", undefined, s);
    ol.appendChild(item);
  }
  wrap.appendChild(ol);
  wrap.appendChild(p(
    "Code contributions are accepted under MIT OR Apache-2.0 (see LICENSE). Data contributions must remain compatible with CC BY-SA ShareAlike of their sources.",
  ));
  return wrap;
}

function yourData(): El {
  const wrap = el("div", "about-yourdata");
  wrap.appendChild(p(
    "Your vocabulary book and bookmarks live only in this browser's " +
    "localStorage — nothing is uploaded. Export them as JSON to back up or " +
    "move to another device; importing merges without overwriting.",
  ));
  const row = el("p", "yourdata-row");

  const mkDownload = (
    label: string,
    name: string,
    dump: () => string,
  ): HTMLButtonElement => {
    const b = el("button", "yourdata-btn") as HTMLButtonElement;
    b.type = "button";
    b.textContent = label;
    b.addEventListener("click", () => {
      const blob = new Blob([dump()], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
    return b;
  };

  const mkImport = (
    label: string,
    merge: (text: string) => { added: number; bad: boolean },
  ): El => {
    const wrapBtn = el("span");
    const b = el("button", "yourdata-btn") as HTMLButtonElement;
    b.type = "button";
    b.textContent = label;
    const input = document.createElement("input") as HTMLInputElement;
    input.type = "file";
    input.accept = ".json,application/json";
    input.hidden = true;
    const status = el("span", "yourdata-status");
    b.addEventListener("click", () => input.click());
    input.addEventListener("change", () => {
      const file = input.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (): void => {
        const res = merge(String(reader.result ?? ""));
        status.textContent = res.bad
          ? "Import failed: not a valid file."
          : `Imported ${res.added} new item${res.added === 1 ? "" : "s"}.`;
      };
      reader.readAsText(file);
      input.value = "";
    });
    wrapBtn.appendChild(b);
    wrapBtn.appendChild(input);
    wrapBtn.appendChild(status);
    return wrapBtn;
  };

  row.appendChild(mkDownload(
    "Export vocabulary",
    "greek-reader-vocab.json",
    exportVocab,
  ));
  row.appendChild(mkImport("Import vocabulary…", importVocab));
  row.appendChild(mkDownload(
    "Export bookmarks",
    "greek-reader-bookmarks.json",
    exportBookmarks,
  ));
  row.appendChild(mkImport("Import bookmarks…", importBookmarks));
  wrap.appendChild(row);
  return wrap;
}

export function renderAbout(app: HTMLElement): void {
  app.replaceChildren();

  app.appendChild(el("h1", undefined, "About Greek Reader"));
  app.appendChild(p(
    "An interlinear reading environment for Ancient Greek — Homer through " +
    "Plutarch, the New Testament and the Septuagint — with a Morpheus " +
    "morphological analysis and an LSJ gloss aligned under every word, " +
    "entirely from static JSON, with no backend.",
  ));

  app.appendChild(repoBanner(app));
  app.appendChild(lexiconBackNote());

  app.appendChild(h2("Data sources & licenses"));
  app.appendChild(licenseList());

  app.appendChild(h2("Inspiration & reference sites"));
  app.appendChild(p(
    "Early models for interlinear Greek and CTS-based reading that informed the design:",
  ));
  app.appendChild(inspirationList());

  app.appendChild(h2("Tech stack & dependencies"));
  app.appendChild(p(
    "Plain HTML/JS/CSS, TypeScript, Vite/esbuild. Morphology is precomputed at build time by a locally patched Morpheus cruncher " +
    "(~350k unique forms) into alphabet-sharded JSON keyed by accent-stripped lookup; texts load part-by-part as you read. No server, DB or tracker — any static host works. " +
    "Optional Cloudflare Pages Functions proxy live morphology to Tufts and relay BYO-key LLM calls (keys stay client-side). Offline TTS is on-device espeak-ng WASM (grc, reconstructed; per-line \uD83D\uDD0A and global Play/Pause/Stop, cached by the service worker, with a labelled modern-Greek Web Speech fallback only if grc is unavailable).",
  ));
  app.appendChild(dependencyList());

  app.appendChild(h2("Fork it — make your own"));
  const forkHead = app.lastElementChild as HTMLElement;
  forkHead.id = "fork-it";
  app.appendChild(forkGuide());

  app.appendChild(h2("Your vocabulary & bookmarks"));
  app.appendChild(p(
    "Reading features: tap any word and use “Mark known ✓” to dim words you " +
    "know, switch the toolbar Vocab toggle to highlight what is left, star " +
    "lines to bookmark them, and share ?ref= deep links to exact verses.",
  ));
  app.appendChild(yourData());

  app.appendChild(h2("Development method"));
  app.appendChild(p(
    "Spec-first, pipeline-driven: pipeline/*.py (stdlib-only Python) are the source of truth for corpus, morphology and glosses; the web app (src/) is a thin reader over the emitted static JSON. " +
    "Changes flow pipeline \u2192 public/data/ \u2192 Vite build \u2192 dist/. Tests are Playwright-driven interaction checks; no backend mocks needed because data is committed.",
  ));

  app.appendChild(h2("Acknowledgments"));
  app.appendChild(p(
    "With thanks to the Perseus Digital Library team at Tufts — Gregory " +
    "Crane, Lisa Cerrato, and the many contributors over three decades — " +
    "whose texts and tools underpin this project; to the Open Greek & " +
    "Latin / First1KGreek community (and its Leipzig partners) for the " +
    "Swete Septuagint, Philo and other texts; to Helma Dik and the " +
    "Logeion project at the University of Chicago for the digitized LSJ; " +
    "to the Morpheus maintainers and contributors for the analyzer that " +
    "still has no rival for Ancient Greek; and to every editor whose " +
    "public-domain critical editions — from Monro & Allen's Homer to " +
    "Swete's Septuagint and Westcott & Hort's Greek New Testament — made " +
    "this corpus possible.",
  ));
}

/** Small footer nav shared by home/about. */
export function aboutLink(): El {
  const a = el("a", "about-link") as HTMLAnchorElement;
  a.href = "#/about";
  a.textContent = "About · sources & licenses";
  return a;
}

function lexiconBackNote(): El {
  const pEl = el("p", "subtitle");
  const back = el("a") as HTMLAnchorElement;
  back.href = "#/";
  back.textContent = "← Back to the catalog";
  pEl.appendChild(back);
  return pEl;
}

/** Prominent repo banner at the top of About: git-branch icon, repo link,
 *  issue link, and a smooth-scroll "fork" shortcut to the guide below.
 *  textContent/NS-elements only — never innerHTML. */
const REPO_URL = "https://github.com/hu00yan/greek-reader";

function gitBranchIcon(): SVGElement {
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("width", "18");
  svg.setAttribute("height", "18");
  svg.setAttribute("aria-hidden", "true");
  // git-branch: two circles + trunk + branch line (octocat-free, simple)
  const shapes: Array<[string, Record<string, string>]> = [
    ["path", { d: "M5 3.25a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0Zm0 2.122a2.25 2.25 0 1 0-1.5 0v5.256a2.251 2.251 0 1 0 1.5 0V5.372ZM8.25 6a.75.75 0 0 1 .75.75v4.36a2.251 2.251 0 1 0 1.5 0V9A2.5 2.5 0 0 0 8 6.5H6.75a.75.75 0 0 1 0-1.5H8A2.5 2.5 0 0 0 10.5 2.75v-.36a2.25 2.25 0 1 1 1.5 0v.36c0 .98-.402 1.865-1.05 2.5A2.5 2.5 0 0 0 9.5 5h-.75a.75.75 0 0 1-.75-.75Z", fill: "currentColor" }],
  ];
  for (const [tag, attrs] of shapes) {
    const node = document.createElementNS(NS, tag);
    for (const k of Object.keys(attrs)) node.setAttribute(k, attrs[k]);
    svg.appendChild(node);
  }
  return svg;
}

function repoBanner(app: HTMLElement): El {
  const card = el("div", "repo-banner");

  const main = el("a", "repo-banner-main") as HTMLAnchorElement;
  main.href = REPO_URL;
  main.target = "_blank";
  main.rel = "noopener noreferrer";
  main.appendChild(gitBranchIcon());
  const text = el("span", "repo-banner-text");
  const strong = el("strong", undefined, "Open source");
  text.appendChild(strong);
  text.appendChild(document.createTextNode(
    " · github.com/hu00yan/greek-reader",
  ));
  main.appendChild(text);
  card.appendChild(main);

  const actions = el("span", "repo-banner-actions");
  actions.appendChild(aLink(`${REPO_URL}/issues`, "Report an issue"));

  const forkLink = el("a", "repo-banner-fork") as HTMLAnchorElement;
  forkLink.href = "#fork-it"; // hash router must NOT see this — handled below
  forkLink.textContent = "Fork & build your own";
  forkLink.addEventListener("click", (e) => {
    e.preventDefault(); // keep "#fork-it" out of the router's location.hash
    app.querySelector("#fork-it")?.scrollIntoView({ behavior: "smooth" });
  });
  actions.appendChild(forkLink);
  card.appendChild(actions);

  return card;
}
