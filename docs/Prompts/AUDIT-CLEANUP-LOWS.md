# AUDIT-CLEANUP-LOWS — batched T-SAF LOW/INFO cleanup (W7-L-01, W9-L-01, W5-I-02, W10-L-01)

> **Source:** T-SAF campaign 2026-07-01 (APPROVED 0C/0H). All items are **LOW/INFO — non-blocking**, batched into
> one safe PR. App/observability/deps only; **no contract change, no deploy**. SSH-signed (noreply committer).
> Separate items = separate commits so any one can be dropped. (W6/W4 have their own prompts; not included here.)

## Items
### W7-L-01 (LOW, revenue observability) — alert on systematic CoW fee-zeroing
When CoW rejects the `partnerFee` schema, `cow.ts` fails soft and rebuilds **without** the 0.1% fee → that order's
fee is zeroed (revenue loss, not user harm; by design). Add a **metric/alert** (reuse the #201 alert path) that
fires when fee-zeroing happens at a systematic rate (e.g. a per-window counter + a threshold), so the owner notices
if CoW schema drift starts silently zeroing revenue. Do NOT change the fail-soft behaviour itself.

### W9-L-01 (LOW, FE hardening) — no plaintext fallback for sensitive metadata
`secure-storage.ts` falls back to **plaintext** when the per-wallet key can't be derived. No keys/seeds are at risk
(only order/trade metadata), but sensitive metadata should not hit plaintext. Fix: when the encryption key is
unavailable, **skip persistence** (or store nothing sensitive) rather than writing plaintext — fail-closed on the
storage path. Keep non-sensitive prefs on plain localStorage as-is.

### W5-I-02 (INFO, dead defensive nit) — remove the FeeCollector fallback
`useSwap.ts:341` has a `?? FEE_COLLECTOR_ADDRESS` fallback that is already unreachable (guarded by the throw at
`:321`). Remove the dead fallback so the code doesn't imply a second, un-taken path. Pure cleanup, no behaviour change.

### W10-L-01 (LOW, bundle bloat — ASSESS then fix) — dedup viem
`viem` resolves to 2 instances in the app bundle: app `2.47.4` + `@walletconnect/utils` transitive `2.23.2` (bundle
bloat, NOT a runtime bug; the executor sub-package's own viem is a separate process and out of scope). **Assess**
whether an `overrides` pin can dedup app-side viem to one version **without breaking WalletConnect** (WC pins are
sensitive — see W9/W10). If safe → add the override + confirm `npm ls viem` = 1 app instance + WC still works (CI
green). If it risks WC → do NOT force it; document the residual in FEEDBACK and leave as accepted bloat.

## Do NOT
- No contract change, no deploy. Don't change the CoW fail-soft logic (only add the alert). Don't force a viem
  override that breaks WC. Don't touch the non-sensitive localStorage prefs. Don't loosen any gate.

## Files affected (verify on main)
- `contracts/order-engine/executor/alert.js` (+ the CoW fee-zero counter) for W7-L-01; the CoW adapter for the hook.
- `src/lib/secure-storage.ts` for W9-L-01. `useSwap.ts:341` for W5-I-02. `package.json` `overrides` for W10-L-01.

## Expected output
- Branch `chore/audit-cleanup-lows` off latest `origin/main`; SSH-signed; CI green. One commit per item. Tests:
  fee-zero alert fires at threshold; secure-storage refuses plaintext for sensitive metadata; (viem) `npm ls viem`
  delta if the override was safe. FEEDBACK notes each item's disposition (fixed / assessed-and-left for W10-L-01).

## Quality criteria
CoW systematic fee-zeroing is observable; secure-storage never writes sensitive metadata in plaintext; the dead
FeeCollector fallback is gone; viem is deduped app-side IF it doesn't break WC (else documented); no gate/contract
change; all four items land as independent, droppable commits.
# AUDIT-CLEANUP-LOWS — W7-L-01 / W9-L-01 / W5-I-02 / W10-L-01

> **Source:** T-SAF campaign 2026-07-01 (API/contracts APPROVED 0C/0H). All items are **LOW / INFO**,
> **non-blocking** — app / observability / dependency only. **No contract change, no deploy.** Commits
> SSH-signed (noreply committer). **One commit per item** so any single one can be dropped.

## Items

### W7-L-01 — alert on systematic CoW partner-fee zeroing (revenue)
When CoW rejects the `partnerFee` appData schema, `cow.ts` **fails soft** and re-quotes WITHOUT the 0.1%
fee so quoting never breaks (by design — **do not change the fail-soft**). If that starts happening at a
**systematic rate**, every CoW fill silently loses the fee (revenue leak). Add a per-window counter +
threshold that raises **one alert** through the existing alert fan-out (the `#201` path's serverless
equivalent) when the rate is systematic. Metric/alert only; the fail-soft behaviour is unchanged.

### W9-L-01 — secure-storage: fail closed instead of writing plaintext
`secure-storage.ts` currently falls back to **plaintext** when the per-wallet AES key can't be derived
(Web Crypto unavailable / not yet initialised). It only ever holds order/trade metadata (never keys or
seeds), but plaintext-at-rest is still readable by any extension / XSS / shared-computer user. Fix: when
no key is available, **SKIP persistence (fail-closed)** rather than write plaintext. The data is
re-derivable (Supabase is the source of truth for orders). Non-sensitive prefs on plain `localStorage`
elsewhere are unchanged; legacy plaintext reads stay backward-compatible.

### W5-I-02 — remove the unreachable `?? FEE_COLLECTOR_ADDRESS` fallback
In `useSwap.ts`, `buildFeeCollectorSwapArgs(routeViaFeeCollector, address, feeCollectorAddress ?? FEE_COLLECTOR_ADDRESS)`
carries a dead fallback: the helper only reads the 3rd arg when `routeViaFeeCollector` is true, and the
guard above (`if (routeViaFeeCollector && !feeCollectorAddress) throw`) guarantees it's non-null there.
Remove the `?? FEE_COLLECTOR_ADDRESS`. No behaviour change.

### W10-L-01 — assess viem dedup (bundle bloat)
The app resolves **two** viem copies: the app + everything else on `2.47.4`, and `@walletconnect/utils`
on a transitive `2.23.2`. (The executor sub-package's viem is separate and out of scope.) **Assess**
whether an `overrides` pin can dedup app-side viem to one version **without breaking WalletConnect**. If
safe → add the override and confirm `npm ls viem` shows one app instance + WC still works (CI green). If
it risks WC → **do NOT force it**; document the residual in FEEDBACK and leave it as accepted bloat.

## Do NOT
- Don't change the CoW fail-soft logic (only add the alert). Don't force a viem override that breaks WC.
- Don't touch non-sensitive `localStorage` prefs. Don't change any gate/contract. Don't deploy.

## Files
- `src/lib/adapters/cow.ts` + a server-only monitor + the alert path (W7-L-01)
- `src/lib/secure-storage.ts` (W9-L-01)
- `src/hooks/useSwap.ts` (W5-I-02)
- `package.json` overrides — only if the assessment says safe (W10-L-01)

## Output
Branch `chore/audit-cleanup-lows` off `main`; SSH-signed; CI green; one commit per item. Tests: fee-zero
alert fires at threshold (and not below); secure-storage refuses plaintext for sensitive metadata;
`npm ls viem` delta if the override was safe. FEEDBACK records each item's disposition
(fixed / assessed-left).
