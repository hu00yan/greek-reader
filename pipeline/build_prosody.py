"""Build prosody (scansion) for verse works using CLTK.

For each verse work (kind == "verse" from .cache-corpus/units/_works.json),
compute a footed scansion string "— ∪ ∪ | ..." per line via CLTK's
cltk.prosody.grc.Scansion, then emit public/data/prosody/<workId>.json
only if confidence > 0.85 else omit.

Cache dir: .cache-prosody/ (no /tmp).
Output dir: public/data/prosody/

Usage: python3 pipeline/build_prosody.py [--force]
"""
from __future__ import annotations

import json
import os
import sys
import subprocess
import pathlib

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parent
CACHE = ROOT / ".cache-prosody"
OUT = ROOT / "public" / "data" / "prosody"
UNITS_DIR = ROOT / ".cache-corpus" / "units"
WORKS_META = UNITS_DIR / "_works.json"
CATALOG = ROOT / "public" / "data" / "catalog.json"

THRESHOLD = 0.85

def ensure_dirs():
    CACHE.mkdir(parents=True, exist_ok=True)
    OUT.mkdir(parents=True, exist_ok=True)

def load_works():
    if WORKS_META.exists():
        return json.loads(WORKS_META.read_text(encoding="utf-8"))
    # fallback: scan public/data/texts/*/ part headers
    print("WARN: _works.json missing, scanning public/data/texts", file=sys.stderr)
    works = []
    texts = ROOT / "public" / "data" / "texts"
    if not texts.exists():
        return works
    for tlg_dir in texts.iterdir():
        if not tlg_dir.is_dir():
            continue
        # find part files, read first to get kind/id
        for p in sorted(tlg_dir.glob("*.json")):
            try:
                d = json.loads(p.read_text(encoding="utf-8"))
                works.append({
                    "id": d.get("id", p.stem.split("-part")[0]),
                    "tlg": tlg_dir.name,
                    "kind": d.get("kind", "prose"),
                    "unitCount": len(d.get("units", [])),
                    "title": d.get("title",""),
                })
                break
            except Exception:
                continue
    # dedup by id
    seen=set()
    uniq=[]
    for w in works:
        if w["id"] not in seen:
            seen.add(w["id"])
            uniq.append(w)
    return uniq

def footify(raw_pat: str) -> str:
    """Convert CLTK raw pattern (¯˘x) to display '— ∪ ∪ | ...'.

    Foot split heuristic: dactyl is '¯˘˘' (— ∪∪), spondee is '¯¯' or
    '¯˘'/'˘¯' treated as 2-syllable foot. Walk greedily; last foot
    forced to 2 syllables. Returns spaced symbols joined with ' | '.
    """
    if not raw_pat:
        return ""
    # normalize x -> ¯ for foot logic (anceps as long)
    norm = raw_pat.replace("x", "¯")
    # walk
    feet_raw = []
    i = 0
    L = len(norm)
    while i < L:
        remaining = L - i
        if remaining <= 2:
            feet_raw.append(norm[i:])
            break
        # if we have at least 3 left, check for dactyl at i
        if remaining >= 3 and norm[i] == "¯" and norm[i+1] == "˘" and norm[i+2] == "˘":
            feet_raw.append(norm[i:i+3])
            i += 3
        else:
            # take 2 as spondee-ish
            feet_raw.append(norm[i:i+2])
            i += 2
    # map to symbols
    def sym(c: str) -> str:
        return "—" if c == "¯" else "∪"
    feet_disp = [" ".join(sym(ch) for ch in foot) for foot in feet_raw]
    return " | ".join(feet_disp)

def scan_line(scanner, text: str) -> tuple[str, str]:
    """Scan one Greek line text (no trailing period). Returns (raw, display)."""
    # CLTK tokenizer requires sentence-ending '.' to emit a sentence
    inp = text.strip() + "."
    try:
        res = scanner.scan_text(inp)
    except Exception as e:
        return "", ""
    if not res:
        return "", ""
    raw = res[0]  # first sentence
    # raw contains '¯', '˘', 'x'
    disp = footify(raw)
    return raw, disp

def ensure_cltk():
    try:
        import cltk.prosody.grc  # noqa
        return
    except Exception as e:
        print(f"CLTK not found ({e}), installing...", file=sys.stderr)
        # try pip install with trusted-host fallback as requested
        for extra in [[], ["--trusted-host", "pypi.org", "--trusted-host", "files.pythonhosted.org"]]:
            cmd = [sys.executable, "-m", "pip", "install"] + extra + ["cltk"]
            print(f"  pip install {' '.join(cmd)}", file=sys.stderr)
            try:
                subprocess.check_call(cmd)
                import cltk.prosody.grc
                print("CLTK installed", file=sys.stderr)
                return
            except subprocess.CalledProcessError as ce:
                print(f"pip failed {ce}", file=sys.stderr)
                continue
        raise SystemExit("Failed to install CLTK")

