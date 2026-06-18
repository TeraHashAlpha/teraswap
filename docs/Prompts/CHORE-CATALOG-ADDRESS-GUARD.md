# CHORE-CATALOG-ADDRESS-GUARD

Branch: `chore/catalog-address-guard` (off `origin/main`). No Auditor. Architect review before merge.

## Context

This sprint shipped four token-catalog data bugs that a swap user could have hit: three **dead/undeployed
addresses** (W, USDe, weETH — no on-chain bytecode) and one **legacy non-transferable duplicate** (legacy MORPHO
alongside the current one). All were caught by hand. We want a standing, automated guard so the class cannot
regress.

## Objective

A deterministic vitest gate (+ CI job) that validates EVERY token in the curated catalog
(`src/lib/tokens.ts` + `src/lib/chains/tokens.ts`, chains 1 + 8453) against those four failure classes — without
a flaky network dependency.

## Requirements

1. **Trusted-list match** — token address present in a reputable, BUNDLED token list (CoinGecko per-chain), or
   explicitly allowlisted. Bundled/cached so the check is deterministic.
2. **On-chain bytecode + transferability** — deployed bytecode AND `transfer(0x…dead,0)` (read-only `eth_call`)
   does not revert. RPC failures NON-fatal (warn, never red on infra).
3. **No duplicate symbol per chain** — fail if a symbol appears at >1 address on a chain.
4. Allowlist legit edge cases (native-ETH sentinel `0xEeee…`, rebrands, ticker collisions, CG-absent reals).
5. Prove it: reintroduce a known-bad address → guard RED → revert (capture in FEEDBACK).

## Do NOT

- Edit `tokens.ts` (read-only — avoids conflict with the parallel gold-RWA work).
- Make the CI gate depend on live network (no flaky gate).
- Introduce a dependency/lockfile change.

## Files affected

- `scripts/refresh-catalog-guard.ts` — network refresh (CoinGecko + RPC) → writes the verdict cache.
- `src/lib/chains/catalog-guard.trust.json` — committed, deterministic verdict cache (per token: inTrustedList /
  hasBytecode / transferable).
- `src/lib/chains/catalog-guard.allowlist.json` — allowlist (trustedListExempt / knownDeprecated / duplicateSymbolExempt / nativeEth).
- `src/lib/chains/catalog-guard.ts` — pure audit logic.
- `src/lib/chains/catalog-address-guard.test.ts` — the gate + synthetic regression proofs.
- `.github/workflows/ci.yml` — `catalog-address-guard` job. `package.json` — `guard:check` / `guard:refresh` scripts.

## Design (as implemented)

The transferability probe REVERTS for legit tokens (USDT, …), so it is **advisory**, not fatal. The trusted-list
check is **address-present-in-CoinGecko OR allowlisted** (a strict symbol match false-positives on every rebrand:
FXS→FRAX, RNDR→RENDER, SOL→WSOL, …). On-chain signals are read from a **committed verdict cache** refreshed
out-of-band by `scripts/refresh-catalog-guard.ts`; the gate does ZERO network → deterministic, never flaky. A
catalog token with no cached verdict fails CLOSED (forces `npm run guard:refresh`). FATAL = missing-verdict,
hasBytecode===false, non-allowlisted trusted-list miss, non-allowlisted duplicate symbol. WARN (advisory) =
transferable===false, inTrustedList/hasBytecode===null (RPC/CG unreachable at refresh), and `knownDeprecated`.

## Expected output

`npm run guard:check` (and the CI job) passes on clean `main`; reintroducing any of W/USDe/weETH/legacy-MORPHO
turns it RED. tsc / lint / tests / build green.

## Quality criteria

- Deterministic, network-free gate; RPC/CG failures never red it.
- Allowlist holds only conscious, justified exceptions; never hides a NEW dead/duplicate token.
- A triage workflow verified the migration-risk allowlist entries; an adversarial-review workflow attacked the
  guard for enumeration gaps / bypasses / non-determinism / false-negatives.
