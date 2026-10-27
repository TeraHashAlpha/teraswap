# Baked `bg-*` photos

Pre-graded derivatives (grayscale · contrast · brightness · cream duotone · 65 % BG shade) of credited Pexels photos.
Used by the landing's scroll narrative and stills, and (round 7, owner addition) by the app shell's per-tab photo.

| File set | Source |
|---|---|
| `bg-highway`, `bg-footbridge`, `bg-tunnel`, `bg-archlight`, `bg-underpass` | round 6 pack, byte for byte |
| `bg-archnight`, `bg-overpass` | round 7 pack `landing/img`, byte for byte |
| `bg-zakim-1920` / `-1080` | **baked here** — the round 7 pack lists `bg-zakim-1920` but does not ship the file, and its grading script (`round6b/src/prep_6b.py`) is not in the pack |

`bg-zakim-*`: the source photo (round 4 `pexels-17102595-…-night.jpg`) is cover-cropped (1920×1080 at focus 0.5/0.35, the
`prep7.py` focus; 1080×1920 centred), reduced to grayscale, and mapped to `#0B0D0F → #31322E` (the pack's black / white
point) through a 16-knot tone curve measured on the pack's own `bg-highway-1920.webp` (grade brightness 0.60), scaled by
0.62 / 0.60 for Zakim's brightness (`prep7.py`). AVIF q55, WebP q78 (`prep7.py`). Check against the pack's files: mean luma
27.4 / max 52 for Zakim against 26.4 / 56 (overpass) and 25.0 / 52 (highway); 41 / 51 KB against the changelog's 46 / 57 KB.
**If the pack's own `bg-zakim-*` arrives, replace these four files; nothing else changes.**
