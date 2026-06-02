# Wagmi v3 Migration — Scoping Note (deferred sprint)

**Author:** Code Agent (Claude Code) · **Date:** 2026-06-02 · **Status:** Scoping only — DO NOT implement in SPRINT-9I
**Companion to:** [`docs/ADR/ADR-008-wagmi-v3-migration.md`](../docs/ADR/ADR-008-wagmi-v3-migration.md) (Proposed) · [`Audits/DEPS-TRIAGE-2026-06-02.md`](DEPS-TRIAGE-2026-06-02.md)

This note scopes the wagmi v3 migration for a **dedicated future sprint**. ADR-008 already
records the decision (DEFER), the breaking-change analysis, and the per-area impact table — this
note does not restate them. It adds the three things SPRINT-9I asked for and that ADR-008 does not
yet cover: (1) why **viem #124 must ride with this migration**, (2) the **verified npm-audit
linkage**, and (3) a concrete **test plan**.

---

## Why now (and why deferred)

- **Driver:** root `npm audit` shows **22 moderate** vulnerabilities, **100% transitive** under
  `@wagmi/connectors → @reown/appkit-*` (`appkit-pay`, `appkit-scaffold-ui`, `appkit-ui`,
  `appkit-utils`, `appkit-controllers`) and `@walletconnect/universal-provider`. Verified
  2026-06-02. These do **not** resolve via any individual bump in SPRINT-9I — they close only when
  `@wagmi/connectors` moves to the line shipped with **wagmi v3**.
- **Blocker (from ADR-008, still current):** **RainbowKit does not yet support wagmi v3.** TeraSwap
  builds all connectors via RainbowKit `getDefaultConfig()`; forcing wagmi v3 now breaks wallet
  connectivity. → migration stays **DEFERRED** until RainbowKit ships v3 support (track discussion
  rainbow-me/rainbowkit#2575).

## viem #124 (2.47.4 → 2.51.0) must ride with this migration

- viem 2.51 was **verified green in isolation** in SPRINT-9I — tsc 0 errors, 1399/1399 tests,
  `next build` OK, and **live mainnet + Base quote smokes returned HTTP 200** (see triage). So it is
  not blocked on its own merits.
- **But it should not be merged standalone.** `wagmi@2.19.5` carries a peer range on `viem`, and
  the wagmi v3 upgrade will itself move the supported `viem` line. Bumping viem alone risks a
  wagmi↔viem peer drift that a later wagmi bump would have to re-reconcile. Bundling viem 2.51 (or
  whatever wagmi v3 requires at that time) **into the wagmi v3 PR** keeps the wagmi/viem/RainbowKit
  peer set aligned in a single reviewable change.
- **Action:** carry #124 into this sprint; re-pin viem to the exact version wagmi v3 expects at
  implementation time (may be > 2.51 by then).

## Surface (summary — full detail in ADR-008)

- **Hard breaks:** connector peer deps become explicit (`@walletconnect/ethereum-provider`,
  `@coinbase/wallet-sdk`, `@metamask/connect-evm`); MetaMask connector package change;
  `useSwitchChain().chains` → `useChains()` (1 file, SwapButton); TS min 5.9.3 (already on ~5.9.3).
- **Deprecations (v2 API still works on v3):** `useAccount`→`useConnection` (~22 files), mutate-fn
  renames (~12 files). ~30 source files touch wagmi, 15 hook types.
- **The RainbowKit `getDefaultConfig` path is the integration risk**, not the hook renames.

## Test plan (the new piece for the dedicated sprint)

Gate the migration on **all** of the following staying green, in order:

1. **Static:** `tsc --noEmit` 0 errors · `eslint` 0 errors. (wagmi/viem type changes surface here
   first.)
2. **Unit/integration:** full vitest suite must hold at **≥ 1399 passing** (current green count).
   Pay special attention to wagmi-hook tests, `wagmiConfig`/`providers` tests, and adapter/chain
   tests.
3. **Build:** `next build` ✓ Compiled successfully (+ no new console deprecation spam from wagmi).
4. **Wallet-connect E2E (manual, the real blocker check):** in a preview deploy, connect via
   RainbowKit with MetaMask + WalletConnect + Coinbase Wallet on **mainnet and Base**; switch chain
   via SwapButton (`useChains()` path); disconnect/reconnect.
5. **Quote + swap smoke:** mainnet **and** Base WETH→USDC quote returns 200 with multiple sources
   (reuse the SPRINT-9I smoke); execute one Base swap end-to-end on the preview.
6. **Security:** `npm audit` — confirm the **22 moderate** `@reown/appkit-*` alerts drop to 0 (the
   success criterion for this migration).
7. **Mobile:** `npx cap sync ios` ✓ (the new explicit connector peer deps must resolve in the
   Capacitor bundle too).

## Files likely touched

`package.json` (wagmi, viem, explicit connector peer deps, RainbowKit), `src/**/wagmiConfig*`,
`src/**/providers*`, `SwapButton` (`useChains()`), ~30 hook-using components/hooks, ~20 test files,
`tsconfig.json` (TS floor). No contract/fund-flow changes.

## Recommendation

Open **ADR-008 → Accepted** and schedule a dedicated **wagmi v3 sprint** when RainbowKit v3 support
lands. Carry **viem #124** into that sprint. Until then, the 22 moderate alerts remain accepted risk
(transitive, connector-UI only, no contract/fund-flow exposure) — documented here and in ADR-008.
