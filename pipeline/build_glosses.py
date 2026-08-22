"""Build LSJ gloss index from helmadik/LSJLogeion greatscottNN.xml files.

The XML is loose SGML, so we parse with regex rather than ElementTree:
each entry is a <div2 key="..."> ... </div2>; the gloss is the first
level-1 <sense>.  Keys are Beta Code; we convert to Unicode and index by
strip_accents(lemma) for accent-insensitive lookup from the frontend.

The repo ships greatscott01..86 (01 = front matter); 02..86 are entries
covering the whole alphabet (02-11 alpha ... ending omega).

Output: public/data/gloss/{a-z}.json  {strippedLemma: {"u": lemma, "g": gloss}}
"""
from __future__ import annotations

import html
import json
import os
import re
import subprocess
import sys

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(REPO, "pipeline"))
from betacode import from_beta, shard_key, strip_accents  # noqa: E402

CACHE = os.path.join(REPO, ".cache-lsj")
OUT = os.path.join(REPO, "public", "data", "gloss")
BASE = ("https://raw.githubusercontent.com/helmadik/LSJLogeion/"
        "master/greatscott{:02d}.xml")

DIV2_RE = re.compile(r'<div2 ([^>]*)>(.*?)</div2>', re.DOTALL)
KEY_RE = re.compile(r'key="([^"]*)"')
SENSE1_RE = re.compile(r'<sense [^>]*level="1"[^>]*>(.*?)</sense>', re.DOTALL)
SENSE_ANY_RE = re.compile(r'<sense [^>]*>(.*?)</sense>', re.DOTALL)
TAG_RE = re.compile(r"<[^>]+>")
GREEK_RE = re.compile(r"[α-ωάέήίόύώϊϋΐΰἀ-ῼ]")
ALLOWED_KEY_RE = re.compile(r"[*(a-z)\=/\\+|]+")
MIN_FILE_BYTES = 1024               # smaller => error page / empty


def looks_valid(blob: bytes) -> bool:
    if len(blob) < MIN_FILE_BYTES:
        return False
    return b"<div2" in blob or b"<text" in blob


def clean_gloss(s: str) -> str:
    """Strip tags/entities; keep word boundaries; tidy dangling punctuation."""
    # replace tags with a space when text touches both sides, else nothing
    s = TAG_RE.sub(lambda m: " " if _glued(s, m) else "", s)
    s = html.unescape(s)
    s = re.sub(r"\s+", " ", s).strip()
    s = re.sub(r"^[\s\"'“”‘’(\[]+|[\s\"'“”‘’(\[]+$", "", s)
    return s


def _glued(src: str, m: re.Match) -> bool:
    a = src[m.start() - 1] if m.start() > 0 else ""
    b = src[m.end()] if m.end() < len(src) else ""
    return a.isalnum() and b.isalnum()


def trunc180(s: str) -> str:
    if len(s) <= 180:
        return s
    cut = s.rfind(" ", 0, 181)
    if cut <= 0:
        cut = s.rfind(" ", 0, len(s))
    out = s[:cut].rstrip() if cut > 0 else s[:177]
    return out.rstrip("\"'“”‘’([·;,") + "…"


def fetch(nn: int) -> bytes | None:
    """One curl per file, --retry 3, bounded time; reject tiny/truncated."""
    path = os.path.join(CACHE, f"greatscott{nn:02d}.xml")
    url = BASE.format(nn)
    for attempt in range(2):        # initial try + one retry
        if os.path.exists(path):
            blob = open(path, "rb").read()
            if looks_valid(blob):
                return blob
        subprocess.run(["curl", "-sSL", "--retry", "3", "--max-time", "120",
                        "-o", path, url], timeout=130)
        blob = open(path, "rb").read() if os.path.exists(path) else b""
        if looks_valid(blob):
            print(f"  downloaded {url} ({len(blob)} B)")
            continue
        if os.path.exists(path):
            os.remove(path)         # truncated/error page: force redownload
    print(f"  WARNING: giving up on {url}", flush=True)
    return None


def main() -> None:
    os.makedirs(CACHE, exist_ok=True)
    os.makedirs(OUT, exist_ok=True)
    buckets: dict[str, dict[str, dict[str, str]]] = {}
    n_entries = n_glossed = n_failed_files = 0

    for nn in range(2, 87):
        blob = fetch(nn)
        if blob is None:
            n_failed_files += 1
            continue
        raw = blob.decode("utf-8", errors="replace")
        for m in DIV2_RE.finditer(raw):
            attrs, body = m.group(1), m.group(2)
            km = KEY_RE.search(attrs)
            if not km:
                continue
            key = re.sub(r"\d+$", "", km.group(1).strip())
            if not key or not ALLOWED_KEY_RE.fullmatch(key):
                continue
            lemma = from_beta(key)
            if not GREEK_RE.search(lemma):
                continue
            n_entries += 1
            sm = SENSE1_RE.search(body) or SENSE_ANY_RE.search(body)
            if not sm:
                continue
            gloss = clean_gloss(sm.group(1))
            if not gloss:
                continue
            gloss = trunc180(gloss)
            lk = strip_accents(lemma)
            letter = shard_key(lemma)
            if letter is None or not lk or lk in buckets.get(letter, {}):
                continue
            buckets.setdefault(letter, {})[lk] = {"u": lemma, "g": gloss}
            n_glossed += 1
        if nn % 10 == 0 or nn == 86:
            print(f"greatscott{nn:02d}: cumulative entries={n_entries} "
                  f"glossed={n_glossed} letters={len(buckets)}", flush=True)

    total = 0
    for letter, d in sorted(buckets.items()):
        with open(os.path.join(OUT, f"{letter}.json"), "w",
                  encoding="utf-8") as fh:
            json.dump(d, fh, ensure_ascii=False, separators=(",", ":"))
        total += len(d)
    print(f"wrote {len(buckets)} files, {total} lemmas, "
          f"{n_failed_files} failed files")


if __name__ == "__main__":
    main()
