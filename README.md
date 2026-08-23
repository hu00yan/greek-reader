# Greek Reader

An interlinear reading environment for Ancient Greek. Read the whole
classical corpus — **Homer through Plutarch** (plus adjacent 2nd-century AD
authors), the **New Testament**, and the **Septuagint** — or paste any other
Greek text, with a Morpheus morphological analysis and an LSJ gloss aligned
under every single word — entirely from static JSON, with no backend.

## Features

- **56 authors, ~750 works** — epic, lyric and didactic poetry, tragedy,
  comedy, historiography, oratory, philosophy, the novel, Plutarch's Lives
  and Moralia, the 27 NT books, and 55 books of the Swete Septuagint.
- **Interlinear reader** — every unit of Greek is shown with parse cards
  beneath it: lemma (italic bold), morphological features, and a grey LSJ
  gloss. Verse units keep per-line rows (`1.1`); prose units flow as
  paragraphs with ref badges (`steph.17a`, `2.3`, `p12`).
- **Click for details** — clicking any word opens a side panel listing *all*
  of its Morpheus analyses plus the full LSJ dictionary entries for each
  lemma.
- **Paste & Parse** — tokenise and analyse arbitrary Greek text on the fly
  (elision-aware tokenizer; reports how many tokens Morpheus could not
  parse).
- **Reader controls** — show/hide glosses, A− / A+ text sizing, "Load more"
  pagination over ≤1 MB part files.
- **Ancient Greek TTS** — offline, on-device speech via espeak-ng WASM with the
  `grc` (Ancient Greek, reconstructed pronunciation) voice — robotic but
  faithful, never modern Greek. Per-line 🔊 buttons next to every ref plus a
  global ▶ Play / ⏸ Pause / ⏹ Stop bar; the WASM (`espeak-ng.wasm`, ~18 MB) is
  bundled in `public/`/`dist` and cached by the service worker. If the WASM
  or `grc` voice is unavailable, it falls back to the Web Speech API's modern
  Greek voice and is clearly labelled as a *modern approximation*.
- **Static JSON shards** — morphology and glosses are alphabet-sharded JSON
  files fetched lazily per page; texts load part-by-part as you read. No
  server, no database: any static host works.

## Quick start

```sh
npm install
npm run dev        # dev server (Vite)
npm run build      # production build → dist/
npm run preview    # serve the production build locally
```

The data files are committed under `public/data/`, so the built site works out of the box. No env vars or DB required.

### Build steps (full rebuild)

```sh
python3 pipeline/make_manifest.py      # inventory sources → manifest.json (.cache-corpus/)
python3 pipeline/fetch_sources.py      # download TEI → .cache-corpus/texts/
python3 pipeline/build_corpus.py       # parse + Morpheus crunch → public/data/texts/ + morph/
python3 pipeline/build_glosses.py      # LSJ → public/data/gloss/
python3 pipeline/build_translations.py # public-domain EN → public/data/trans/ (.cache-trans/)
python3 pipeline/build_dicts.py        # Autenrieth Homeric Dict. → public/data/dicts/ (.cache-dicts/)
npm run build                          # Vite → dist/ (with .gz/.br precompression)
```

Morphology rebuild requires the locally patched Morpheus `cruncher` (see `third_party/morpheus-patches/`); other steps are stdlib-only Python.

### Development method

Pipeline-driven, spec-first: `pipeline/*.py` are the source of truth for corpus + morphology + glosses; `src/` is a thin static reader over the emitted JSON. Changes flow `pipeline → public/data/ → Vite → dist/`. No backend, no mocks — tests (Playwright) run against static files. Forks keep `public/data/` licenses intact and preserve CC BY-SA attribution.

### Dependencies

