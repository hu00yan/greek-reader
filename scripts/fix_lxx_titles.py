#!/usr/bin/env python3
"""Patch shipped static data with reader-friendly canonical titles.

build_corpus.py normalizes titles via canonical_title(): LXX (tlg0527) works
get dual "English / Lat. Traditional" names, New Testament (tlg0031) works get
a Greek traditional title in parens. This script applies the same mapping to
the already-built tree in place:

  - public/data/catalog.json            work titles under tlg0527/tlg0031
  - public/data/texts/{tlg0527,tlg0031}/*.json   part-header "title" (line 1)
  - .cache-corpus/*.meta.json + _works.json   so future `emit` stays fixed

Idempotent: re-running reports 0 changes. Exits non-zero if any tlg0527 id
lacks a canonical mapping.
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(HERE, "pipeline"))

from build_corpus import LXX_TITLES, canonical_title  # noqa: E402

DATA = os.path.join(HERE, "public", "data")
CACHE = os.path.join(HERE, ".cache-corpus")
TLGS = ("tlg0527", "tlg0031")


def main() -> int:
    missing = []
    changed = {"catalog": 0, "headers": 0, "cache": 0}

    # ---- catalog.json -------------------------------------------------
    cat_path = os.path.join(DATA, "catalog.json")
    catalog = json.load(open(cat_path, encoding="utf-8"))
    for author in catalog["authors"]:
        if author["tlg"] not in TLGS:
            continue
        for w in author["works"]:
            want = canonical_title(author["tlg"], w["id"], w["title"])
            if author["tlg"] == "tlg0527" and w["id"] not in LXX_TITLES:
                missing.append(w["id"])
                continue
            if w["title"] != want:
                w["title"] = want
                changed["catalog"] += 1
    with open(cat_path, "w", encoding="utf-8") as fh:
        json.dump(catalog, fh, ensure_ascii=False, separators=(",", ":"))
        fh.write("\n")

    # ---- part-file headers (title lives on line 1 of each NDJSON-ish file)
    for tlg in TLGS:
        tdir = os.path.join(DATA, "texts", tlg)
        if not os.path.isdir(tdir):
            continue
        for name in sorted(os.listdir(tdir)):
            if not name.endswith(".json"):
                continue
            wid = name.rsplit("-part", 1)[0]
            path = os.path.join(tdir, name)
            with open(path, encoding="utf-8") as fh:
                header_raw = fh.readline()
            header = json.loads(header_raw)
            want = canonical_title(tlg, wid, header.get("title", ""))
            if header.get("title") != want:
                header["title"] = want
                body = open(path, encoding="utf-8").read()
                new = json.dumps(header, ensure_ascii=False,
                                 separators=(",", ":")) + body[len(header_raw):]
                with open(path, "w", encoding="utf-8") as fh:
                    fh.write(new)
                changed["headers"] += 1

    # ---- parse-stage cache metas --------------------------------------
    if os.path.isdir(CACHE):
        for name in sorted(os.listdir(CACHE)):
            path = os.path.join(CACHE, name)
            if not name.endswith(".meta.json"):
                continue
            tlg, wid = name[:7], name[8:-10]
            meta = json.load(open(path, encoding="utf-8"))
            want = canonical_title(tlg, wid, meta.get("title", ""))
            if meta.get("title") != want:
                meta["title"] = want
                with open(path, "w", encoding="utf-8") as fh:
                    json.dump(meta, fh, ensure_ascii=False, indent=1)
                changed["cache"] += 1
        works_path = os.path.join(CACHE, "_works.json")
        if os.path.exists(works_path):
            metas = json.load(open(works_path, encoding="utf-8"))
            n = 0
            for meta in metas:
                want = canonical_title(meta["tlg"], meta["id"],
                                       meta.get("title", ""))
                if meta.get("title") != want:
                    meta["title"] = want
                    n += 1
            if n:
                with open(works_path, "w", encoding="utf-8") as fh:
                    json.dump(metas, fh, ensure_ascii=False)
                changed["cache"] += n

    print(f"[fix_titles] changed={changed} "
          f"(catalog/headers/cache); unmapped={missing}")
    return 1 if missing else 0


if __name__ == "__main__":
    sys.exit(main())
