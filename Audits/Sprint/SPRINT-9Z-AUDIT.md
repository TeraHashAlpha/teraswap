# Sprint 9Z Audit — Mobile WalletConnect (wallet list + session guard + RainbowKit 2.2.10)

**Date:** 2026-06-08
**Auditor:** Claude Opus 4 (Senior Security Auditor role)
**Branch:** `feat/sprint-9z-mobile-walletconnect` / PR #155
**Commits reviewed:** `cb5a5cf` (A wallet list), `b6c49af` (B WalletSessionGuard), `d93f644` (C RainbowKit 2.2.10), `4b6f3b2` (FEEDBACK)
**Files changed (9Z-only):** 7 (+472/−47 lines)
**New files:** `src/components/WalletSessionGuard.test.tsx` (146 lines)
**Tests:** +146 lines WalletSessionGuard, +53 lines wagmiConfig (wallet list)
**Signatures:** All 4 commits SSH-signed (SSH SIGNATURE header present, author `TeraHash <t.joaocruz@gmail.com>`)

---

## Sprint 9Z Audit Verdict

### Verdict: APPROVED

0C / 0H / 0M / 0L / 3 INFO

---

## ⚠️ Part B touches an AUTH/SECURITY CONTROL — the 1h idle auto-disconnect. This is the primary focus.

---

## Check 1: WalletSessionGuard — 1h idle auto-disconnect preserved ✅

### Root cause and fix

The prod bug: on mobile, tapping a wallet backgrounds the tab during the WalletConnect deep-link handshake. On return, wagmi's `isConnected` flips false→true. The old guard's mount-time check read a STALE `connectedAt` from sessionStorage and disconnected the brand-new connection ("expired while tab was inactive"), counting the handshake time as idle.

**Old code (removed):**
```typescript
const connectedAt = sessionStorage.getItem(STORAGE_KEY)
if (connectedAt) {
  const elapsed = Date.now() - Number(connectedAt)
  if (elapsed >= SESSION_TIMEOUT_MS) {
    disconnect()                    // ← killed the fresh connect
    return
  }
}
resetTimer()
```

**New code:**
```typescript
// On every isConnected false→true, just re-arm from NOW
resetTimer()
```

The stale-baseline expiry branch is entirely removed. The 1h idle `setTimeout` (reset on user interaction) is the sole session control.

### Security intent preserved — test evidence

| Test | What it proves |
|------|---------------|
| "still disconnects after a genuine 1h of inactivity" | `vi.advanceTimersByTime(ONE_HOUR + 1_000)` → `disconnect` called ✅ |
| "holds the idle boundary: connected at 59m, disconnects just after 60m" | 59min → no disconnect; 61min → disconnect ✅ |
| "keeps the session alive across the 1h boundary when the user stays active" | Click at 40min → timer resets → 80min total, 40 since activity → no disconnect ✅ |
| "does NOT disconnect a fresh connect even when a stale connectedAt is present" | Stale baseline (2h old) + new connect → no disconnect ✅ |
| "does NOT disconnect on a background/visibility change during the post-connect handshake" | visibilitychange hidden→visible during handshake → no disconnect ✅ |
| "resets connectedAt to now on a new connection (false→true)" | stale→fresh timestamp confirmed ✅ |

The genuine 1h idle disconnect is the core security invariant and it is test-pinned at the exact boundary (59min ok, 61min disconnect). ✅

### Auth tradeoff assessment (Auditor decision)

The baseline resets on every (re)connect, including wagmi's automatic reconnect on page reload. This means the control is "1h since the last connect/interaction," not an absolute session lifetime. A user who reloads every <1h keeps the session alive indefinitely.

**Auditor ruling: ACCEPTABLE.** Reasons:

