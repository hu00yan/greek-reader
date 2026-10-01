"""Tests for pipeline/lsj_gloss.py — the LSJ markup → short-English extractor.

Run: python3 pipeline/test_lsj_gloss.py
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from lsj_gloss import (  # noqa: E402
    GREEK_RE, clean_gloss, clean_xref, first_clauses, glosses_from_entry,
    strip_greek, tidy,
)

CASES: list[tuple[str, str, str]] = [
    # (name, sense/entry markup, expected)
    # The ";" is real LSJ punctuation between clauses and is kept; only the
    # Greek example and both citations go.
    ("citation apparatus is deleted",
     '<sense level="1">release, let go, ἧκα <cit><quote lang="grc">πόδας</quote>'
     ' <bibl>Od. 12.442</bibl></cit>; ἧκε <foreign lang="grc">φέρεσθαι</foreign>'
     ' let him float off, <bibl>Il. 21.120</bibl></sense>',
     "release, let go; let him float off"),

    ("greek example verbs are dropped",
     '<sense level="1">head, of men or animals, '
     '<foreign lang="grc">πολιόν τε κάρη</foreign> <bibl>Il. 22.74</bibl></sense>',
     "head, of men or animals"),

    # Regression: the orphan-tail cleaner used to eat the "s" of "sister's",
    # yielding "brother's or sister'".
    ("possessive is not truncated",
     "<i>brotherʼs</i> or <i>sisterʼs,</i> <cit><quote lang=\"grc\">αἷμα</quote>"
     " <bibl>A. Th. 718</bibl></cit>",
     "brother's or sister's"),

    ("orphan preposition tail is dropped",
     'unpleasant, cj. for <foreign lang="grc">τ</foreign> in'
     ' <foreign lang="grc">τ</foreign>.',
     "unpleasant, cj. for"),

    ("pure citation yields empty",
     "<bibl>Hsch.</bibl>, <bibl>Phot.</bibl>", ""),

    ("emphasis markup keeps its words",
     '<sense level="1">reflexive Pron., <i>self</i>:—'
     '<i>him, her, it</i></sense>',
     "reflexive Pron., self:—him, her, it"),

    ("curly apostrophes normalise",
     "<i>brotherʼs</i> <i>sisterʼs</i>", "brother's sister's"),

    # Roman-era / administrative lemmas: what is left after the <bibl>
    # deletion is a date range and nothing else.
    ("date-range citation is dropped",
     "tray, (iii A.D) , cf. (ii A.D) , (iii A.D) .", "tray"),
    ("date range with slash and spaced initials",
     "= Lat. (Lycosura), cf. (ii/iii A. D) .", "= Lat. (Lycosura)"),
    ("inscription reference is dropped",
     "in joiner's work, fillet, fascia, 50 (Delos , iii B.C), cf. ; "
     "a black band",
     "in joiner's work, fillet, fascia; a black band"),
    # A real citation in a well-formed <bibl> is removed by design; the point
    # of this case is that the surrounding gloss survives it untouched.
    ("a real gloss survives citation cleanup",
     "release, let go, <bibl>Il. 21.120</bibl>", "release, let go"),
    ("a bare number is not treated as a citation",
     "one, two", "one, two"),

    # A <foreign lang="lat"> is a Latin gloss, not Greek example text — 2,650
    # entries have one and they were being deleted as if they were Greek.
    ("latin gloss is kept, not deleted as greek",
     '<foreign lang="lat">abacus,</foreign> a counting board',
     "abacus, a counting board"),
]

XREF_CASES: list[tuple[str, str, str | None]] = [
    # (name, markup, expected clean_xref result — None = must fall through)
    ("plain-text variant target", "= τλήμων, <bibl>Ar. Av. 687</bibl>", "variant of τλήμων"),
    ("orth variant target", "= <orth lang=\"grc\">τιθάσσω</orth>, <bibl>S. Tr. 1</bibl>",
     "variant of τιθάσσω"),
    ("see-also entry lists every target",
     "v. θέσμιος, <orth lang=\"grc\">τεθμός</orth>, v. θεσμός.",
     "see θέσμιος, τεθμός, θεσμός"),
    ("latin target is not a variant", "= Lat. (Lycosura), cf. (ii/iii A.D) .", None),
    ("a real gloss is not a cross-reference", "loosen, release", None),
]

# End-to-end through the entry-level API, which tries clean_xref first.
XREF_ENTRY_CASES: list[tuple[str, str, list[str]]] = [
    ("variant entry survives the pipeline",
     '<sense level="1">= ἐπιτάρροθος, <bibl>Lyc. 360</bibl>,400, al.</sense>',
     ["variant of ἐπιτάρροθος"]),
    ("see-also entry survives the pipeline",
     '<sense level="1">v. θέσμιος, <orth lang="grc">τεθμός</orth>, v. θεσμός.</sense>',
     ["see θέσμιος, τεθμός, θεσμός"]),
    # Regression found by tools/sample-audit.mjs: the fixed 400-char slice cut
    # a <bibl> in half, and the orphaned "<bibl n="Perseus:abo:tlg" survived
    # tag-stripping and was emitted as literal text.
    ("a slice landing inside a tag leaks nothing",
     '<sense level="1">= ἄβαξ, <bibl n="Perseus:abo:tlg,0001,001:1"'
     ' default="NO"><author>Ap.</author> <title>Arg.</title> 1</bibl></sense>',
     ["variant of ἄβαξ"]),
    ("an already-orphaned tag is dropped",
     '<sense level="1">= ἀβίωτος, <bibl n="Perseus:abo:tlg</sense>',
     ["variant of ἀβίωτος"]),
]

ENTRY_CASES: list[tuple[str, str, list[str]]] = [
    ("headword and declension are not a gloss",
     '<head>αὐτός</head> (Cret. <orth>ἀϝτός</orth> <title>GDI</title> 4976, al.), '
     '<foreign lang="grc">αὐτή, αὐτό</foreign> (also <cit><quote lang="grc">αὐτόν</quote>'
     ' <bibl>Leg.Gort. 3.4</bibl></cit>), '
     '<sense level="1">reflexive Pron., <i>self</i></sense>',
     ["reflexive Pron., self"]),

    ("level-2 senses are kept, level-3 dropped",
     '<sense level="1">son of the same mother</sense>'
     '<sense level="2">brother</sense>'
     '<sense level="3">one who has the same father</sense>',
     ["son of the same mother", "brother"]),

    ("no sense at all yields nothing",
     '<head>κόρη</head>, <gen>τό</gen>', []),
]


def main() -> int:
    failed = 0
    for name, markup, want in CASES:
        got = clean_gloss(markup)
        ok = got == want
        failed += not ok
        print(f"  {'ok  ' if ok else 'FAIL'} {name}")
        if not ok:
            print(f"        got  {got!r}\n        want {want!r}")

    for name, markup, want in ENTRY_CASES:
        got = glosses_from_entry(markup)
        ok = got == want
        failed += not ok
        print(f"  {'ok  ' if ok else 'FAIL'} {name}")
        if not ok:
            print(f"        got  {got!r}\n        want {want!r}")

    print("\nclean_xref (variant / see-also detection)")
    for name, markup, want in XREF_CASES:
        got = clean_xref(markup)
        ok = got == want
        failed += not ok
        print(f"  {'ok  ' if ok else 'FAIL'} {name}")
        if not ok:
            print(f"        got  {got!r}\n        want {want!r}")

    for name, markup, want in XREF_ENTRY_CASES:
        got = glosses_from_entry(markup)
        ok = got == want
        failed += not ok
        print(f"  {'ok  ' if ok else 'FAIL'} {name}")
        if not ok:
            print(f"        got  {got!r}\n        want {want!r}")

    # unit-level invariants
    checks = [
        ("strip_greek keeps latin scaffolding",
         strip_greek("word, speech, Il. 9.443") == "word, speech, Il. 9.443"),
        ("strip_greek drops pure greek and its spacing",
         strip_greek("word, λόγος, speech") == "word, speech"),
        ("tidy collapses dangling citation tail",
         tidy("foo, ; ; cf. , etc.") == "foo"),
        ("tidy keeps meaningful text inside parens",
         tidy("foo (opp. bar) baz") == "foo (opp. bar) baz"),
        ("first_clauses cuts on a boundary, not mid-word",
         first_clauses("alpha beta gamma delta. epsilon zeta", 20).endswith("delta.")),
        ("first_clauses leaves short text alone",
         first_clauses("short", 120) == "short"),
    ]
    for name, ok in checks:
        failed += not ok
        print(f"  {'ok  ' if ok else 'FAIL'} {name}")

    print()
    if failed:
        print(f"{failed} FAILED")
        return 1
    print("all passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
