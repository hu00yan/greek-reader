#!/usr/bin/env python3
"""Build public/data/search-index.json: a normalized full-text index over
the TRANSLATION corpus (public/data/trans/*.json), for client-side
"which work contains this phrase?" search.

Shape (compact arrays, ~1/3 the bytes of objects):
  {"v": 1,
   "w": ["1-corinthians", ...],            # workId per index i
   "e": [[i, "10.1", "normalized snippet text"], ...]}

Snippets are sentence-ish (split on .!?;:, short ones merged forward, long
ones windowed at ~240 chars). Text is normalized exactly like the frontend:
lowercase, punctuation -> space, whitespace collapsed — so a query normalized
the same way substring-matches reliably.

If the raw file would exceed MAX_BYTES (25 MB), fall back to capped mode:
within each work, keep a snippet only if >=500 normalized chars passed since
the last kept one (first-occurrence bias).
"""
import json
import os
import re

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(HERE, "public", "data")
MAX_BYTES = 25 * 1024 * 1024

_norm_re = re.compile(r"[^\w\s]+", re.UNICODE)


def norm(s: str) -> str:
    return re.sub(r"\s+", " ", _norm_re.sub(" ", s.lower())).strip()


def snippets(text: str):
    """Sentence-ish snippets of <=240 chars."""
    parts = re.split(r"(?<=[.!?;:])\s+", text.strip())
    out: list[str] = []
    buf = ""
    for p in parts:
        buf = f"{buf} {p}".strip() if buf and len(buf) < 40 else p
        if len(buf) >= 40:
            out.append(buf)
            buf = ""
    if buf:
        out.append(buf)
    for s in out:
        while len(s) > 240:
            cut = s.rfind(" ", 160, 240)
            cut = cut if cut > 0 else 240
            yield s[:cut]
            s = s[cut:].lstrip()
        if s:
            yield s


def build(capped: bool) -> dict:
    catalog = json.load(open(os.path.join(DATA, "catalog.json"),
                             encoding="utf-8"))
    order: dict[str, int] = {}
    for a in catalog["authors"]:
        for w in a["works"]:
            order[w["id"]] = len(order)
    tdir = os.path.join(DATA, "trans")
    works: list[str] = []
    entries: list[list] = []
    since_keep: dict[str, int] = {}  # workId -> chars since last kept snippet
    for name in sorted(os.listdir(tdir)):
        if not name.endswith(".json"):
            continue
        wid = name[:-5]
        idx = order.get(wid)
        if idx is None:
            continue
        doc = json.load(open(os.path.join(tdir, name), encoding="utf-8"))
        n = 0
        for u in doc.get("units", []):
            txt = u.get("text") or ""
            ref = u.get("ref") or ""
            if not txt or not ref:
                continue
            for sn in snippets(txt):
                ns = norm(sn)
                gap = since_keep.get(wid, 500)
                if len(ns) < 15 or (capped and gap < 500 and n > 0):
                    since_keep[wid] = gap + len(ns)
                    continue
                entries.append([idx, ref, ns])
                since_keep[wid] = 0
                n += 1
        if n:
            works.append(wid)
    return {"v": 1, "w": works, "e": entries}


def main() -> None:
    doc = build(capped=False)
    raw = json.dumps(doc, ensure_ascii=False, separators=(",", ":"))
    if len(raw.encode()) > MAX_BYTES:
        print(f"[search-index] raw {len(raw)/1e6:.1f}MB > cap; capping")
        doc = build(capped=True)
        raw = json.dumps(doc, ensure_ascii=False, separators=(",", ":"))
    out = os.path.join(DATA, "search-index.json")
    with open(out, "w", encoding="utf-8") as fh:
        fh.write(raw)
    print(f"[search-index] {out}: {len(doc['w'])} works, "
          f"{len(doc['e'])} snippets, {len(raw)/1e6:.1f}MB raw")


if __name__ == "__main__":
    main()
