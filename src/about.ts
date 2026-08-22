// About page: data sources & licenses, tech stack, acknowledgments.
// Facts mirror README.md so the page stays consistent with repo docs.
// Built exclusively with textContent — no innerHTML anywhere.

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

function licenseList(): El {
  const ul = el("ul", "about-list");

  ul.appendChild(li(
    "Morphological analysis — Morpheus, Perseus Digital Library, Tufts " +
    "University (CC BY-SA 3.0 US). Local build patches are recorded in " +
    "third_party/morpheus-patches/.",
  ));
  ul.appendChild(li(
    "Glosses — Liddell & Scott (rev. Jones), A Greek–English Lexicon, " +
    "9th ed., Oxford: Clarendon Press, 1940. Digitized text courtesy of " +
    "the LSJLogeion project by Helma Dik / Logeion (University of Chicago), " +
    "CC BY-SA 4.0, and of the Perseus Digital Library, Tufts University, " +
    "CC BY-SA 3.0 US. We credit both Perseus (Tufts) and Helma Dik / " +
    "Logeion, as the maintainers request.",
  ));
  ul.appendChild(li(
    "Greek text — classical corpus (Homer through Plutarch and adjacent " +
    "2nd-century authors) — PerseusDL/canonical-greekLit (TEI XML, CTS " +
    "URNs), CC BY-SA 3.0; editions are cited per work in catalog.json.",
  ));
  ul.appendChild(li(
    "Greek text — New Testament — Novum Testamentum Graece, Westcott & " +
    "Hort (Cambridge, 1881); Greek text public domain, TEI encoding via " +
    "PerseusDL/canonical-greekLit (CC BY-SA 3.0). The restricted-licence " +
    "SBLGNT edition is deliberately not used.",
  ));
  ul.appendChild(li(
    "Greek text — Septuagint — Septuaginta, ed. Henry Barclay Swete " +
    "(Cambridge, 1895–1907, public domain), transcribed in TEI by the " +
    "OpenGreekAndLatin/First1KGreek project with the University of " +
    "Leipzig / Open Greek & Latin, CC BY-SA 4.0. 55 books, Genesis " +
    "through Bel et Draco.",
  ));
  ul.appendChild(li(
    "Greek text — Philo, Nicander, Epicurus, pseudo-Menander — also from " +
    "OpenGreekAndLatin/First1KGreek (CC BY-SA 4.0).",
  ));
  ul.appendChild(li(
    "English translations, where present in a work's catalog metadata, " +
    "carry their own translator, year and license line (shown in the " +
    "translation panel header); e.g. public-domain editions such as the " +
    "KJV (1769) or Brenton's Septuagint translation (1844).",
  ));
  ul.appendChild(li(
    "All code in this repository — MIT (see LICENSE). The data under " +
    "public/data/ derives from CC BY-SA sources and is distributed under " +
    "the corresponding ShareAlike terms.",
  ));
  return ul;
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

  app.appendChild(lexiconBackNote());

  app.appendChild(h2("Data sources & licenses"));
  app.appendChild(licenseList());

  app.appendChild(h2("Tech stack"));
  app.appendChild(p(
    "The site is plain HTML/JS/CSS built with Vite and esbuild and written " +
    "in TypeScript; Playwright drives its interaction tests. Morphology is " +
    "precomputed at build time by a locally patched Morpheus cruncher " +
    "(~350k unique corpus forms) into static JSON shards keyed by " +
    "accent-stripped lookup; texts load part-by-part as you read. There is " +
    "no server, database or tracker: any static host works. An optional " +
    "Cloudflare Pages Function passes live morphology queries through to " +
    "the Tufts service, and a bring-your-own-key LLM relay keeps API keys " +
    "client-side.",
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
