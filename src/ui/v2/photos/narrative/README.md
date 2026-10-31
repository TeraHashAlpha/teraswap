# Baked `bg-*` photos

Pre-graded derivatives (grayscale · contrast · brightness · cream duotone · 65 % BG shade) of credited Pexels photos.
Used by the landing's scroll narrative and stills, and (round 7, owner addition) by the app shell's per-tab photo.

| File set | Source |
|---|---|
| `bg-highway`, `bg-footbridge`, `bg-tunnel`, `bg-archlight`, `bg-underpass` | round 6 pack, byte for byte |
| `bg-archnight`, `bg-overpass` | round 7 pack `landing/img`, byte for byte |
| `bg-zakim-1920` / `-1080` | round 7 pack `bg-zakim` zip (`landing/img`, script `src/prep7_zakim.py`), byte for byte — replaced the earlier self-baked copy (B3 C3) |

`bg-zakim-*` (B3 C3): the pack's own files (47 819 / 59 334 B at 1920, 51 831 / 61 190 B at 1080: grayscale, contrast 1.15, brightness 0.62, focus y 0.35, colorized BG / #6E6A5E / #EADFB6, BG veil α165, AVIF q55 / WebP q78). The earlier copy was baked locally from a tone curve because the pack had not shipped these files yet.