1. **Reloading the page IS user activity.** A user who actively reloads demonstrates presence — this is not "idle."
2. **No major dApp ships a hard absolute 1h cap.** MetaMask, Uniswap, 1inch — none disconnect on a hard clock. The idle timeout is standard practice.
3. **The old behavior was the bug, not a feature.** Disconnecting a user who just completed a wallet handshake is a security-flavored UX failure, not a security control.
4. **The 1h idle guarantee (no interaction, no reload, just a forgotten tab) is preserved.** This is the scenario the guard exists to protect against, and it works.

If an absolute hard session cap is ever desired (e.g. regulatory), it should be a separate, explicit control decoupled from the connect lifecycle — not a side effect of the mount-time stale check that caused the prod bug.

### sessionStorage fail-soft hardening ✅

`safeSetItem` / `safeRemoveItem` wrap sessionStorage access in try/catch. Safari private mode and disabled-storage scenarios can throw — a throw in the old code would crash the guard and leave the wallet connected with NO idle timeout (a real escalation). The fix ensures the in-memory `setTimeout` is always the source of truth.

**Test-pinned:** "survives sessionStorage throwing (private mode) without crashing or losing the idle timer" — `setItem` throws, guard still disconnects at 1h. ✅

### connectedAt is now write-only ✅

The `STORAGE_KEY` is still written (by `resetTimer`) but nothing reads it. It persists as a diagnostic/last-activity marker and satisfies the spec's "reset connectedAt on every new connection." Since no code path reads it to make a disconnect decision, a stale or corrupt value in sessionStorage can never cause a spurious disconnect. ✅

---

## Check 2: Wallet list (Part A) — additive only, no connector trust change ✅

### Wallets added

```typescript
export const WALLET_GROUPS = [
  { groupName: 'Recommended', wallets: [rabbyWallet, metaMaskWallet, coinbaseWallet, walletConnectWallet] },
  { groupName: 'More',        wallets: [ledgerWallet, injectedWallet] },
]
```

All 6 wallet functions are imported from `@rainbow-me/rainbowkit/wallets` — first-party RainbowKit wallet configs. The generic `walletConnectWallet` is the catch-all for D'CENT and any WC-compatible wallet via QR/deep-link.

### No new connector trust

- All wallets use the same `WALLETCONNECT_METADATA` (projectId + verified domain `www.teraswap.app`) from 9K
- The `config` remains a MODULE SINGLETON — one `getDefaultConfig()` call → one WC Core/provider instance
- Passing an explicit `wallets` list to `getDefaultConfig` does NOT change the trust model — it only controls which wallets appear in the RainbowKit modal (the connector/provider layer is unchanged)

### Test coverage

| Test | What it proves |
|------|---------------|
| "lists exactly the wallets mobile users need to find" | Exact set match: `['coinbase', 'injected', 'ledger', 'metaMask', 'rabby', 'walletConnect']` — catches any unintended extra or missing wallet ✅ |
| "includes the generic walletConnect catch-all" | D'CENT coverage ✅ |
| "exposes the same wallet list under a mobile user-agent" | UA-independent — no more mobile hiding ✅ |
| "builds connectors that preserve every wallet identity (rkDetails.id)" | identities survive the rainbowkit build ✅ |

---

## Check 3: RainbowKit 2.2.10 — AGPL avoidance endorsed ✅

### Version choice

| Version | Status |
|---------|--------|
| 2.2.10 (chosen) | MIT. Includes all mobile fixes: 2.2.7 WC-init/mobile-reject, 2.2.8 MetaMask-SDK mobile path, 2.2.10 mobile connect-flow |
| 2.2.11 (rejected) | Pulls `ua-parser-js@^2.0.9` → `ua-parser-js@2.0.10` which is **AGPL-3.0-or-later**. Copyleft risk for commercial closed-source dApp. |

**Lockfile verified:** `ua-parser-js: ^1.0.37` (MIT range). No AGPL dependency in the tree. ✅

### Licensing rationale recorded

FEEDBACK documents the AGPL analysis in detail: the version comparison, the `ua-parser-js` license change at 2.0.0, the specific 2.2.11 additions (desktop multi-extension crash fix + SSR/Node-25 safety — neither is mobile-critical), and the recommendation to stay on 2.2.10 until upstream provides an MIT path. **Rationale is recorded.** ✅

