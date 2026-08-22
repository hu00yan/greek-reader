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
- **Static JSON shards** — morphology and glosses are alphabet-sharded JSON
  files fetched lazily per page; texts load part-by-part as you read. No
  server, no database: any static host works.

## Quick start

```sh
npm install
npm run dev        # dev server
npm run build      # production build → dist/
npm run preview    # serve the production build locally
```

The data files are committed under `public/data/`, so the built site works
out of the box.

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
```

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

All code in this repository: **MIT** (see `LICENSE`). The data under
`public/data/` derives from CC BY-SA sources listed below and is therefore
distributed under the corresponding ShareAlike terms.

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
