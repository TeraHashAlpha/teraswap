# LIGHT AUDIT — E-3 portfolio Base activation (fix/e3-portfolio-base, PR #166)

**Scope:** commits `56594a9` (chain-aware portfolio routes), `b061695` (useTokenBalances widening),
`3d07294` (usePortfolio active-chain rewiring), `3fc4abf` (FEEDBACK) vs `origin/main`.
**Mandate (per E-3 spec):** LIGHT Auditor — chain-aware data correctness + mainnet byte-identical.
**Method:** 2 adversarial machine auditors (67 verified tool calls; every claim code-traced; tests
re-executed independently: 54/54 across the 4 touched test files). Machine-side record — owner
countersign before prod promote.

## Verdict: APPROVED — 0C / 0H

| Auditor | Verdict | C | H | M | L |
|---|---|---|---|---|---|
| Chain-aware data correctness | APPROVED | 0 | 0 | 1 (ops note) | 1 |
| Mainnet byte-identical | APPROVED-WITH-NOTES | 0 | 0 | 3 (all verified mainnet-identity-preserving) | 2 |

## Verified properties

**Chain-aware correctness**
- chainId validation fail-closed on BOTH routes: malformed (`'8453abc'`, floats, negatives) and
  unmapped chains → 400 **before any upstream call**.
- Token metadata curation is chain-scoped: Base addresses resolve against `getChainTokenList(8453)`
  only — no path labels a Base address with mainnet metadata (9P lesson; test-pinned).
- DefiLlama slug via registry (`'ethereum'`/`'base'`) matches the `coins.llama.fi` namespace format
  used by `fetchDefiLlamaPrices`.
- Chain switch: `prevChainRef` effect clears the previous chain's tokens synchronously; discovery,
  prices, and the fallback all key on the same `useActiveChainId()` — no render frame can mix chain-A
  tokens with chain-B prices.
- Fallback positional mapping (`erc20Results[i] ↔ erc20Tokens[i]`) derives from one immutable
  per-chain array with every read pinned to `chainId: activeChainId` — no cross-chain desync.
- Base native ETH: present in the Base catalog and resolved by both paths (Alchemy prepend +
  fallback walk) — Base ETH balance can never be silently hidden.

**Mainnet byte-identical**
- Routes with chainId absent → identical Alchemy URL, identical curation map identity
  (`DEFAULT_TOKENS`), identical `'ethereum'` slug, identical response shapes/headers.
- usePortfolio mainnet: the only request-level delta is the explicit `chainId=1` param, which the
  routes treat identically to absent (both branches read).
- The fallback replacement (internal hook → standalone) preserves mainnet walk order, positional
  mapping, and gating; TokenSelector destructure is syntax-only.
- All 20 pre-existing usePortfolio tests pass unchanged; 54/54 across the touched files.

## Notes (no action required for approval)

1. **Intentional behavior delta (documented, judged an improvement):** old internal guard
   (`chain?.id === 1`) hid the portfolio entirely when the wallet sat on an unsupported chain; the
   standalone hook's `isChainActive(activeChainId)` (with `useActiveChainId` falling back to mainnet)
   now shows the mainnet portfolio as the fallback view in that state. Strictly more information,
   chain-correctly labeled.
2. **Ops note (M):** `ALCHEMY_API_KEY` is one key for both endpoints. A network-restricted key
   degrades that chain's discovery to 503 → the chain-aware multicall fallback covers it (same
   degradation path as before). Deployment checklist: confirm the key is app-scoped (eth-mainnet +
   base-mainnet).
3. `MAX_DISCOVERY_FAILURES` (=2) verified present; non-503 failures fall back after 2 consecutive
   misses, exactly as before.

## Owner steps before/after merge
- Countersign this record (LIGHT scope satisfied machine-side; 0C/0H).
- Post-merge live check: Base-funded wallet → Portfolio shows Base balances + USD; mainnet ⇄ Base
  switch shows no cross-chain mixing.
