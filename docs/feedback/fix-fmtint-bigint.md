# fix/fmtint-bigint — FEEDBACK

Symptom: Footer "Base · Block #0" — `useBlockNumber` → bigint → `fmtInt` scaled it as an 18-dp token amount.

- [x] C1 root cause + `FmtInput` rule + tests (25ed2bb)  - [x] C2 call-site audit  - [x] verify, push, compare link

## 1. Root cause (pre-fix lines) + fix
`format.ts:74` `toFiniteNumber(value, decimals = 18)` → `:77` bigint → `bigintToDecimalString(value, 18)`; `:192-193` `fmtInt` → `toFiniteNumber(value)` ⇒ 52656825n → 5.27e-11 → `Math.round` → `"0"`. Same for `fmtFixed` (:201), `fmtUsd`/`fmtPct`/`fmtGas`.
Fix: `decimals = 0` default (+ JSDoc rule on `FmtInput`); `fmtToken` already passes `decimals` explicitly, so it is unchanged.

## 2. Tests (red on old code: 9 fail; green now)
| Test | Result |
|---|---|
| `fmtInt(52656825n)` / `fmtInt(-5n)` / `fmtInt(0n)` / `fmtInt(10n**18n)` | `52 656 825` / `−5` / `0` / `1 000 000 000 000 000 000` (thin spaces) |
| `fmtFixed(1234n,2)` / `fmtFixed(-2n,1)` | `1 234.00` / `−2.0` |
| `fmtUsd(1234n)` / `fmtPct(5n,1)` / `fmtGas(2n)` | `$1 234.00` / `5%` / `2` |
| `fmtToken(10n**18n,18)` / `fmtToken(1_500_000n,6)` | `1.0000` / `1.5000` (still scaled) |
| Footer, mocked `useBlockNumber`→`52656825n`, Base | text `Base · Block #52 656 825`, href `…/block/52656825` |

## 3. Call-site audit (`fmtInt(`/`fmtFixed(`, non-test)
Method: temporarily narrowed both signatures and ran `tsc` — excluding `bigint` flags only `Footer.tsx:68,71`; excluding `string` and `null|undefined` flags none. (Sites typed `any` would pass silently; none carry a bigint — JSON has none.)
| Site | Input | Output changes? |
|---|---|---|
| Footer.tsx:68,71 | **bigint** | **yes: `#0` → `#52 656 825`** (only silent-0 site; regression test = Footer test above) |
| AdminMonitor 308-329,670-673,804; PersonalDashboard:200; AnalyticsDashboard:283; PublicProtocolStats:81,117; SwapBox:990,1001; defillama.ts:286,304 | number | no |
| fmtFixed: status/page:82; DCAPanel:701,778-781; AdminMonitor:605; OrderDashboard:247; dca-custom:144 | number | no |

## 4. Verify
Suite: 4880/4880 (312 files) vs origin/main 65b66ee 4867/4868 — +12 = my tests; main's 1 failure is `usePortfolio.test.ts` (Base Alchemy-503), flaky under parallel load, passes 22/22 alone. Lint 93 warn = main 93 (Δ0). tsc clean.
`git diff --stat origin/main`: format.ts, format.test.ts, Footer.test.tsx, this file.

## Deviations
- Out-of-list read: grep-only of `fmtUsd|fmtPct|fmtGas(Cost)` callers (none passes a bigint; all `fmtGas` callers pass numbers) — needed to apply the rule safely to them.
- Fix is the `= 18` default at :74, not explicit `0` args at :193/:201 (same effect for those two; also covers fmtUsd/fmtPct/fmtGas).
- Goal premise `fmtToken(10n**18n,18)` → "1" is wrong: §3 keeps 4 dp ≥ 1, real output `1.0000` (existing row `1 713.1810` agrees). Asserted real output; scaling intent preserved.
- Goal's "52 656 825" uses plain spaces; §3 separator is U+2009, tests assert that.
