# UI v2 fonts (next/font/local)

Loaded by `src/ui/v2/font-loader.ts`. Source: Round 2 pack `assets/fonts/` (copied byte-for-byte; the pack has no
top-level `fonts/`). All families: SIL Open Font License 1.1 — licence text alongside (`OFL-*.txt`, ADR-012 OK:
permissive, no copyleft dependency). Round 7 D1: the body face is **IBM Plex Sans** and Inter has left v2 entirely
(v1 still loads Inter in `src/app/layout.tsx`; nothing under `src/ui/v2` references it — asserted in `fonts.test.ts`).
The TTFs below are the unmodified pack masters (kept, not loaded). What ships to the browser are the Latin woff2 subsets in
`latin/`, generated from them (no repo dependency; tool below).

| File | Licence file | SHA-256 |
|---|---|---|
| `BarlowCondensed-Bold.ttf` | `OFL-barlowcondensed.txt` | 53550669f93c07de6221e051905462f862066459eb50148268b5628104a58a30 |
| `IBMPlexMono-Regular.ttf` | `OFL-ibmplexmono.txt` | ab08018ccd276b79fb2c636bb95b9c543598f9d50505fe92506fcb4dae7810cd |
| `IBMPlexMono-Medium.ttf` | `OFL-ibmplexmono.txt` | 8ae925744d53758b67a77ea35c2fc46d7b688c7d8c04da3b579902bed0ca0e17 |
| `IBMPlexMono-Bold.ttf` | `OFL-ibmplexmono.txt` | dbd2a2fb024579438d6400a84e57579bfd2dbe67c306c8fd9fde92a61e4f2eea |
| `IBMPlexSans-wght400-700.woff2` | `OFL-ibmplexsans.txt` | 23c481d845e75a6e77bfab7ed0e9a9d4f586fb5e3884a31e4c05562e2a27842c |

`IBMPlexSans-wght400-700.woff2` (66 976 B) is the Round 7 pack's `landing/landing/fonts/` file, byte-for-byte: a variable
woff2 (wght 400–700, Latin + Cyrillic, 549 glyphs), so there is no TTF master for it. The pack ships no licence file for it;
`OFL-ibmplexsans.txt` is the same IBM Plex OFL 1.1 text as `OFL-ibmplexmono.txt` (same copyright holder, same Reserved Font
Name "Plex") — flagged for the Architect in the PR feedback.

Caveat (`--font-hand`, pack §4) is not loaded: the hand underline is an inline SVG and no commit here needs the typeface.

## Latin subset (what `font-loader.ts` loads)
Tool: **`pyftsubset` from fontTools 4.62.1** (+ brotli 1.2.1) run from a throwaway Python venv OUTSIDE the repo — no entry in
`package.json` / the lockfile (ADR-012: nothing added to the dependency graph). Reproduce, from this directory:

```
UNI='U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+2074,U+20AC,U+2122,U+2190-2199,U+2212,U+2215,U+FEFF,U+FFFD'
pyftsubset <Face>.ttf --unicodes="$UNI" --flavor=woff2 --layout-features='*' --no-hinting --desubroutinize --output-file=latin/<Face>.latin.woff2
```
(`UNI` = Google Fonts' `latin` range + arrows U+2190–2199 for `→ ↗`.) Layout features are kept (`*`); hinting is dropped (woff2 for screens).

| File (`latin/`) | TTF before | woff2 after | Δ | SHA-256 |
|---|---|---|---|---|
| `BarlowCondensed-Bold.latin.woff2` | 104 316 B | 16 180 B | −84.5% | feb1526ffecbd7618b5a64866071322f5dc07bbd60e132139f8c1f168a36edb4 |
| `IBMPlexMono-Regular.latin.woff2` | 133 796 B | 10 612 B | −92.1% | 6a01e07d650cd15e4286585b3ffb4f278c8eb6a7da8d24cfe220db85c83e5016 |
| `IBMPlexMono-Medium.latin.woff2` | 134 956 B | 10 608 B | −92.1% | f916b1d8fdd480a65a33062abcd1d8fff5daf7d07ae413ab4647eec986b16c2d |
| `IBMPlexMono-Bold.latin.woff2` | 136 008 B | 10 628 B | −92.2% | c4823cb3090ed72b3bb4b68b48524b7b97ae049eb2b3895a0bc9825645bf1519 |

| `IBMPlexSans-wght400-700.latin.woff2` | 66 976 B (pack woff2) | 30 528 B | −54.4% | 4675accfe6c34b09cfe0b5e942c96ede1dc6c6edb275d1fdbfe4b64f3947be69 |

The Plex Sans row was subset from the pack woff2 (not a TTF) with the same command, `UNI` and tool versions; the variable
`wght 400–700` axis is kept (267 glyphs, no Cyrillic, `→` U+2192 and `é` present). Barlow + Mono: 509 076 B → 48 028 B; with Plex Sans, all five
loaded faces: 576 052 B → 78 556 B. Target ≤ 60 KB per face (asserted in `fonts.test.ts`). Glyphs outside the subset (`✓ ✕ ♫ ⌄` UI marks) already fall back to the system font.
