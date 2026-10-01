"""Build LSJ gloss index from helmadik/LSJLogeion greatscottNN.xml files.

The XML is loose SGML, so we parse with regex rather than ElementTree:
each entry is a <div2 key="..."> ... </div2>; the gloss is the first
level-1 <sense>.  Keys are Beta Code; we convert to Unicode and index by
strip_accents(lemma) for accent-insensitive lookup from the frontend.

The repo ships greatscott01..86 (01 = front matter); 02..86 are entries
covering the whole alphabet (02-11 alpha ... ending omega).

Output: public/data/gloss/{a-z}.json
  {strippedLemma: {"u": lemma, "g": firstSense, "s": [extra senses]}}

Gloss text comes from lsj_gloss.glosses_from_entry, which strips LSJ's
<bibl>/<cit>/<foreign> markup so a gloss is the English sense and not a
citation slab. "g" stays a plain string for the reader's collapsed card; "s"
is optional extra senses for the expanded card and the side panel.
"""
from __future__ import annotations

import hashlib
import html
import json
import os
import re
import subprocess
import sys

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(REPO, "pipeline"))
from betacode import from_beta, shard_key, strip_accents  # noqa: E402
from lsj_gloss import glosses_from_entry  # noqa: E402

_EXTRACTOR_FP: str | None = None


def extractor_fingerprint() -> str:
    """Hash of lsj_gloss.py, so editing the extractor drops every cache entry.

    Read once per process. Cheap (a few KB) and removes the whole class of
    "I changed the rules but the cache served stale output" bugs.
    """
    global _EXTRACTOR_FP
    if _EXTRACTOR_FP is None:
        path = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                            "lsj_gloss.py")
        with open(path, "rb") as fh:
            _EXTRACTOR_FP = hashlib.sha256(fh.read()).hexdigest()[:16]
    return _EXTRACTOR_FP

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
ALLOWED_KEY_RE = re.compile(r"[*(a-z)\=/\\+|_^]+")
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


def extract_file(nn: int) -> tuple[dict[str, dict[str, object]], int] | None:
    """(entries by stripped key, n_entries seen) for one LSJ source file.

    The 25 greatscott files are independent and only one or two ever change
    between runs, so re-running the sense extractor over all 117k entries to
    pick up a one-file change is wasted work. Cache the per-file EXTRACTION
    (not the merged shards) and re-merge every run — merging is cheap and
    keeps the "first entry wins" dedup order authoritative, which a
    per-shard cache would not.

    The cache key covers the file's size+mtime AND a hash of lsj_gloss.py, so
    editing the extractor invalidates every entry automatically.
    """
    blob = fetch(nn)
    if blob is None:
        return None
    path = os.path.join(CACHE, f"greatscott{nn:02d}.xml")
    st = os.stat(path)
    fingerprint = [st.st_size, int(st.st_mtime), extractor_fingerprint()]

    cache_path = os.path.join(CACHE, f"extract-{nn:02d}.json")
    try:
        with open(cache_path, encoding="utf-8") as fh:
            cached = json.load(fh)
        if cached.get("fingerprint") == fingerprint:
            return cached["entries"], cached["n_entries"]
    except (OSError, ValueError, KeyError):
        pass

    raw = blob.decode("utf-8", errors="replace")
    entries: dict[str, dict[str, object]] = {}
    n_entries = 0
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
        # lsj_gloss reads the whole entry and strips <bibl>/<cit>/<foreign>
        # markup, so what lands in "g" is the English sense itself rather
        # than a Greek-citation slab. Extra senses ride along in "s".
        senses = glosses_from_entry(body)
        if not senses:
            continue
        lk = strip_accents(lemma)
        if not lk or lk in entries:
            continue
        entry: dict[str, object] = {"u": lemma, "g": senses[0]}
        if len(senses) > 1:
            entry["s"] = senses[1:]
        entries[lk] = entry
    try:
        with open(cache_path, "w", encoding="utf-8") as fh:
            json.dump({"fingerprint": fingerprint, "n_entries": n_entries,
                       "entries": entries}, fh, ensure_ascii=False)
    except OSError:
        pass          # cache is an optimisation, never a hard failure
    return entries, n_entries


def main() -> None:
    os.makedirs(CACHE, exist_ok=True)
    os.makedirs(OUT, exist_ok=True)
    buckets: dict[str, dict[str, dict[str, object]]] = {}
    n_entries = n_glossed = n_failed_files = 0

    for nn in range(2, 87):
        got = extract_file(nn)
        if got is None:
            n_failed_files += 1
            continue
        entries, n_seen = got
        n_entries += n_seen
        for lk, entry in entries.items():
            letter = shard_key(entry["u"])
            if letter is None or lk in buckets.get(letter, {}):
                continue
            buckets.setdefault(letter, {})[lk] = entry
            n_glossed += 1
        if nn % 20 == 0 or nn == 86:
            print(f"greatscott{nn:02d}: cumulative entries={n_entries} "
                  f"glossed={n_glossed} letters={len(buckets)}", flush=True)

    total = 0
    # Only rewrite a shard when its content actually changed, so an unchanged
    # run does not churn 14 MB of JSON (and does not invalidate downstream
    # build steps that watch mtimes).
    written = 0
    for letter, d in sorted(buckets.items()):
        path = os.path.join(OUT, f"{letter}.json")
        payload = json.dumps(d, ensure_ascii=False, separators=(",", ":"))
        total += len(d)
        try:
            with open(path, encoding="utf-8") as fh:
                if fh.read() == payload:
                    continue
        except OSError:
            pass
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(payload)
        written += 1
    print(f"wrote {len(buckets)} files ({written} changed), {total} lemmas, "
          f"{n_failed_files} failed files")


if __name__ == "__main__":
    main()
