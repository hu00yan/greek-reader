"""Crunch every unanalysed form found in cached corpus part files.

Scans public/data/texts/<tlg>/<work>-partNN.json, collects unique Greek
word tokens whose accent-stripped key is absent (or empty) from the
current morph shards, and batch-analyses them through the Morpheus
cruncher, MERGING results into the shards incrementally so partial
progress survives interruption.  Time-capped.

Usage:  python3 pipeline/crunch_cached_parts.py [max_seconds]
"""

from __future__ import annotations

import json
import os
import re
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)

import betacode  # noqa: E402
from build_work import MORPH_DIR, DATA, parse_record  # noqa: E402

TEXTS = os.path.join(DATA, "texts")
GREEK_RE = re.compile(r"[\u0370-\u03ff\u1f00-\u1fff]")

CRUNCHER = "/Users/huyan00/mycode/tools/morpheus/bin/cruncher"
MORPHLIB = "/Users/huyan00/mycode/tools/morpheus/stemlib"


def _crunch_all(unique_beta):
    """Single long-lived cruncher process for ALL forms (perf contract:
    never spawn per word / per chunk). Streams every form through one
    stdin pipe while stdout is consumed concurrently; forms are matched
    to analyses by the echo-sync walk used across the pipeline."""
    import subprocess
    import threading
    t0 = time.time()
    n = len(unique_beta)
    buckets = {f: [] for f in unique_beta}
    env = dict(os.environ, MORPHLIB=MORPHLIB)
    proc = subprocess.Popen(
        [CRUNCHER], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
        stderr=subprocess.PIPE, text=True, encoding="utf-8",
        errors="replace", env=env)
    stdin_f, stdout_f, stderr_f = proc.stdin, proc.stdout, proc.stderr

    def feed():
        try:
            for i in range(0, n, 2000):
                stdin_f.write("\n".join(unique_beta[i:i + 2000]) + "\n")
                stdin_f.flush()
        except BrokenPipeError:
            pass
        finally:
            try:
                stdin_f.close()
            except BrokenPipeError:
                pass

    err_buf = []

    def drain_err():
        err_buf.append(stderr_f.read() or "")

    threading.Thread(target=feed, daemon=True).start()
    threading.Thread(target=drain_err, daemon=True).start()

    # O(1) echo lookup: cruncher silently DROPS some lines (junk betas,
    # strict-case rejects emit only ':longtime' debug), so positional
    # window sync desyncs permanently; dict jumps skip any gap.
    beta_index = {b: i for i, b in enumerate(unique_beta)}
    ptr = -1
    seen = 0
    last_report = t0
    for raw in stdout_f:
        line = raw.strip()
        if not line or line.startswith(":"):
            continue
        idx = beta_index.get(line)
        if idx is not None and idx > ptr:
            ptr = idx
        if ptr >= 0:
            for rec in re.findall(r"<NL>(.*?)</NL>", line):
                parsed = parse_record(rec)
                if parsed:
                    buckets[unique_beta[ptr]].append(parsed)
        if ptr + 1 > seen:
            seen = ptr + 1
            now = time.time()
            if seen == n or now - last_report >= 15:
                rate = seen / max(now - t0, 0.001)
                print(f"[CRUNCH] {seen}/{n} ({now - t0:.0f}s, "
                      f"{rate:.0f}/s)", flush=True)
                last_report = now

    stdout_f.close()
    proc.wait()
    dt = time.time() - t0
    print(f"[CRUNCH] done {seen}/{n} in {dt:.0f}s "
          f"({seen / dt if dt else 0:.0f}/s) rc={proc.returncode}",
          flush=True)
    return buckets


def valid_beta(b: str) -> bool:
    return VALID_BETA_RE.fullmatch(b) is not None


def load_shards():
    shards = {}
    for fn in os.listdir(MORPH_DIR):
        if fn.endswith(".json"):
            with open(os.path.join(MORPH_DIR, fn), encoding="utf-8") as fh:
                shards[fn[:-5]] = json.load(fh)
    return shards


