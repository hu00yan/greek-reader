"""Build the multi-author corpus per the frontend contract (src/api.ts):

  public/data/catalog.json                    {authors:[{name,tlg,works:[...]}]}
  public/data/texts/<tlg>/<work>-partNN.json  {id,author,title,kind,
                                               units:[{ref,words}]}
  public/data/morph/<letter>.json             merged Morpheus shards

Sources: cached Perseus TEI texts under .cache-corpus/texts.  All unique
Greek forms are batch-analysed through the local Morpheus cruncher and
merged into the existing morph shards.

Usage:  python3 pipeline/build_corpus.py
"""

from __future__ import annotations

import json
import os
import re
import sys
import xml.etree.ElementTree as ET

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)

import betacode  # noqa: E402
from build_work import tokenize, run_cruncher, MORPH_DIR, DATA  # noqa: E402

NS = "http://www.tei-c.org/ns/1.0"
CACHE = os.path.join(ROOT, ".cache-corpus", "texts")
TEXTS_DIR = os.path.join(DATA, "texts")
UNITS_PER_PART = 150

# author name / tlg / work id / title / source file / mode / kind / scope
WORKS = [
    {"author": "Homer", "tlg": "tlg0012", "id": "iliad", "title": "Iliad",
     "src": "tlg0012.tlg001.perseus-grc2.xml", "mode": "verse",
     "kind": "verse", "limit": 611},
    {"author": "Hesiod", "tlg": "tlg0020", "id": "theogony",
     "title": "Theogony", "src": "tlg0020.tlg001.perseus-grc2.xml",
     "mode": "verse", "kind": "verse", "limit": 120},
    {"author": "Plato", "tlg": "tlg0059", "id": "apology", "title": "Apology",
     "src": "tlg0059.tlg002.perseus-grc2.xml", "mode": "section",
     "kind": "prose", "cap": 35, "limit": 26},
    {"author": "Plutarch", "tlg": "tlg0007", "id": "themistocles",
     "title": "Life of Themistocles",
     "src": "tlg0007.tlg010.perseus-grc2.xml", "mode": "chapter-sections",
     "kind": "prose", "cap": 35, "limit": 24},
    {"author": "Herodotus", "tlg": "tlg0010", "id": "histories",
     "title": "Histories (Book 1)", "src": "tlg0010.tlg001.perseus-grc2.xml",
     "mode": "section", "kind": "prose", "cap": 35, "limit": 20},
    {"author": "New Testament", "tlg": "tlg0031", "id": "mark", "title": "Mark",
     "src": "tlg0031.tlg002.perseus-grc2.xml", "mode": "nt",
     "kind": "verse", "limit": 4},
    {"author": "New Testament", "tlg": "tlg0031", "id": "john", "title": "John",
     "src": "tlg0031.tlg004.perseus-grc2.xml", "mode": "nt",
     "kind": "verse", "limit": 4},
]

LICENSE = "CC BY-SA 3.0 (Perseus Digital Library)"
DROP_TAGS = {f"{{{NS}}}note", f"{{{NS}}}head"}
GREEK_RE = re.compile(r"[\u0370-\u03ff\u1f00-\u1fff]")


def tag(name: str) -> str:
    return f"{{{NS}}}{name}"


def textpart_divs(root, subtypes):
    return [d for d in root.iter(tag("div"))
            if d.get("type") == "textpart" and d.get("subtype") in subtypes]


def clean_text(el) -> str:
    """itertext of el after removing note/head elements."""
    parts: list[str] = []

    def walk(e):
        if e.tag in DROP_TAGS:
            return
        if e.text:
            parts.append(e.text)
        for c in e:
            walk(c)
            if c.tail:
                parts.append(c.tail)

    walk(el)
    return "".join(parts)


def chunk_words(words, cap):
    """Split tokenised prose into chunks <=cap words."""
    chunks, cur = [], []
    for w in words:
        cur.append(w)
        if len(cur) >= cap:
            chunks.append(cur)
            cur = []
    if cur:
        if chunks and len(cur) < cap // 3:
            chunks[-1].extend(cur)
        else:
            chunks.append(cur)
    return chunks


def units_for(work):
    """Return [{ref, words}] for one work."""
    tree = ET.parse(os.path.join(CACHE, work["src"]))
    root = tree.getroot()
    mode, units = work["mode"], []

    def add(ref, text):
        words = tokenize(text)
        if words:
            units.append({"ref": ref, "words": words})

    if mode == "verse":
        books = textpart_divs(root, {"Book"})
        src = books[0] if books else root
        n = 0
        for l_el in src.findall(f".//{tag('l')}"):
            add(l_el.get("n") or str(n + 1), clean_text(l_el))
            n += 1
            if n >= work["limit"]:
                break

    elif mode == "nt":
        for ch in textpart_divs(root, {"chapter"})[: work["limit"]]:
            cn = ch.get("n") or "?"
            for v in ch.findall(f"./{tag('div')}"):
                if v.get("subtype") != "verse":
                    continue
                add(f"{cn}.{v.get('n')}", clean_text(v))

    elif mode in ("section", "chapter-sections"):
        doc_units = textpart_divs(root, {"section"})
        if mode == "chapter-sections":
            n_ch = max(1, round(work["limit"] / 3))
            sel = {id(c) for c in textpart_divs(root, {"chapter"})[:n_ch]}
            ok = False
            picked = []
            for d in root.iter(tag("div")):
                if d.get("type") != "textpart":
                    continue
                if d.get("subtype") == "chapter":
                    ok = id(d) in sel
                elif d.get("subtype") == "section" and ok:
                    picked.append(d)
            doc_units = picked
        cap = work.get("cap", 35)
        for u in doc_units[: work["limit"]]:
            num = u.get("n") or "?"
            chunks = chunk_words(tokenize(clean_text(u)), cap)
            multi = len(chunks) > 1
            for i, chunk in enumerate(chunks, 1):
                words = chunk
                if words:
                    units.append({"ref": f"{num}.{i}" if multi else num,
                                  "words": words})
    else:
        raise SystemExit(f"unknown mode {mode}")
    return units


