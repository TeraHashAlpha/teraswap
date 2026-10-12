# Self-hosted fonts (next/font/local)

Loaded by `src/app/layout.tsx`. Replaces `next/font/google` so builds never fetch from Google.
Both families: SIL Open Font License 1.1 (`OFL.txt` alongside each family).

| File | Source | Version | SHA-256 |
|---|---|---|---|
| `inter/InterVariable-latin.woff2` | https://github.com/rsms/inter/releases/download/v4.1/Inter-4.1.zip (`web/InterVariable.woff2`, subset — see below) | v4.1 | c06b669f205db2eee59d2db259cfee44930a2f19a1808611e12ce164cab5a952 |
| `jetbrains-mono/JetBrainsMono-Regular.woff2` | https://github.com/JetBrains/JetBrainsMono/releases/download/v2.304/JetBrainsMono-2.304.zip (`fonts/webfonts/`) | v2.304 | a9cb1cd82332b23a47e3a1239d25d13c86d16c4220695e34b243effa999f45f2 |
| `jetbrains-mono/JetBrainsMono-Medium.woff2` | same | v2.304 | 086c48dfbea9ddaff1320f7e09399b8e2924e88ce67453721255db3bdbb5a353 |
| `jetbrains-mono/JetBrainsMono-SemiBold.woff2` | same | v2.304 | 918edad542a1da608fd2ba8daebaff9ac802309103fe760eed465b8b4e47faf1 |

## Inter subsetting

`InterVariable-latin.woff2` is the upstream variable font (wght + opsz axes kept) subset with
fonttools 4.66.1 `pyftsubset --layout-features='*' --flavor=woff2` to the latin unicode-range
Google Fonts uses. The unsubset upstream file is 352,240 B (sha256 693b77d4f32ee9b8bfc995589b5fad5e99adf2832738661f5402f9978429a8e3).

```
U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,
U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD
```

JetBrains Mono v2.304 ships its variable font as TTF only, so the three static woff2 weights in use
(400/500/600) are used instead.

## Why src/fonts and not public/fonts

`next/font/local` bundles files imported from the source tree into `/_next/static/media/<hash>.woff2`.
Keeping them in `public/` would only ship unused duplicate copies.
