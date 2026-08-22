"""Build LSJ gloss index from helmadik/LSJLogeion greatscottNN.xml files.

The XML is loose SGML, so we parse with regex rather than ElementTree:
each entry is a <div2 key="..."> ... </div2>; the gloss is the first
level-1 <sense>.  Keys are Beta Code; we convert to Unicode and index by
strip_accents(lemma) for accent-insensitive lookup from the frontend.

Output: public/data/gloss/{a-z}.json  {strippedLemma: {"u": lemma, "g": gloss}}
"""
from __future__ import annotations

import html
import os
import re
import subprocess
import sys
import urllib.request

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(REPO, "pipeline"))
from betacode import from_beta, strip_accents  # noqa: E402

CACHE = os.path.join(REPO, ".cache-lsj")
OUT = os.path.join(REPO, "public", "data", "gloss")
BASE = ("https://raw.githubusercontent.com/helmadik/LSJLogeion/"
        "master/greatscott{:02d}.xml")

DIV2_RE = re.compile(r'<div2 ([^>]*)>(.*?)</div2>', re.DOTALL)
KEY_RE = re.compile(r'key="([^"]*)"')
SENSE_RE = re.compile(r'<sense [^>]*level="1"[^>]*>(.*?)</sense>', re.DOTALL)
TAG_RE = re.compile(r"<[^>]+>")
GREEK_RE = re.compile(r"[α-ωάέήίόύώϊϋΐΰἀ-ῼ]")


def trunc180(s: str) -> str:
    if len(s) <= 180:
        return s
    cut = s.rfind(" ", 0, 181)
    return s[:cut] if cut > 0 else s[:180]


def fetch(nn: int) -> bytes:
    path = os.path.join(CACHE, f"greatscott{nn:02d}.xml")
    if os.path.exists(path) and os.path.getsize(path) > 1000:
        return open(path, "rb").read()
    url = BASE.format(nn)
    for attempt in range(3):
        r = subprocess.run(
            ["curl", "-sSL", "--retry", "3", "--max-time", "120", "-o", path,
             url],
            timeout=130)
        if r.returncode == 0 and os.path.getsize(path) > 1000:
            print(f"  downloaded {url} ({os.path.getsize(path)} B)")
            return open(path, "rb").read()
    raise RuntimeError(f"failed to download {url}")


def main() -> None:
    os.makedirs(CACHE, exist_ok=True)
    os.makedirs(OUT, exist_ok=True)
    buckets: dict[str, dict[str, dict[str, str]]] = {}
    n_entries = n_glossed = 0

    for nn in range(2, 31):
        raw = fetch(nn).decode("utf-8", errors="replace")
        for m in DIV2_RE.finditer(raw):
            attrs, body = m.group(1), m.group(2)
            km = KEY_RE.search(attrs)
            if not km:
                continue
            key = re.sub(r"\d+$", "", km.group(1).strip())
            if not key or not re.fullmatch(r"[*(a-zhqwxyfc)\=/\\+|]+", key):
                continue
            lemma = from_beta(key)
            if not GREEK_RE.search(lemma):
                continue
            n_entries += 1
            sm = SENSE_RE.search(body)
            if not sm:
                continue
            gloss = TAG_RE.sub("", sm.group(1))
            gloss = html.unescape(gloss)
            gloss = re.sub(r"\s+", " ", gloss).strip()
            if not gloss:
                continue
            gloss = trunc180(gloss)
            lk = strip_accents(lemma)
            if not lk or lk in buckets.get(lk[0], {}):
                continue
            buckets.setdefault(lk[0], {})[lk] = {"u": lemma, "g": gloss}
            n_glossed += 1
        print(f"greatscott{nn:02d}: cumulative entries={n_entries} "
              f"glossed={n_glossed}")

    total = 0
    for letter, d in sorted(buckets.items()):
        with open(os.path.join(OUT, f"{letter}.json"), "w",
                  encoding="utf-8") as fh:
            json_dump(d, fh)
        total += len(d)
    print(f"wrote {len(buckets)} files, {total} lemmas")


def json_dump(obj, fh) -> None:
    import json
    json.dump(obj, fh, ensure_ascii=False, separators=(",", ":"))


if __name__ == "__main__":
    main()
