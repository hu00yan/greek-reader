"""Build the Iliad Book 1 data files + morphological shards.

Reads the Perseus TEI XML of Iliad Book 1, tokenises each verse line,
analyses every unique word form with the Morpheus cruncher in a single
batch subprocess, and emits:

  public/data/works.json          work/book catalogue
  public/data/iliad.1.json        the text, one record per verse line
  public/data/morph/<letter>.json lookup shards keyed by accent-stripped form

Usage:  python3 pipeline/build_work.py [input.xml]
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import xml.etree.ElementTree as ET
from collections import OrderedDict

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)

import betacode  # noqa: E402

CRUNCHER = "/Users/huyan00/mycode/tools/morpheus/bin/cruncher"
MORPHLIB = "/Users/huyan00/mycode/tools/morpheus/stemlib"
TEI_NS = {"tei": "http://www.tei-c.org/ns/1.0"}

INPUT = sys.argv[1] if len(sys.argv) > 1 else "/tmp/iliad1.xml"
DATA = os.path.join(ROOT, "public", "data")
MORPH_DIR = os.path.join(DATA, "morph")

# Punctuation stripped from token edges; elision apostrophes are NOT here.
PUNCT = ",.;:·«»()[]‹›…—?!“”„‘’\"*_"


def tokenize(line_text: str) -> list[str]:
    """Split a verse into word tokens, normalising elision apostrophes."""
    text = line_text.replace("\u02bc", "'").replace("\u2019", "'")
    words = []
    for raw in text.split():
        tok = raw.strip(PUNCT).strip()
        if tok:
            words.append(tok)
    return words


def parse_lines(path: str) -> list[dict]:
    tree = ET.parse(path)
    root = tree.getroot()
    book = root.find(
        ".//tei:div[@type='textpart'][@subtype='Book'][@n='1']", TEI_NS)
    if book is None:
        raise SystemExit("Book 1 div not found")
    # Drop <note> elements before extracting text.
    parents = {child: parent for parent in book.iter() for child in parent}
    for note in [el for el in parents if el.tag == f"{{{TEI_NS['tei']}}}note"]:
        parents[note].remove(note)

    lines = []
    for l in book.findall(".//tei:l", TEI_NS):  # verses may sit inside <q>
        n = l.get("n") or ""
        text = "".join(l.itertext())
        words = tokenize(text)
        if words:
            lines.append({"n": n, "words": words})
    return lines


def run_cruncher(beta_forms: list[str]) -> dict[str, list[dict]]:
    """Batch all forms through cruncher; return {beta_form: [parse, ...]}.

    Cruncher echoes each input line then prints its <NL> records.  Echoes
    can be dropped or mangled, so instead of trusting a strict 1:1 rhythm
    we keep a pointer to the NEXT expected echo and search a small window
    ahead for it; an unmatched word simply gets zero parses.
    """
    unique = list(dict.fromkeys(beta_forms))
    buckets: dict[str, list[dict]] = {f: [] for f in unique}
    env = dict(os.environ, MORPHLIB=MORPHLIB)
    proc = subprocess.run(
        [CRUNCHER],
        input="\n".join(unique) + "\n",
        capture_output=True, text=True, env=env,
    )
    ptr = -1
    WINDOW = 3
    for raw in proc.stdout.splitlines():
        line = raw.strip()
        if not line or line.startswith(":"):
            continue  # debug chatter e.g. ":longtime"
        nxt = ptr + 1
        if nxt < len(unique) and line == unique[nxt]:
            ptr = nxt          # clean echo
            continue
        # lost sync? look a few lines-worth ahead for the expected echo
        if nxt < len(unique):
            hit = -1
            for off in range(1, WINDOW + 1):
                j = nxt + off
                if j < len(unique) and line == unique[j]:
                    hit = j
                    break
            if hit >= 0:
                ptr = hit      # skipped some unechoed inputs -> no parses
                continue
            if any(line.startswith(u) or u.startswith(line)
                   for u in unique[nxt:nxt + WINDOW]):
                continue       # mangled partial echo; treat as no parses
        if ptr >= 0:
            for rec in re.findall(r"<NL>(.*?)</NL>", line):
                parsed = parse_record(rec)
                if parsed:
                    buckets[unique[ptr]].append(parsed)
    unparsed = sum(1 for f in unique if not buckets[f])
    print(f"cruncher: {len(unique)} unique forms, "
          f"{len(unique) - unparsed} analysed, {unparsed} unparsed")
    return buckets


def parse_record(rec: str) -> dict | None:
    """Parse one '<NL>' payload: POS headword␣␣features[\textra\t\textra]."""
    parts = rec.split("\t")
    head = parts[0]
    m = re.match(r"^(\S+)\s+(\S+)\s*(.*)$", head)
    if not m:
        return None
    pos, hw_beta, features = m.group(1), m.group(2), m.group(3).strip()

    dialects, stemtypes = [], []
    for extra in parts[1:]:
        for tok in extra.split():
            if "_" in tok or "=" in tok:
                stemtypes.append(tok)
            elif tok.isalpha() and tok.islower() and tok.isascii():
                dialects.append(tok)
    x = ""
    if dialects:
        x += " ".join(dialects)
    if stemtypes:
        x += ("|" if x else "") + ",".join(stemtypes)

    lemma_beta = hw_beta.split(",")[-1]          # lu_/ein,lu/w -> lu/w
    return {
        "l": betacode.from_beta(lemma_beta),
        "p": pos,
        "f": features,
        "x": x,
    }


def shard_letter(key: str) -> str | None:
    """Shard id = first letter of the Beta-Code transliteration (a-z ASCII)."""
    return betacode.shard_key(key)


def main() -> None:
    lines = parse_lines(INPUT)
    print(f"parsed {len(lines)} verse lines")

    unique = sorted({w for ln in lines for w in ln["words"]})
    print(f"{len(unique)} unique word forms")

    analyses = run_cruncher([betacode.to_beta(w) for w in unique])
    analysed = sum(1 for f in unique if analyses.get(betacode.to_beta(f)))
    print(f"{analysed}/{len(unique)} forms got at least one analysis")

    # morph shards: key = accent-stripped surface form
    shards: dict[str, dict[str, list]] = {}
    for form in unique:
        key = betacode.strip_accents(form)
        parses = analyses.get(betacode.to_beta(form)) or []
        letter = shard_letter(key)
        if letter is None or not parses:
            continue
        compact = [{"l": p["l"], "p": p["p"], "f": p["f"], **({"x": p["x"]} if p["x"] else {})}
                   for p in parses]
        shards.setdefault(letter, {})[key] = compact

    os.makedirs(MORPH_DIR, exist_ok=True)
    for letter, table in shards.items():
        with open(os.path.join(MORPH_DIR, f"{letter}.json"), "w",
                  encoding="utf-8") as fh:
            json.dump(table, fh, ensure_ascii=False, sort_keys=True,
                      separators=(",", ":"))
    total_entries = sum(len(t) for t in shards.values())
    print(f"wrote {len(shards)} morph shards ({total_entries} entries)")

    os.makedirs(DATA, exist_ok=True)
    with open(os.path.join(DATA, "works.json"), "w", encoding="utf-8") as fh:
        json.dump([{
            "id": "iliad", "author": "Homer", "title": "Iliad",
            "greek": "\u1f38\u03bb\u03b9\u03ac\u03c2",
            "books": [{"n": "1", "file": "iliad.1.json"}],
        }], fh, ensure_ascii=False, indent=2)
        fh.write("\n")

    with open(os.path.join(DATA, "iliad.1.json"), "w", encoding="utf-8") as fh:
        json.dump({
            "id": "iliad", "n": "1", "author": "Homer", "title": "Iliad",
            "urn": (f"urn:cts:greekLit:tlg0012.tlg001.perseus-grc2:"
                    f"1.{lines[0]['n']}-1.{lines[-1]['n']}"),
            "lines": lines,
        }, fh, ensure_ascii=False, separators=(",", ":"))
    print(f"wrote iliad.1.json ({len(lines)} lines)")

    unknown = [f for f in unique[:50]
               if not analyses.get(betacode.to_beta(f))]
    if unknown:
        print("sample unanalysed:", ", ".join(unknown[:10]))


if __name__ == "__main__":
    main()