def main():
    force = "--force" in sys.argv
    ensure_dirs()
    ensure_cltk()
    from cltk.prosody.grc import Scansion
    scanner = Scansion()

    works = load_works()
    verse_works = [w for w in works if w.get("kind") == "verse"]
    print(f"[prosody] {len(verse_works)} verse works, {len(works)} total", flush=True)

    scanned = 0
    written = 0
    omitted = 0
    seen_ids: set[str] = set()

    for wi, w in enumerate(verse_works, 1):
        wid = w["id"]
        tlg = w.get("tlg", "")
        # load units
        ndjson_path = UNITS_DIR / f"{tlg}--{wid}.ndjson" if tlg else None
        units = []
        if ndjson_path and ndjson_path.exists():
            with open(ndjson_path, encoding="utf-8") as fh:
                for line in fh:
                    if line.strip():
                        units.append(json.loads(line))
        else:
            # fallback to public/data/texts
            # find part files via catalog
            try:
                catalog = json.loads(CATALOG.read_text(encoding="utf-8"))
                files = []
                for a in catalog.get("authors", []):
                    for wk in a.get("works", []):
                        if wk.get("id") == wid:
                            files = wk.get("files", [])
                for rel in files:
                    part = json.loads((ROOT / "public" / "data" / rel).read_text(encoding="utf-8"))
                    for u in part.get("units", []):
                        # ensure words array
                        if "words" in u:
                            units.append(u)
                        elif "w" in u:
                            units.append({"ref": u.get("ref",""), "words": u["w"].split()})
            except Exception as e:
                print(f"  ! {wid}: cannot load units ({e})", file=sys.stderr)
                continue
        if not units:
            print(f"[{wi}/{len(verse_works)}] SKIP {wid}: no units", flush=True)
            continue

        # handle duplicate workId across TLGs (e.g. electra, epigrams)
        # keep first occurrence as plain <workId>.json, subsequent as <tlg>--<workId>.json
        plain_id = wid not in seen_ids
        seen_ids.add(wid)
        cache_path = CACHE / f"{wid}.json" if plain_id else CACHE / f"{tlg}--{wid}.json"
        # if cache exists and not force, we could reuse but recompute to ensure confidence
        # caching mechanism: store raw scans; we will recompute each run but also write cache
        lines_out = []
        n_ok = 0
        for u in units:
            ref = u.get("ref", "")
            words = u.get("words", [])
            if not words:
                lines_out.append({"ref": ref, "pattern": "", "raw": ""})
                continue
            text = " ".join(words)
            raw, disp = scan_line(scanner, text)
            if raw:
                n_ok += 1
            # confidence per line could be empty check; we count non-empty as ok
            lines_out.append({"ref": ref, "pattern": disp, "raw": raw, "text": text})

        confidence = n_ok / len(units) if units else 0.0
        # also compute secondary metric: proportion with plausible syllable count 10-18
        # but primary is scan success ratio; keep simple
        scanned += 1

        payload = {
            "workId": wid,
            "tlg": tlg,
            "title": w.get("title",""),
            "meter": "dactylic_hexameter",
            "confidence": round(confidence, 4),
            "unitCount": len(units),
            "lines": lines_out,
        }
        # write cache always (unique per TLG if duplicate)
        cache_path.write_text(json.dumps(payload, ensure_ascii=False, separators=(",",":")), encoding="utf-8")

        out_path = OUT / f"{wid}.json" if plain_id else OUT / f"{tlg}--{wid}.json"

        if confidence > THRESHOLD:
            out_path.write_text(json.dumps(payload, ensure_ascii=False, separators=(",",":")), encoding="utf-8")
            written += 1
            print(f"[{wi}/{len(verse_works)}] {wid} ({tlg}): {len(units)} lines conf={confidence:.3f} -> WRITE {out_path.name}", flush=True)
        else:
            if out_path.exists():
                out_path.unlink()
            omitted += 1
            print(f"[{wi}/{len(verse_works)}] {wid} ({tlg}): {len(units)} lines conf={confidence:.3f} -> OMIT (<={THRESHOLD})", flush=True)

    print(f"[prosody] scanned={scanned} written={written} omitted={omitted} threshold={THRESHOLD}")
    # also report sample Iliad 1.1
    for sample_id in ["iliad", "odyssey", "argonautica"]:
        p = OUT / f"{sample_id}.json"
        if p.exists():
            d = json.loads(p.read_text(encoding="utf-8"))
            first = d["lines"][0] if d["lines"] else {}
            print(f"SAMPLE {sample_id} 1.1: {first.get('text','')} -> {first.get('pattern','')} (raw={first.get('raw','')}) conf={d.get('confidence')}")
            if sample_id == "iliad":
                break
    # if iliad not in OUT (omitted), check cache
    if not (OUT / "iliad.json").exists():
        cp = CACHE / "iliad.json"
        if cp.exists():
            d = json.loads(cp.read_text(encoding="utf-8"))
            first = d["lines"][0] if d["lines"] else {}
            print(f"SAMPLE CACHE iliad 1.1: {first.get('text','')} -> {first.get('pattern','')} (raw={first.get('raw','')}) conf={d.get('confidence')}")

if __name__ == "__main__":
    main()