def crunch_all(forms):
    """Morpheus analysis with slicing + one retry pass; {beta: [parses]}."""

    def crunch(fs):
        out = {}
        SLICE = 150  # giant single stdin batches lose cruncher sync
        for i in range(0, len(fs), SLICE):
            for k, v in run_cruncher(fs[i:i + SLICE]).items():
                if v:
                    out[k] = v
        return out

    beta_forms = [betacode.to_beta(f) for f in sorted(forms)
                  if GREEK_RE.search(f)]
    analyses = crunch(beta_forms)
    missing = [b for b in beta_forms if not analyses.get(b)]
    print(f"retrying {len(missing)} unanalysed forms")
    for k, v in crunch(missing).items():
        if v:
            analyses[k] = v
    return analyses


def main():
    all_units, forms = {}, set()
    for w in WORKS:
        us = units_for(w)
        all_units[(w["tlg"], w["id"])] = us
        for u in us:
            forms.update(u["words"])
        print(f'{w["tlg"]}/{w["id"]}: {len(us)} units')
    print(f"{len(forms)} unique word forms")

    analyses = crunch_all(forms)

    # merge morph shards
    shards = {}
    for fn in os.listdir(MORPH_DIR):
        if fn.endswith(".json"):
            with open(os.path.join(MORPH_DIR, fn), encoding="utf-8") as fh:
                shards[fn[:-5]] = json.load(fh)
    added = 0
    for form in sorted(forms):
        parses = analyses.get(betacode.to_beta(form)) or []
        key = betacode.strip_accents(form)
        letter = betacode.shard_key(key)
        if letter is None or not parses:
            continue
        compact = [{"l": p["l"], "p": p["p"], "f": p["f"],
                    **({"x": p["x"]} if p["x"] else {})} for p in parses]
        shard = shards.setdefault(letter, {})
        if key not in shard:
            added += 1
        shard[key] = compact
    for letter, table in shards.items():
        with open(os.path.join(MORPH_DIR, f"{letter}.json"), "w",
                  encoding="utf-8") as fh:
            json.dump(table, fh, ensure_ascii=False, sort_keys=True,
                      separators=(",", ":"))
    print(f'morph shards merged: +{added} -> '
          f'{sum(len(t) for t in shards.values())} entries')

    # emit part files + hierarchical catalog
    catalog = {"authors": []}
    authors_order = []
    for w in WORKS:
        units = all_units[(w["tlg"], w["id"])]
        tdir = os.path.join(TEXTS_DIR, w["tlg"])
        os.makedirs(tdir, exist_ok=True)
        files = []
        for pi in range(0, len(units), UNITS_PER_PART):
            name = f'{w["id"]}-part{pi // UNITS_PER_PART + 1:02d}.json'
            with open(os.path.join(tdir, name), "w", encoding="utf-8") as fh:
                json.dump({"id": w["id"], "author": w["author"],
                           "title": w["title"], "kind": w["kind"],
                           "units": units[pi:pi + UNITS_PER_PART]},
                          fh, ensure_ascii=False, separators=(",", ":"))
            files.append(f'texts/{w["tlg"]}/{name}')
        got = sum(1 for u in units
                  if any(analyses.get(betacode.to_beta(f_w))
                         for f_w in u["words"]))
        print(f'coverage {w["id"]}: {got}/{len(units)} units analysed')
        author_entry = next((a for a in catalog["authors"]
                             if a["tlg"] == w["tlg"]), None)
        if author_entry is None:
            author_entry = {"name": w["author"], "tlg": w["tlg"],
                            "works": []}
            catalog["authors"].append(author_entry)
        author_entry["works"].append({
            "id": w["id"], "title": w["title"],
            "urn": f'urn:cts:greekLit:{w["src"].replace(".xml", "")}',
            "license": LICENSE,
            "files": files, "unitCount": len(units),
        })

    with open(os.path.join(DATA, "catalog.json"), "w", encoding="utf-8") as fh:
        json.dump(catalog, fh, ensure_ascii=False, indent=1)
        fh.write("\n")
    # mirror so stale hardcoded data/works.json paths keep resolving
    with open(os.path.join(DATA, "works.json"), "w", encoding="utf-8") as fh:
        json.dump(catalog, fh, ensure_ascii=False, indent=1)
        fh.write("\n")
    n_works = sum(len(a["works"]) for a in catalog["authors"])
    print(f"wrote catalog.json: {len(catalog['authors'])} authors, "
          f"{n_works} works")


if __name__ == "__main__":
    main()
