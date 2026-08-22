# Greek Reader

An interlinear reading environment for Ancient Greek. Read the Iliad (and
paste any other Greek text) with a Morpheus morphological analysis and an
LSJ gloss aligned under every single word — entirely from static JSON, with
no backend.

## Features

- **Interlinear reader** — every line of Greek is shown with one parse card
  per word beneath it: lemma (italic bold), morphological features, and a
  grey LSJ gloss.
- **Click for details** — clicking any word opens a side panel listing *all*
  of its Morpheus analyses plus the full LSJ dictionary entries for each
  lemma.
- **Paste & Parse** — tokenise and analyse arbitrary Greek text on the fly
  (elision-aware tokenizer; reports how many tokens Morpheus could not
  parse).
- **Reader controls** — show/hide glosses, A− / A+ text sizing.
- **Static JSON shards** — morphology and glosses are alphabet-sharded JSON
  files fetched lazily per page. No server, no database: any static host
  works.

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
| `build_work.py` | parses the Perseus TEI text of *Iliad* 1 into `public/data/iliad.1.json`, then batch-analyses every word form with the Morpheus `cruncher` into `public/data/morph/{a–w}.json` |
| `build_glosses.py` | downloads the LSJ digitisation (`greatscott01–86.xml`, cached in `.cache-lsj/`), extracts headword + first level-1 sense per entry (falling back to the first sense when an entry opens with prose), converts Beta Code headwords to Unicode, and emits `public/data/gloss/{a–z}.json` |

Shard lookup key = `strip_accents(surface/lemma)`: lowercase, NFD, drop
combining marks, final sigma ς → σ. Shard file = first letter of the
Beta-Code transliteration of that key (`shard_key()` in `betacode.py`,
shared by all writers).

Rebuilding the morphology requires the patched Morpheus `cruncher`; see
`third_party/morpheus-patches/`.

## Data layout

```
public/data/
  works.json              # catalogue shown on the home page
  iliad.1.json            # lines + word lists for Iliad book 1
  morph/<letter>.json     # {strippedForm: [{l: lemma, p: pos, f: features, x: extras}]}
  gloss/<letter>.json     # {strippedLemma: {u: headword, g: LSJ gloss}}
```

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

- **Greek text** — Homer, *Ilias*, edited by D. B. Monro & T. W. Allen
  (Oxford Classical Text), via
  [PerseusDL/canonical-greekLit](https://github.com/PerseusDL/canonical-greekLit),
  licensed CC BY-SA 3.0.

## Acknowledgments

With thanks to the **Perseus Digital Library** team at Tufts — Gregory
Crane, Lisa Cerrato, and the many contributors over three decades — whose
texts and tools underpin this project; to **Helma Dik** and the **Logeion**
project at the University of Chicago for the digitized LSJ; to the
**Morpheus** maintainers and contributors for the analyzer that still has no
rival for Ancient Greek; and to the wider **Open Greek & Latin /
First1KGreek** community for making canonical texts freely available.
