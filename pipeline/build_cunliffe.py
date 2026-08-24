#!/usr/bin/env python3
"""Build Cunliffe "A Lexicon of the Homeric Dialect" (1924) dictionary shards
from Gregory Crane's TEI-XML digitization (gregorycrane/Homerica,
cunliffe.lexentries.unicode.xml).

Emits public/data/dicts/cunliffe/{a-y}.json — same contract as the homer
shards: {strip_accents(lemma): {u, g, src:"cunliffe"}} where keys use
accent-stripped GREEK letters and shard FILES are named by the TLG beta-code
initial (alpha->a ... xi->c ... omega->w), matching gloss/homer loaders.

License: work published 1924 (pre-1930 US rule; author d. 1956; no known
renewal — community republications exist: jtauber/cunliffe,
gregorycrane/Homerica, davidfdriscoll/epic-greek-dictionary).
"""
import html
import json
import os
import re
import sys
import unicodedata

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(HERE, ".cache-dicts", "cunliffe",
                   "cunliffe.lexentries.unicode.xml")
OUT_DIR = os.path.join(HERE, "public", "data", "dicts", "cunliffe")

# TLG beta-code initials (matches src/lexicon.ts firstBetaLetter)
BETA = {"\u03b1": "a", "\u03b2": "b", "\u03b3": "g", "\u03b4": "d",
        "\u03b5": "e", "\u03b6": "z", "\u03b7": "h", "\u03b8": "q",
        "\u03b9": "i", "\u03ba": "k", "\u03bb": "l", "\u03bc": "m",
        "\u03bd": "n", "\u03be": "c", "\u03bf": "o", "\u03c0": "p",
        "\u03c1": "r", "\u03c3": "s", "\u03c4": "t", "\u03c5": "u",
        "\u03c6": "f", "\u03c7": "x", "\u03c8": "y", "\u03c9": "w"}

TAG = re.compile(r"<[^>]+>")


def strip_accents(s: str) -> str:
    d = unicodedata.normalize("NFD", s)
    out = "".join(c for c in d
                  if unicodedata.category(c) != "Mn").lower()
    return out.replace("\u03c2", "\u03c3")  # final sigma -> sigma


def to_text(seg: str) -> str:
    """TEI segment -> plain text, keeping citations readable."""
    seg = re.sub(r"<title>([^<]*)</title>", r" \1", seg)
    seg = TAG.sub("", seg)
    seg = html.unescape(seg)
    return re.sub(r"\s+", " ", seg).strip()


def main() -> None:
    s = open(SRC, encoding="utf-8").read()
    # slice top-level entry divs by start-of-next (robust against nesting)
    starts = [m.start() for m in re.finditer(
        r'<div xml:id="[^"]*?-cunliffe-lex"', s)]
    starts.append(len(s))
    shards: dict[str, dict[str, dict]] = {}
    n = 0
    for i in range(len(starts) - 1):
        seg = s[starts[i]:starts[i + 1]]
        mh = re.search(r'<div xml:id="([^"]+)" type="textpart" n="([^"]+)">',
                       seg)
        if not mh:
            continue
        head = to_text(re.search(r"<head>(.*?)</head>", seg, re.S).group(1)) \
            if re.search(r"<head>(.*?)</head>", seg, re.S) else ""
        if not head:
            continue
        # drop the outer <head> block from the entry body
        body_seg = re.sub(r"<head>.*?</head>", " ", seg, count=1, flags=re.S)
        # drop nested wrapper div tags but keep inner content
        body_seg = re.sub(r"</?div[^>]*>", " ", body_seg)
        g = to_text(body_seg)
        if not g:
            continue
        key = strip_accents(head)
        if len(key) < 1:
            continue
        letter = BETA.get(key[0])
        if not letter:
            continue
        u = to_text(re.search(r"<head>.*?<foreign[^>]*>(.*?)</foreign>",
                              seg, re.S).group(1)) \
            if re.search(r"<head>.*?<foreign[^>]*>(.*?)</foreign>", seg, re.S) \
            else head
        entry = {"u": u or head, "g": g[:4000], "src": "cunliffe"}
        bucket = shards.setdefault(letter, {})
        if key in bucket:
            prev = bucket[key]
            if entry["g"][:120] != prev["g"][:120]:
                merged = prev["g"] + "\n" + entry["g"]
                bucket[key] = {"u": prev["u"], "g": merged[:6000],
                               "src": "cunliffe"}
        else:
            bucket[key] = entry
        n += 1
    os.makedirs(OUT_DIR, exist_ok=True)
    total = 0
    for letter, bucket in sorted(shards.items()):
        path = os.path.join(OUT_DIR, f"{letter}.json")
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(bucket, fh, ensure_ascii=False, separators=(",", ":"))
        total += len(bucket)
    print(f"[cunliffe] {len(shards)} shards, {total} entries "
          f"(parsed {n})")


if __name__ == "__main__":
    main()