### Single @walletconnect/core preserved ✅

```
package-lock.json: 1 instance of @walletconnect/core
node_modules/@walletconnect/core: 2.21.1
```

Overrides pin `@walletconnect/core`, `sign-client`, and `universal-provider` at 2.21.1 — matching wagmi 2.19.5's tested WC tree. The direct `@walletconnect/ethereum-provider` dep was removed (transitive via rainbowkit), eliminating the 9K root cause of multiple Cores. ✅

### No wagmi v3, mainnet byte-identical ✅

- wagmi: 2.19.5 (unchanged)
- viem: 2.47.4 (unchanged)
- No contract changes, no oracle changes, no API route changes

### Other dep changes

| Package | From | To | Note |
|---------|------|----|------|
| `@rainbow-me/rainbowkit` | 2.1.0 | 2.2.10 | Mobile WC fixes |
| `@capacitor/browser` | 8.0.2 | 8.0.3 | Minor patch |
| `@upstash/redis` | 1.37.0 | 1.38.0 | Minor |
| `valtio` | — | 1.13.2 | NEW: rainbowkit peer dep |
| `@coinbase/wallet-sdk` | 4.3.7 | (removed) | Transitive via rainbowkit |
| `@walletconnect/ethereum-provider` | 2.23.9 | (removed) | Transitive via rainbowkit (9K dedup fix) |

---

## Check 4: Scope — no existing gate loosening, no contracts ✅

| Scope area | Changed? |
|-----------|----------|
| Any contract / Solidity | **NO** |
| Oracle / pricing / DeFi gates | **NO** |
| API routes | **NO** |
| Swap execution (useSwap, useSplitSwap) | **NO** |
| Token catalog (9Y) | **NO** |
| Depeg breaker (9W) | **NO** |
| CSP / security headers | **NO** |
| wagmi version | **NO** (2.19.5) |
| viem version | **NO** (2.47.4) |

---

## Findings

| ID | Severity | Component | Description |
|---|---|---|---|
| 9Z-I-01 | INFO | `WalletSessionGuard` | Auth control is now "1h since last connect/interaction" (not absolute session cap). Acceptable: reloading is activity, no major dApp has an absolute cap, genuine idle still disconnects. If a hard cap is ever required, implement it as a separate control. |
| 9Z-I-02 | INFO | `wagmiConfig.ts` | RainbowKit #2232 (WC multi-instance "No matching key") is NOT fixed by 2.2.x — root cause is the wagmi WC-connector reconnect path (fix PR #2331 unmerged). Track separately at the wagmi level. |
| 9Z-I-03 | INFO | `package.json` | AGPL avoidance for 2.2.11 is well-documented in FEEDBACK but not in an ADR. Consider a brief ADR or `docs/decisions/` note if the licensing rationale needs to survive beyond FEEDBACK (which is append-only and grows fast). |

---

## Recommendation

**APPROVED for merge — 0C/0H.** The sprint correctly fixes the mobile WalletConnect lifecycle without weakening the security control:

- The 1h idle auto-disconnect is preserved (test-pinned at 59m/61m boundary)
- The stale-baseline bug that killed mobile connections is eliminated
- sessionStorage is now fail-soft (Safari private mode can't crash the guard)
- The wallet list is additive and UA-independent (no trust change)
- RainbowKit 2.2.10 delivers all mobile fixes while avoiding the AGPL-3.0 `ua-parser-js` in 2.2.11
- Single `@walletconnect/core@2.21.1` preserved, no wagmi v3, mainnet byte-identical
- Comprehensive test coverage (146 lines for the guard, 53 lines for the wallet list)
- FEEDBACK thoroughly documents the AGPL analysis, auth tradeoff, and deviations from spec

Real-device verification (iOS Safari + Android Chrome with Rabby/Ledger/D'CENT) remains the DECISIVE owner post-merge step.
