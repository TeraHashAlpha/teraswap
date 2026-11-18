# fix/keeper-errors-no-signature — feedback

A87 S-2 (audit of PR #709, pre-existing on origin/main 7bd3ec12): `redactError` printed viem's `err.message`, whose
`args:` carry the order's EIP-712 signature, to the keeper log and Telegram; texts over 4,096 were refused (alert lost).
Keeper code: Draft PR, **Auditor required**. Tables: `fix-keeper-errors-no-signature.tables.md`.

## Owner answers (asked once, 2026-11-18; they supersede the goal text)

1. redactError = `Name: shortMessage` (else first line) + decoded revert reason + viem's `URL:`/`Status:`/`Details:`
   lines; then URL redaction, args/data/Request Arguments + 130+ hex scrub, 600 cap with marker (two existing tests pin
   those lines; "first line only" broke them).
2. App: one shared scrub (`alert-channels/utils.ts` scrubAlertText) on the reason in all three outgoing bodies AND on
   the error each channel throws.
3. Both extra keeper guards: `0x` 130+ hex scrub in `redactUrl`; cap below 4,096 in alert.js `sendTelegramAlert`.

## Checklist

- [x] 1. Inventory, file:line, every keeper sink grouped by the redactor it goes through, and the 9 app channel sinks
      (tables §1). Signature-bearing: executor.js:2156, :2161 (→ monitor.js:70), :2644 (→ monitor.js:126), fatal :2665.
- [x] 2. Step 0 (redact-s2-signature.test.mjs): origin/main code 28/29 FAIL (9/9 log lines, 18/18 alerts leak; alert up
      to 14,907 chars); head 29/29 (tables §2).
- [x] 3. Alert samples: 1,419–14,907 chars with `<SIG>` → 275–298 chars, class + short reason + URL host + Details
      (tables §3).
- [x] 4. Property: seeds 1..24 × 40 in CI; `S2_SEEDS=1-500` green locally (20,000 + 20,000 cases). Mutants on a
      scratch copy: hex scrub removed, cap removed, shortMessage ignored, plus three more, all killed (tables §4).
      App test red with origin/main's channels 10/19, green 19/19.
- [x] 5. `agent-verify.sh --keeper --codeql`, ONE run on a quiet machine (load1 3.5, no other verify/CodeQL), head
      232aa5e6, base origin/main 85a6f9cb: **PASS**: suite 11,110/0 (521 files), lint +0/+0, tsc 0, build ok, parity 123,
      rpc-budget 36, CodeQL 13 = 13 (0 new), keeper Node 20 and 22 2,167/0/0 cancelled. `gen-claude-state --check`: current.
      gitleaks over the 7 code commits: no leaks. diff --stat: 16 files, +1,585/−76 (executor.js, basket-*, package.json
      untouched). Merges clean with origin/main 85a6f9cb. Compare:
      https://github.com/TeraHashAlpha/teraswap/compare/main...fix/keeper-errors-no-signature
      NOT verified: CI (owner opens the Draft PR); real Telegram/Resend/Discord delivery (fetch stubbed, no host
      touched; Telegram's 4,096 and HTML refusals are the audit's measurement); viem errors from a real provider (local
      stub only); a keeper on a chain; Linux (no permission code changed); seeds beyond 1-500; L-1 left open.

## Feedback — fix-keeper-errors-no-signature

### Edge case
- L-1: a boot refusal (executor.js:2444/2477) that embeds viem's two-line revert shortMessage loses its second line
  under the first-line rule (no signature involved). One-line fix, owner's call (tables §5).
- A plain `Error` gets no `Error:` prefix: chainlink-debug-read.test.mjs:105 pins that line unprefixed.

### Concern
- executor.js:2147 logs the router's raw revert bytes (`inner=`) outside any redactor; not the order signature, and
  executor.js is off-limits here. The operator CLIs (backfill-execution.mjs, list-missing-fills.mjs) print raw
  `err.message`; they make no signature-bearing call.
