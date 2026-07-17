# CHORE-CATALOG-REUSD-COLLISION — add Re Protocol reUSD as a second, disambiguated mainnet catalog entry

> **Source:** owner report 2026-07-17 — a user expected "reUSD" and found only Resupply's. Investigation
> (Architect, two independent web sources + the catalog trust guard) confirmed a **ticker collision**: TWO
> different mainnet tokens use the symbol `reUSD`: (a) **Resupply USD** `0x57aB1E0003F623289CD798B1824Be09a793e4Bec`
> — already in the catalog, VERIFIED CORRECT (Etherscan + CoinGecko `resupply-usd`; trust guard on-chain symbol
> matches) — and (b) **Re Protocol reUSD** (re.xyz; CoinGecko `re-protocol-reusd`), expected
> `0x5086bf358635B81D8C47C66d1C8b9E567Db70c72`, NOT in the catalog. Owner decision: **ADD (b) as a separate
> entry; NEVER replace (a)** — a swap would have mislabelled one project's token as the other (classic
> aggregator-frontend attack vector; the "wrong address, fix it fast" framing is exactly that pattern).
> Catalog/display only, additive, guards tightened-scoped → **no Auditor gate; Auditor note in the PR body.**
> Per [[feedback_address_hygiene]]: **no hand-typed hex — the address flows programmatically from a
> verification script's output.** SSH-signed; branch `chore/catalog-reusd-collision` off `origin/main`,
> dedicated worktree; 3 droppable commits. **Exit = push + CI green + compare link; the owner opens the PR.**

## Requirements (per-commit)

### 1. On-chain verification (the method is the deliverable)
Reuse/extend the existing address-verification script pattern (cf. `scripts/verify-arbitrum-addresses.mjs`):
resolve Re Protocol reUSD on **mainnet** — expected `0x5086bf358635B81D8C47C66d1C8b9E567Db70c72` (Etherscan +
CoinGecko `re-protocol-reusd`). From **two independent mainnet RPCs** (assert `chainId == 0x1` on both):
`eth_getCode` non-empty; `symbol()` / `name()` / `decimals()` read on-chain (expect symbol `reUSD`, a name
identifying Re Protocol — Etherscan shows "Re Protocol Deposit Token" — and decimals **as read, don't assume
18**). The script emits the exact address string; the catalog source copies it programmatically.

### 2. Catalog addition via the curated pipeline
NOT a hand-edit of generated JSON: add the entry to the **curated source**, then regenerate
`src/config/generated/token-catalog.1.json` and `src/lib/chains/catalog-guard.trust.json` via their scripts.
Display name = the on-chain name (disambiguating, "Re Protocol …"); decimals from the on-chain read; logo via
the existing token-logo pipeline (fallback pattern OK). The Resupply reUSD entry stays **byte-identical**.

### 3. Collision handling + tests
- The symbol-collision / verified-badge guard gains a **scoped exempt entry for this known duplicate-symbol
  pair only** (comment citing this spec; pattern: the USDT0 `symbolMismatchExempt` on 42161). No general
  weakening.
- Tests: both `reUSD` entries resolve on chainId 1 with distinct addresses AND distinct display names;
  searching "reUSD" surfaces BOTH with distinguishable labels in the selector data (name visible, not
  symbol-only); collision guard green; no other duplicate-symbol regressions introduced.

## Do NOT
Modify/remove the Resupply entry or ANY other token; touch swap/gate/adapter/router logic; hand-type hex
anywhere; weaken guards beyond the one scoped exempt; touch Base/Arbitrum catalogs or v3 files; open a PR.

## Files affected (read ONLY these + new)
Curated catalog source; regenerated `src/config/generated/token-catalog.1.json` +
`src/lib/chains/catalog-guard.trust.json` (via scripts); collision/verified-badge guard config + tests; the
verification script; token-selector search test (extend); `docs/Prompts/CHORE-CATALOG-REUSD-COLLISION.md`
(commit this spec). Read-only: `docs/DEPLOYMENTS.md`.

## Expected output
Branch `chore/catalog-reusd-collision` pushed, CI green (push + report, don't poll), **compare link reported —
do NOT open a PR.** FEEDBACK ≤1 screen: the two-RPC on-chain reads (code/symbol/name/decimals), the new entry
as landed, the exempt entry, tests list. Auditor note for the PR body: catalog-only addition, scoped exempt,
no fund-flow surface touched.

## Quality criteria
Resupply entry untouched; new entry's address provably sourced from the verification output (zero hand-typed
hex); both entries distinguishable in search/selector data; guards green with a scoped exempt only.
