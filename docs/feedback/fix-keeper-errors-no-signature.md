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

## Round 2 — A92 audit of PR #717 (blocked 0C/1H), findings S-1..S-8

### Owner answers, round 2 (asked once, 2026-11-18; they supersede the goal text)

1. S-3 vs "existing redaction tests unchanged": the four exact-output assertions of round 1's own
   redact-s2-error-text.test.mjs (:41, :46, :61, :67) get the `address:` / `function:` lines in their expected texts
   (still exact matches); every other existing test stays byte-identical.
2. S-1 also fixes list-missing-fills.mjs:110 (scanLogsChunked's retry log line, reached by both CLIs).
3. S-1 timeout case: a test-only preload turns only viem's own 10,000 ms timer into 200 ms in the child CLI; the
   provider socket really hangs and viem's real TimeoutError is what gets printed.
4. S-3's optional part is done: monitor.js:70's "Last error" alert names the order (first 8 characters of its id).

### Checklist, round 2

- [x] Merge origin/main 85a6f9cb with a normal, signed merge commit (68769f0c); main's 17 files touch no keeper file.
- [ ] C1 S-1: CLIs print `redactError(err)` (list-missing-fills.mjs :110, :287, :325; backfill-execution.mjs :297),
      backfill :149 the RPC host only; spawn test red on the head first, then green.
- [ ] C2 S-2 (chain-verify errText one line) + S-3 (`address:` and `function:` name kept; order id in the alert).
- [ ] C3 S-4 (extractRevertData depth 16) + S-5 (rpc-auth URL-only redaction; 20,000-text differential vs main).
- [ ] C4 S-7 (line references in redact-s2-signature.test.mjs).
- [ ] Proof: signature probe, mutants, keeper Node 20 + 22, gitleaks; one agent-verify; evidence; push.
