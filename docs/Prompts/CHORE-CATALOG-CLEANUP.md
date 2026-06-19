# CHORE-CATALOG-CLEANUP

Branch: `chore/catalog-cleanup` (stacked on #209's guard; rebase onto main once #209 merges). Serial with the
gold-RWA work (both touch the token catalog). No Auditor. Architect/owner review before merge.

## Context

The catalog-address-guard (#209) flagged, in `main`'s catalog: **5 deprecated/migrated tokens** (LCX, LOOM, OMNI,
RBC, REP — the legacy-MORPHO class) and **3 ticker collisions** (AVT, FLUX, LIT). Clean them up.

## Objective

Replace each deprecated token with its verified canonical address, or remove it if dead/non-routable; surface the
3 collisions for owner sign-off (do not silently swap). The #209 guard must stay green.

## Requirements

1. **5 deprecated** — verify EACH on-chain (name/symbol/decimals/transferability, like the MORPHO check) + an
   authoritative source; then REPLACE with the canonical address OR REMOVE if dead/non-routable / already present.
   No fabricated addresses.
2. **3 collisions** — in FEEDBACK, surface what the catalog points to (address + on-chain symbol) vs the project
   users likely expect (CoinGecko-canonical); propose keep/replace/remove per token. Owner signs off.
3. After edits, re-run `npm run guard:refresh` if needed; `catalog-address-guard` must pass.

## Do NOT

- Fabricate addresses; trust an unverified "canonical" (the #209 triage misidentified OMNI's — verify everything).
- Silently swap a collision token.
- Hand-edit `token-catalog.generated.ts` (it is generated — curate in the generator).

## Disposition (as implemented)

Deprecated (APPLIED via generator REMOVALS/REMAPS → regenerate): **LCX → 0x8cd41041** (V2, active); **RBC →
0x3330bfb** (old is non-transferable on-chain); **LOOM / OMNI / REP → REMOVE** (DEX-dead / rebranded-to-NOM /
REPv2-already-present). Cleared all 5 `knownDeprecated` allowlist entries; `guard:refresh` → guard 14/14.
Collisions (PROPOSED, not applied): **AVT → REPLACE** (catalog=dead ArtVerse; expect Aventus); **FLUX → KEEP**
(RunOnFlux) **+ HIGH-severity decimals bug 18→8**; **LIT → REMOVE the Litentry entry**, keep Lighter. See FEEDBACK.

## Expected output

5 deprecated fixed; guard green; FEEDBACK per-token disposition + the 3 collision proposals + the FLUX decimals
flag. tsc / lint / tests / build green.

## Quality criteria

Every applied address change verified on-chain + official source; collisions left to owner sign-off; the guard
(the regression net) stays green and now reflects the cleaned catalog.
