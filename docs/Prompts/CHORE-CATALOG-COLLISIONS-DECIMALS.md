# CHORE-CATALOG-COLLISIONS-DECIMALS

Branch: `chore/catalog-collisions-decimals` (stacked on #210; rebase onto main once #210 merges). Serial with the
gold-RWA work. No Auditor. Architect/owner review before merge.

## Context

#210's FEEDBACK surfaced, for owner sign-off: a **fund-affecting FLUX decimals bug** (catalog 18 vs on-chain 8)
and the **AVT/LIT** ticker-collision dispositions. Apply them (verified) and add a guard so the decimals class
can't regress.

## Objective

1. **FLUX decimals** — verify on-chain `decimals()` + correct it (keep the FLUX address). Flag whether the wrong
   value affected any live swap path beyond display.
2. **AVT** — replace with the verified canonical (Aventus), owner-signed.
3. **LIT** — remove the deprecated Litentry entry (confirm on-chain), keep Lighter.
4. **Guard** — extend `catalog-guard.ts` + the verdict cache with an on-chain `decimals()` cross-check
   (mismatch = FATAL); refresh + a wrong-decimals regression test (→ RED).

## Do NOT

- Silently swap an address; fabricate addresses/decimals; trust un-verified values.
- Hand-edit `token-catalog.generated.ts` (curate in the generator); edit `tokens.ts` (serialized with gold-RWA).
- Let the decimals gate depend on live network (cache-backed, like the rest of the guard).

## Disposition (as implemented)

- **FLUX** `0x720CD16…` decimals **18 → 8** (on-chain verified). **Live-swap impact: YES** — `useSwap.ts:314/695`
  use `token.decimals` in `parseUnits`/`formatUnits`, so the raw sell amount + balance math were 10^10 off
  (mitigated in practice by the balance check failing closed; not display-only). 
- **WMTX** (Base) decimals **18 → 6** — a SECOND mismatch found by auditing on-chain `decimals()` catalog-wide.
- **AVT** ArtVerse (dead) → **Aventus** `0x0d88ed6e…` (REMAP). **LIT** → removed deprecated **Litentry**
  `0xb59490…`, kept **Lighter** `0x232CE3…`. Allowlist trimmed accordingly.
- **Guard**: `decimals` added to the verdict + a FATAL catalog-vs-on-chain `decimals()` check; refresh records it;
  2 regression tests + live prove-it (FLUX 18 → RED). Guard 16/16, 0 mismatches across 501 tokens.

## Expected output

FLUX/WMTX decimals correct; AVT→Aventus; Litentry removed; guard extended + green; FEEDBACK with the live-swap
impact + per-token disposition. tsc / lint / tests / build / test-contracts green.

## Quality criteria

Every applied change on-chain + official-source verified; the decimals gate is cache-backed (deterministic) and
fatal-on-mismatch; the guard now reflects the corrected catalog and would catch a future decimals regression.