| package | version | license | function |
| --- | --- | --- | --- |
| `vite` | ^6.0.0 | MIT | dev server + build (Rollup + esbuild) |
| `typescript` | ^5.6.0 | Apache-2.0 | static typing (compile-time only) |
| `espeak-ng` | ^1.0.2 | GPL-3.0-or-later | offline TTS WASM `grc` voice (dynamic import, separate from code license) |
| `playwright-core` | ^1.49.0 | Apache-2.0 | browser automation for interaction tests |

Transitives via Vite: `esbuild` (MIT), `rollup` (MIT), `postcss` (MIT). All permissive and compatible with the project's dual MIT OR Apache-2.0 code license. The WASM (`public/espeak-ng.wasm`) is GPL-3.0-not-MIT/Apache (see `LICENSE`).

## Data pipeline

`pipeline/` contains Python 3 (stdlib-only) scripts:

| script | purpose |
| --- | --- |
| `betacode.py` | Unicode ⇄ TLG Beta Code conversion + accent-stripped lookup keys |
| `make_manifest.py` | inventories both source repos via the GitHub git-trees API + CTS `__cts__.xml` metadata (cached in `.cache-corpus/`) and emits `manifest.json`: one entry per work (id, author, title, urn prefix, license, source file list) |
| `fetch_sources.py` | downloads every manifest TEI file into `.cache-corpus/texts/` (one curl per file, retried, size-validated) |
| `build_corpus.py` | the corpus builder: parses both repos' TEI shapes into units (verse `<l>` lines; prose `<p>` split into ≤60-word chunks), batch-analyses every unique word form corpus-wide with the Morpheus `cruncher` (5k-form stdin chunks, echo-sync), and emits `public/data/catalog.json`, `public/data/texts/<tlg>/<work>-partNN.json` and `public/data/morph/{a–z}.json`. Files that fail parsing twice are logged to `pipeline/ingest-failures.md` and skipped |
| `build_work.py` | legacy single-work builder (*Iliad* 1 prototype; superseded by `build_corpus.py`) |
| `build_glosses.py` | extracts headword + first level-1 sense per entry from the LSJ digitisation (`greatscott01–86.xml`, cached in `.cache-lsj/`), converts Beta Code headwords to Unicode, and emits `public/data/gloss/{a–z}.json` |
| `build_dicts.py` | builds the specialised per-author dictionaries under `public/data/dicts/`: walks the Perseus Hopper entry chain for **Autenrieth's Homeric Dictionary** (1891, public domain; Perseus:text:1999.04.0073) with rate-limited, disk-cached, resumable fetching (`.cache-dicts/`), then shards plain-text entries by letter. Slater's *Lexicon to Pindar* was evaluated and **skipped** — De Gruyter, 1969, still in copyright |

Shard lookup key = `strip_accents(surface/lemma)`: lowercase, NFD, drop
combining marks, final sigma ς → σ. Shard file = first letter of the
Beta-Code transliteration of that key (`shard_key()` in `betacode.py`,
shared by all writers).

Rebuilding morphology requires the patched Morpheus `cruncher`; see
`third_party/morpheus-patches/`.

## Data layout

```
public/data/
  catalog.json                    # {"authors":[{name, tlg, works:[…]}]}
  texts/<tlg>/<work>-partNN.json  # {id, author, title, kind, units:[{ref, words}]}
  morph/<letter>.json             # {strippedForm: [{l: lemma, p: pos, f: features, x: extras}]}
  gloss/<letter>.json             # {strippedLemma: {u: headword, g: LSJ gloss}}
  dicts/<domain>/<letter>.json    # {strippedLemma: {u: lemma, g: entry text,
                                  #  src: "autenrieth"}} — domain-scoped
                                  #  specialised dictionaries (homer)
  trans/<workId>.json             # {workId, translator, year, license, source,
                                  #  alignment?, units:[{ref, text}]}
```

