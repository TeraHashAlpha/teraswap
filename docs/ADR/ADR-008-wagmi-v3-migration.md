# ADR-008: Wagmi v2 → v3 Migration

**Status:** Proposed  
**Date:** 2026-05-28  
**Author:** TeraHash (Architect)

## Context

TeraSwap currently uses wagmi 2.19.5, viem 2.47.4, @rainbow-me/rainbowkit 2.1.0, and @tanstack/react-query 5.50.1. The FULL-AUDIT recommended upgrading wagmi to v3 as part of the post-audit sprint sequence (Sprint 34).

Wagmi v3 was released with a philosophy of minimal breaking changes and opt-in deprecations. The v2→v3 migration guide is significantly smaller than the v1→v2 migration.

## Wagmi v3 Breaking Changes (Analysis)

### Actual breaks (require code changes):

1. **Connector peer dependencies now optional** — wallet SDKs (`@metamask/connect-evm`, `@coinbase/wallet-sdk`, `@walletconnect/ethereum-provider`) must be installed explicitly. Currently bundled inside wagmi v2.

2. **MetaMask connector migrated** — from `@metamask/sdk` to `@metamask/connect-evm` (new package).

### Deprecations (old API still works, new API recommended):

3. **Hook renames (non-breaking, deprecated):**
   - `useAccount` → `useConnection` (22 files affected)
   - `useAccountEffect` → `useConnectionEffect` (0 files — not used)
   - `useSwitchAccount` → `useSwitchConnection` (0 files — not used)

4. **Mutate function renames (non-breaking, deprecated):**
   - Custom names (`writeContract`, `sendTransaction`, `connect`, etc.) → generic `mutate`/`mutateAsync`
   - Affects: useWriteContract (4 files), useSendTransaction (2 files), useSignTypedData (6 files)

5. **Removed accessor properties (need update):**
   - `useConnect().connectors` → `useConnectors()` (0 files — not used directly)
   - `useSwitchChain().chains` → `useChains()` (1 file — SwapButton)

6. **TypeScript minimum** — bumped to 5.9.3 (we're on 5.5 per stack declaration, needs bump)

### Not affected:
- `useBalance`, `useReadContract`, `useReadContracts`, `useBlockNumber`, `useChainId`, `useDisconnect`, `useEnsName`, `useEnsAvatar`, `useEstimateFeesPerGas`, `useWaitForTransactionReceipt` — no API changes.
- Transport APIs (`http`, `fallback`) — unchanged.
- `getDefaultConfig` from RainbowKit — unchanged API.

## RainbowKit Compatibility — BLOCKER

**RainbowKit v2.2.11 (latest stable) does NOT support wagmi v3.** The migration guide only covers up to wagmi v2. There is an open GitHub discussion (#2575) about wagmi v3 support but no release yet.

Since TeraSwap uses RainbowKit's `getDefaultConfig()` for all connector setup, upgrading wagmi without RainbowKit support would break wallet connection entirely.

## Impact Assessment

| Area | Files | Effort | Risk |
|------|-------|--------|------|
| Connector peer deps | package.json | Low | Low (npm install) |
| TypeScript upgrade | tsconfig.json | Low | Low |
| `useAccount` → `useConnection` | 22 files | Medium | Low (find-replace, deprecated not removed) |
| Mutate fn renames | 12 files | Medium | Low (deprecated not removed) |
| `useSwitchChain().chains` | 1 file | Low | Low |
| RainbowKit compatibility | providers.tsx, wagmiConfig.ts | **BLOCKED** | **High** |
| Test updates | ~20 test files | Medium | Low |

**Total surface:** 30 source files use wagmi hooks, 15 distinct hook types.

## Decision

**DEFER full migration until RainbowKit releases wagmi v3 support.**

### Rationale:
1. Wagmi v3 changes are mostly deprecations — v2 API still works on v3, but RainbowKit v2 won't work with wagmi v3 peer dependency.
2. Forcing wagmi v3 without RainbowKit support breaks wallet connectivity — unacceptable.
3. The deprecations give us time — `useAccount` etc. still work, just emit console deprecation warnings.
4. Risk of forcing compatibility: RainbowKit's `getDefaultConfig` may internally use APIs that changed in wagmi v3.

### Sprint 34 scope (reduced):
Instead of full migration, Sprint 34 will:
1. **TypeScript upgrade** — bump to 5.9.3+ to be ready.
2. **Install future peer deps early** — add `@walletconnect/ethereum-provider`, `@coinbase/wallet-sdk`, `@metamask/connect-evm` as explicit dependencies now (they'll become required in v3). No functional change, just prepping the dependency tree.
3. **Fix the one hard break proactively** — replace `useSwitchChain().chains` with separate `useChains()` call in SwapButton (works in both v2 and v3).
4. **Add monitoring** — track RainbowKit releases for wagmi v3 support.

### When to complete migration:
- RainbowKit releases wagmi v3 compatible version → Sprint 34B (full migration).
- Expected timeline: weeks to months based on discussion #2575 activity.

## Alternatives Considered

1. **Drop RainbowKit, use wagmi connectors directly** — Too much work, RainbowKit gives us polished wallet UI for free. Not justified by the small wagmi v3 improvements.
2. **Pin wagmi v2 indefinitely** — Acceptable short-term but v2 will stop getting security patches eventually.
3. **Fork RainbowKit for v3 compat** — Maintenance burden not justified.

## Update 2026-06-11 (Architect) — reconfirmed BLOCKED + prep recommendation REVERSED

- **Still blocked:** RainbowKit has NO production release supporting wagmi v3 (discussion #2575 still
  open). Decision to DEFER stands. Forcing v3 would break wallet connectivity via RainbowKit's
  `getDefaultConfig`.
- **⚠ Sprint-34 prep item #2 ("install future peer deps early") is SUPERSEDED — do NOT do it.** Doing
  exactly this is what commit P184 did, which caused: (a) **4 duplicate `@walletconnect/core` versions**
  → mobile/desktop sessions never settled (fixed 9K, single-core overrides), and (b) a **parallel
  `@coinbase/wallet-sdk` stack** (removed 9L). Pre-installing wallet peer deps under wagmi v2 pulls
  parallel/duplicate stacks. **Never pre-install v3 peer deps while on v2.** See INC (9K/9L) +
  INC-2026-06-09-001 (the broader "loose transitive range" lesson).
- **Safe prep that remains valid:** the proactive `useSwitchChain().chains → useChains()` fix in
  SwapButton (works in both v2 and v3). TypeScript is already on 5.9.3 (prep item #1 done).
- **Trigger to revisit:** a RainbowKit release that officially supports wagmi v3 → then scope the full
  migration as its own gated sprint (touches the fragile wallet layer → full test + real-device WC +
  Auditor; must reconcile with 9K single-core overrides, 9Z RainbowKit pin, the qr@0.5.5 pin, the
  explicit wallet list, COOP, and WalletSessionGuard).

## References

- [Wagmi v2→v3 Migration Guide](https://wagmi.sh/react/guides/migrate-from-v2-to-v3)
- [RainbowKit Migration Guide](https://rainbowkit.com/docs/migration-guide) (v2 only as of 2026-05-28)
- [RainbowKit wagmi v3 Discussion #2575](https://github.com/rainbow-me/rainbowkit/discussions/2575)
