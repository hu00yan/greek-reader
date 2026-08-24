#!/usr/bin/env python3
"""Build public/data/search-index-grc.json: a build-time INVERTED INDEX over
the COMMITTED corpus at public/data/texts/<tlg>/<work>*.json, answering
"which WORKS contain this Greek word?" (所在作品). Reads only files that are
in git, so it works on clean CI/CF build images (no local caches).

Normalization matches src/api.ts stripAccents + final-sigma folding:
lowercase, NFD, drop combining marks, ς→σ.

Shape (compact arrays to keep bytes down):
  {"v": 1,
   "g": ["tlg0012", ...],                 # tlg id per index i
   "w": ["iliad", ...],                   # workId per index j
   "e": { "<norm-word>": [totalOccurrences,
                          [[widIdx, firstRef], ...]] }, ...}

Per word: works sorted by occurrence desc, CAPPED at MAX_WORKS_PER_WORD=30;
single-letter forms are skipped. If the raw file exceeds MAX_BYTES (25MB),
the ref cap is tightened until it fits.
"""
import json
import os
import re
import unicodedata

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TEXTS = os.path.join(HERE, "public", "data", "texts")
OUT = os.path.join(HERE, "public", "data", "search-index-grc.json")
MAX_BYTES = 25_000_000
MAX_WORKS_PER_WORD = 30

_strip_re = re.compile(r"[\u0300-\u036f]+", re.UNICODE)


def norm(tok: str) -> str:
    s = unicodedata.normalize("NFD", tok.lower())
    s = _strip_re.sub("", s)
    return s.replace("ς", "σ")


def iter_units():
    """Yield (tlg, workId, ref, words) from every committed texts file.
    Tolerates both unit shapes: {ref, words:[...]} and {ref, w:"a b c"}."""
    for tlg in sorted(os.listdir(TEXTS)):
        tdir = os.path.join(TEXTS, tlg)
        if not os.path.isdir(tdir):
            continue
        for fname in sorted(os.listdir(tdir)):
            m = re.match(r"^(.+)-part\d+\.json$", fname)
            wid = m.group(1) if m else fname[:-5]
            path = os.path.join(tdir, fname)
            try:
                doc = json.load(open(path, encoding="utf-8"))
            except (json.JSONDecodeError, UnicodeDecodeError):
                print(f"  ! skipping unreadable {path}")
                continue
            for u in doc.get("units", []):
                ref = u.get("ref") or ""
                words = u.get("words")
                if not words and isinstance(u.get("w"), str):
                    words = u["w"].split(" ")
                yield tlg, wid, ref, (words or [])


def build(ref_cap: int) -> dict:
    index: dict[str, dict[str, list]] = {}
    tlgs: dict[str, int] = {}
    wids: dict[str, int] = {}
    for tlg, wid, ref, words in iter_units():
        if tlg not in tlgs:
            tlgs[tlg] = len(tlgs)
        if wid not in wids:
            wids[wid] = len(wids)
        wk = f"{tlg}/{wid}"
        for tok in words:
            k = norm(tok)
            if len(k) < 2:
                continue
            slot = index.setdefault(k, {})
            ent = slot.get(wk)
            if ent is None:
                slot[wk] = [1, ref]
            else:
                ent[0] += 1
    glist = sorted(tlgs, key=tlgs.get)
    wlist = sorted(wids, key=wids.get)
    e: dict[str, list] = {}
    for k, works in index.items():
        ranked = sorted(works.items(),
                        key=lambda kv: -kv[1][0])[:MAX_WORKS_PER_WORD]
        total = sum(c for _, (c, _) in works.items())
        e[k] = [
            total,
            [[wids[wk.split("/", 1)[1]], (meta[1] or "")[:24]]
             for wk, meta in ranked][:ref_cap],
        ]
    return {"v": 1, "g": glist, "w": wlist, "e": e}


def main() -> None:
    ref_cap = 8
    while True:
        doc = build(ref_cap)
        raw = json.dumps(doc, ensure_ascii=False, separators=(",", ":"))
        size = len(raw.encode())
        print(f"[grc-index] refCap={ref_cap}: {len(doc['e'])} entries, "
              f"{size/1e6:.1f}MB raw")
        if size <= MAX_BYTES or ref_cap <= 1:
            break
        ref_cap = max(1, ref_cap // 2)
    with open(OUT, "w", encoding="utf-8") as fh:
        fh.write(raw)
    print(f"[grc-index] wrote {OUT} ({size/1e6:.1f}MB raw)")


if __name__ == "__main__":
    main()