# extra edge punctuation found in corpus tokens (Greek ano teleia variant,
# Greek question mark, dashes that survive tokenisation)
EXTRA_PUNCT = "\u0387\u037e\u2014\u02bc'’"
# a feedable beta string: letter/capital first, then letters+marks+elision
VALID_BETA_RE = re.compile(r"[*a-z][a-z*'()\\/=+|]*$")


def save_shards(shards):
    for letter, table in shards.items():
        with open(os.path.join(MORPH_DIR, f"{letter}.json"), "w",
                  encoding="utf-8") as fh:
            json.dump(table, fh, ensure_ascii=False, sort_keys=True,
                      separators=(",", ":"))


def main():
    t0 = time.time()
    shards = load_shards()
    # keys of every analysed form across letters (letters themselves are
    # shard filenames, not lookup keys)
    known = {k for tbl in shards.values() for k, v in tbl.items() if v}
    todo = {}          # stripped key -> example raw form
    files_scanned = 0
    for dirpath, _, filenames in os.walk(TEXTS):
        for fn in filenames:
            if not fn.endswith(".json"):
                continue
            files_scanned += 1
            with open(os.path.join(dirpath, fn), encoding="utf-8") as fh:
                try:
                    part = json.load(fh)
                except Exception as e:  # noqa: BLE001
                    print(f"skip {fn}: {e}")
                    continue
            for u in part.get("units", []):
                for w in u.get("words", []):
                    w = w.strip(EXTRA_PUNCT)
                    if not w or not GREEK_RE.search(w):
                        continue
                    k = betacode.strip_accents(w)
                    if k not in known and k not in todo:
                        todo[k] = w
    print(f"{files_scanned} part files, {len(todo)} forms needing analysis")

    # feed each form twice: original case + accent-stripped lowercase fold
    # (strict-case cruncher rejects capitalised common nouns)
    beta_of = {}
    n_reject = 0
    for w in set(todo.values()):
        b = betacode.to_beta(w)
        fb = betacode.to_beta(betacode.strip_accents(w))
        pair = tuple(x for x in (b, fb if fb != b else None)
                     if x and valid_beta(x))
        if not pair:
            n_reject += 1        # unfeedable junk (dashes, stray marks)
            continue
        beta_of[w] = pair
    print(f"{len(beta_of)} feedable forms ({n_reject} rejected as junk)")
    beta_forms = sorted({b for pair in beta_of.values() for b in pair})
    def crunch(fs):
        """Single long-lived cruncher process for ALL forms (perf contract:
        no per-chunk subprocess spawns)."""
        return _crunch_all(fs)

    def merge(analyses):
        n = 0
        for w, pair in beta_of.items():
            parses = next((analyses.get(x) or [] for x in pair),
                          [])
            if not parses:
                continue
            key = betacode.strip_accents(w)
            letter = betacode.shard_key(key)
            if letter is None:
                continue
            compact = [{"l": p["l"], "p": p["p"], "f": p["f"],
                        **({"x": p["x"]} if p["x"] else {})} for p in parses]
            shards.setdefault(letter, {})
            if key not in shards[letter] or not shards[letter][key]:
                n += 1
            shards[letter][key] = compact
        save_shards(shards)
        return n

    added = merge(crunch(beta_forms))
    print(f"pass 1: +{added} entries "
          f"({time.time() - t0:.0f}s)")

    remaining = {k: w for k, w in todo.items()
                 if w in beta_of and not (shards.get(k) or [])}
    print(f"retrying {len(remaining)} still-unanalysed")
    retry_beta = sorted(
        {b for w in remaining.values() for b in beta_of[w] if b})
    added += merge(crunch(retry_beta)) if retry_beta else 0

    total = sum(len(t) for t in shards.values())
    print(f"DONE: +{added} entries this run -> {total} total "
          f"({time.time() - t0:.0f}s)")


if __name__ == "__main__":
    main()