`trans/` holds aligned public-domain **English translations** (431 works).
Greek `units[].ref` strings are mirrored exactly; a Greek unit without an
entry in `units` renders without English. Prose alignments re-split section
text proportionally where chunk counts differ — those files carry
`"alignment":"loose"`. Works whose id is ambiguous in the catalog (e.g. two
`apology`s) use `<tlg>--<id>.json` and say so in
`catalog.json → work.translation.file`. The build is resume-safe:
`python3 pipeline/build_translations.py` (downloads cached under
`.cache-trans/`, gitignored).

Routes are catalog-driven: `#/<tlg>/<workId>` loads the work's part files
sequentially ("Load more" pagination). Old `#/iliad/1`-style links redirect
best-effort to their new catalog route.

## Deployment

Any static-file host works — the site is plain HTML/JS/CSS + JSON.

**Cloudflare Pages**

- Build command: `npm run build`
- Build output directory: `dist`
- (Node 18+ default environment is fine)

**Vercel**

- Framework preset: *Vite*
- Build command: `npm run build`
- Output directory: `dist`

No environment variables or serverless functions are required.

## Sources & Licenses

All code in this repository: **dual MIT OR Apache-2.0 at your choice** (see `LICENSE`, `LICENSE-MIT`, `LICENSE-APACHE`; SPDX `MIT OR Apache-2.0`, Rust model). The data under `public/data/` is **not** MIT/Apache — it derives from CC BY-SA sources below and is distributed under corresponding ShareAlike terms, independent of the code license. See `LICENSE` § Data License Note.

