# UI v2 fonts (next/font/local)

Loaded by `src/ui/v2/font-loader.ts`. Source: Round 2 pack `assets/fonts/` (copied byte-for-byte; the pack has no
top-level `fonts/`). Both families: SIL Open Font License 1.1 — licence text alongside (`OFL-*.txt`, ADR-012 OK:
permissive, no copyleft dependency). Inter is not duplicated here: v2 reuses the #565 self-hosted Inter (`src/fonts/inter`).
Files are TTF as shipped in the pack (not subset / re-encoded); woff2 + latin subset is a later size optimisation.

| File | Licence file | SHA-256 |
|---|---|---|
| `BarlowCondensed-Bold.ttf` | `OFL-barlowcondensed.txt` | 53550669f93c07de6221e051905462f862066459eb50148268b5628104a58a30 |
| `IBMPlexMono-Regular.ttf` | `OFL-ibmplexmono.txt` | ab08018ccd276b79fb2c636bb95b9c543598f9d50505fe92506fcb4dae7810cd |
| `IBMPlexMono-Medium.ttf` | `OFL-ibmplexmono.txt` | 8ae925744d53758b67a77ea35c2fc46d7b688c7d8c04da3b579902bed0ca0e17 |
| `IBMPlexMono-Bold.ttf` | `OFL-ibmplexmono.txt` | dbd2a2fb024579438d6400a84e57579bfd2dbe67c306c8fd9fde92a61e4f2eea |

Caveat (`--font-hand`, pack §4) is not loaded: the hand underline is an inline SVG and no commit here needs the typeface.
