# Local patches to PerseusDL/morpheus

This directory documents (and, in `0001-local.patch`, records) the local
modifications we apply to [PerseusDL/morpheus](https://github.com/PerseusDL/morpheus)
so that the `cruncher` binary builds and runs cleanly on macOS.

Upstream is © the Perseus Digital Library, Tufts University and licensed
**CC BY-SA 3.0 US**. These patches change build plumbing only; they add no
new lexical data and are therefore distributed under the same license.

## Why patches are needed

1. **macOS (clang) compile flags.** Upstream expects an old GCC; modern
   clang rejects several K&R-isms. We compile with `-std=gnu89` and
   downgrade assorted warnings (`-Wno-implicit-function-declaration`,
   `-Wno-return-type`, …) instead of rewriting 1990s C wholesale.
2. **Hardened libc conflicts.** Overlapping `strcpy`/`Xstrncpy` calls in
   `gener/`, `gkends/` and `retr/` are undefined behaviour under
   `_FORTIFY_SOURCE=3` (default on current Apple toolchains) and abort at
   runtime. We replace the affected overlapping copies with `memmove` and
   build with `-U_FORTIFY_SOURCE`.
3. **Missing generated tables.** The endtable sources
   `source/pers_pron.end`, `pron_adj1.end`, `pron_adj3.end` are not in the
   upstream tree; we ship minimal stubs so `make` completes.

## Applying

From a checkout of PerseusDL/morpheus:

```sh
git apply /path/to/greek-reader/third_party/morpheus-patches/0001-local.patch
make          # with MORPHLIB pointed at stemlib/
```

The pipeline only needs `bin/cruncher` plus the untouched `stemlib/`
directory.