- **Morphological analysis** — [Morpheus](https://github.com/PerseusDL/morpheus),
  Perseus Digital Library, Tufts University. Licensed
  [CC BY-SA 3.0 US](https://creativecommons.org/licenses/by-sa/3.0/us/).
  Cite: Gregory Crane (ed.), *The Perseus Digital Library*, Tufts University.
  Local build patches are recorded in
  `third_party/morpheus-patches/0001-local.patch`.

- **Glosses** — Liddell, H. G., & Scott, R., revised and augmented by Jones,
  H. S., *A Greek–English Lexicon*, 9th ed. Oxford: Clarendon Press, 1940.
  Digitized text courtesy of the [LSJLogeion](https://github.com/helmadik/LSJLogeion)
  project by Helma Dik / Logeion (University of Chicago), licensed CC BY-SA 4.0,
  and of the [Perseus Digital Library](https://www.perseus.tufts.edu),
  Tufts University, licensed CC BY-SA 3.0 US. We gratefully credit **both**
  Perseus (Tufts) and Helma Dik / Logeion as requested by the maintainers.

- **Specialised dictionaries (`public/data/dicts/`)** — Georg Autenrieth,
  *A Homeric Dictionary for Schools and Colleges*, trans. Robert P. Keep
  (New York: Harper and Brothers, 1891). **Public domain** (author d. 1900,
  translator d. 1904); digitised text served by the
  [Perseus Digital Library](https://www.perseus.tufts.edu/hopper/text?doc=Perseus:text:1999.04.0073)
  (Perseus:text:1999.04.0073), with thanks to Perseus (Tufts) for the
  professional data entry. William J. Slater's *Lexicon to Pindar* was
  considered for a `pindar` domain and **deliberately not included**: it is
  De Gruyter 1969, still under active copyright (DOI
  [10.1515/9783110839289](https://doi.org/10.1515/9783110839289)); no
  public-domain machine-readable text exists.

- **Greek text — classical corpus** — via
  [PerseusDL/canonical-greekLit](https://github.com/PerseusDL/canonical-greekLit)
  (TEI XML, CTS URNs), licensed **CC BY-SA 3.0**. This includes the Homeric
  epics (Monro & Allen OCT), the tragedians, Aristophanes, Herodotus,
  Thucydides, Xenophon, the orators (Burnet's Plato, Bekker/OCT editions of
  the Attic orators), Aristotle, Pindar, Bacchylides, Theocritus, Callimachus,
  Apollonius Rhodius, Aratus, Polybius, Diodorus, Dionysius of Halicarnassus,
  Strabo, Pausanias, Plutarch (*Lives* + *Moralia*), Aelian, Lucian,
  Epictetus, Longinus, Longus, Achilles Tatius, Arrian, Aelius Aristides,
  Dio Chrysostom, Marcus Aurelius and more.

- **Greek text — New Testament** — *Novum Testamentum Graece*, ed. Brooke
  Foss Westcott & Fenton John Anthony Hort (Cambridge, 1881). The Greek
  text itself is in the **public domain**; the TEI encoding is via
  PerseusDL/canonical-greekLit (**CC BY-SA 3.0**). The restricted-licence
  SBLGNT edition was deliberately **not** used.

- **Greek text — Septuagint** — *Septuaginta*, ed. Henry Barclay Swete
  (Cambridge, 1895–1907, public domain), transcribed in TEI by the
  [OpenGreekAndLatin/First1KGreek](https://github.com/OpenGreekAndLatin/First1KGreek)
  project (with the University of Leipzig / Open Greek & Latin), licensed
  **CC BY-SA 4.0**. 55 books ingested, Genesis through Bel et Draco.

- **Greek text — Philo, Nicander, Epicurus, pseudo-Menander** — also from
  OpenGreekAndLatin/First1KGreek (**CC BY-SA 4.0**).

### English translations (`public/data/trans/`, all public domain)

- **Classical works (354)** — paired English editions from
  [PerseusDL/canonical-greekLit](https://github.com/PerseusDL/canonical-greekLit):
  A. T. Murray's Homer (*Iliad* 1924, *Odyssey* 1919), Godley's Herodotus
  (1920), Crawley's Thucydides (1914), Jebb's Sophocles, Smyth's Aeschylus,
  Fowler's Plato, and the rest of the Perseus translation corpus. Only
  editions with imprint years ≤ 1929 are ingested; the TEI header supplies
  translator and year, recorded per work in `catalog.json`.
- **New Testament (27 books)** — King James Version (KJV), 1769 standard text, public domain, via [`aruljohn/Bible-kjv`](https://github.com/aruljohn/Bible-kjv) JSON mirror.
- **Septuagint (50+ books)** — Sir Lancelot C. L. Brenton's translation (Samuel Bagster, London 1844; Apocrypha incl. 1 Esdras, Wisdom, Sirach, Maccabees, Daniel/Theodotion additions 1851), public domain, via [eBible.org](https://ebible.org/find/show.php?id=engBrenton) USFX.
- Where a prose translation's section chunking differs from the Greek, text
  is re-split proportionally and the file is marked `"alignment":"loose"`;
  line-level translations distributed from range-anchored prose (e.g.
  Murray's Homer) are likewise marked loose.

### Reference & inspiration

Early interlinear models that informed the UX (not data sources):

- [nodictionaries.com](https://www.nodictionaries.com) — word-by-word gloss model.
- [johnhboyer-sys/plato-reader](https://github.com/johnhboyer-sys/plato-reader) — minimal static Perseus morphology reader; informed the static-JSON/no-backend approach.
- [scaife.perseus.org](https://scaife.perseus.org) (Scaife Viewer) — Perseus CTS/TEI reading environment; reference for CTS URNs and passage navigation.

## Acknowledgments

With thanks to the **Perseus Digital Library** team at Tufts — Gregory
Crane, Lisa Cerrato, and the many contributors over three decades — whose
texts and tools underpin this project; to the **Open Greek & Latin /
First1KGreek** community (and its Leipzig partners) for the Swete
Septuagint, Philo and other texts; to **Helma Dik** and the **Logeion**
project at the University of Chicago for the digitized LSJ; to the
**Morpheus** maintainers and contributors for the analyzer that still has no
rival for Ancient Greek; and to every editor whose public-domain critical
editions — from Monro & Allen's Homer to Swete's Septuagint and Westcott &
Hort's Greek New Testament — made this corpus possible.
