# Feedback — feat/ui-v2-design-review-1 (owner design review, 5 Nov)

Base: origin/main `ff06085` (B10 / PR #660 merged 2026-11-06 12:13Z — gate verified). Scope: `src/ui/v2/**` only.

## Checklist
- [ ] 1 platform green: one token, every vertical accent stroke
- [ ] 2 ⚠ removed from every notice/alert (copy untouched)
- [ ] 3 no dark bands on the landing (photo behind every section; local scrim; AA tests extended)
- [ ] 4 §2 underline on two-line titles (375 + 1440) · hero photo (light-trails out)
- [ ] verify: suite vs main · lint Δ0 · tsc · build · v1 module-identical · rpc-budget · CodeQL 0 new

## 1 · Platform green
`#6B9B94` — the v2 info NOTICE strip's left bar (`Surface accent="teal"` → `border-v2-teal`) and its "NOTICE" label (`text-v2-teal`).
Source: `--teal` in `src/ui/v2/tokens.css` / `V2_COLORS.teal` (Round 2 pack README §4). **There is no v1 source**: the hex appears nowhere outside `src/ui/v2` (v1 has no teal; the pack token is v2-only).
Not `--green:#7FC8A0` (a different, lighter green): the owner's pointer is the NOTICE strip, so the token is `--c-accent-green: var(--teal)`.
