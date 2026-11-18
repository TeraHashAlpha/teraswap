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
   (still exact matches; its header comment says so). Every test file on origin/main is byte-identical (the branch only
   adds test files); of round 1's own, only that file and redact-s2-signature.test.mjs (S-7: comments and two test
   names) changed; no assertion was loosened.
2. S-1 also fixes list-missing-fills.mjs:110 (now :114; scanLogsChunked's retry log line, reached by both CLIs).
3. S-1 timeout case: a test-only preload turns only viem's own 10,000 ms timer into 200 ms in the child CLI; the
   provider socket really hangs and viem's real TimeoutError is what gets printed.
4. S-3's optional part is done: monitor.js:70's "Last error" alert names the order (first 8 characters of its id).

### Checklist, round 2

- [x] Merge origin/main 85a6f9cb with a normal, signed merge commit (68769f0c); main's 17 files touch no keeper file.
- [x] C1 S-1 (206edc7e): CLIs print `redactError(err)` (list-missing-fills.mjs :110, :287, :325; backfill-execution.mjs
      :297), backfill :149 the RPC host only; spawn test red on the head first, then green.
- [x] C2 S-2 + S-3 (16f298ef): chain-verify errText one line; `address:` and `function:` name kept; order id in the alert.
- [x] C3 S-4 + S-5 (d8b2cfa4): extractRevertData depth 16; rpc-auth URL-only redaction; 20,000-shape differential vs main.
- [x] C4 S-7 (0e411f1f): line references in redact-s2-signature.test.mjs.
- [x] Proof: signature probe, mutants, keeper Node 20 + 22, gitleaks; one agent-verify; evidence; push.

### Evidence, round 2 (A92; full tables in `fix-keeper-errors-no-signature.tables.md` §R2)

1. Fixed, file:line, test. S-1: list-missing-fills.mjs:114, :291, :329 and backfill-execution.mjs:306 print `redactError(err)`, :158 names the RPC host only;
   redact-a92-s1-cli.test.mjs spawns both CLIs on a keyed URL (503 and hang): 6/6 red on 68769f0c, then green. S-2: chain-verify.js:242-249; redact-a92-s2-boot-reason.test.mjs (real boots). S-3:
   redact.js:237, :350, monitor.js:70, :272; redact-a92-s3-contract-call.test.mjs (the 9 cases). S-4: revert-decode.js:91, :103; redact-a92-s4-cause-depth.test.mjs. S-5: redact.js:179,
   rpc-auth.js:66, :124; rpc-auth-a92-s5-url-only.test.mjs. S-7: redact-s2-signature.test.mjs:7-8, :106, :114.
2. Alerts (dummy signature), before (788dcaa3) → after: read/revert onCycleEnd 296 → 390 chars, `Last error (order 0b3c9e1a…): …reason: not ready` + `address:   0x…beef` +
   `function:  canExecute`; estimateGas/timeout 275 → 353 and sendRawTransaction/RPC error 288 → 366, each + `address:   0x…beef` + `function:  executeOrder`. No signature in any.
3. S-5 differential (main = scratch `git archive` of origin/main 85a6f9cb): 20,000 seeded shapes, 12,578 with a 0x 130+ hex run glued to "unauthorized"; classifyRpcError and
   classifyMissCause, head vs main: 0 differ; round 1 vs main: 219 (the generator sees the defect). Mutants: 11/11 killed (the 5 named, the CLI one split per print line, plus 2).
   The audit's own p1 probe: 75 viem errors × 7 sinks, 0 signature fragments, Node 20 and 22; p2-cli 0 keyed lines; p3 endless cause 0 ms. gitleaks, 5 commits: no leaks.
4. `agent-verify.sh --keeper --codeql`, ONE run on 0e411f1f at load1 3.76 (no other verify/CodeQL): **PASS**: suite 11,190/0 (526 files), lint +0/+0, tsc 0, build ok, parity 123,
   rpc-budget 36, CodeQL 13 = 13 (0 new), keeper Node 20 and 22 2,201/0/0. Verified CODE commit 0e411f1f; docs commit = the one that adds this section. diff --stat 788dcaa3..0e411f1f:
   keeper dir 15 files +809/−35 (whole tree 33 files +2,637/−66, main's 17 merged in). https://github.com/TeraHashAlpha/teraswap/compare/main...fix/keeper-errors-no-signature
   NOT verified: CI (owner opens/updates the Draft PR); real Telegram delivery; a real provider or chain (local stubs only); Linux; the CLIs against a live Supabase.

### Not here (A92)

- S-6 (executor.js:2147, the router's raw revert bytes logged with no redaction and no cap): left for the PR that rewrites executor.js.
- S-8 (7 gitleaks hits in commit a382a5ad on main, none in .gitleaksignore): report only; nothing in this branch touches them.

## Feedback — round 2 (A92)

### Edge case
- list-missing-fills.mjs:114 (scanLogsChunked's retry line) printed the keyed URL too and was not in A92 S-1 (owner answer 2).
- monitor.js:126 (onCycleError) cannot name the order: executor.js:2644 passes only `err`, and executor.js is off-limits here.

### Concern
- redact.js now exports `redactUrlOnly` (no hex scrub): only for text that is classified, never printed; a printed text must
  keep going through redactUrl / redactError (its doc comment says so).

## Round 3 — A93 audit of PR #717 round 2 (blocked 0C/1H), findings R2-1..R2-3

### Checklist, round 3

- [ ] origin/main unchanged since round 2 (85a6f9cb): no merge needed.
- [ ] C1 R2-1 (High): configured secrets removed by their literal value (redact.js SECRET_ENV_NAMES, built lazily once),
      last step of redactError / redactUrl / sendTelegramAlert's final pass / every CLI print; rpc-auth and retry-policy
      still read the raw text (S-5). Tests red on b367f054 first: the audit's 30 CLI runs, 3 call sites x 4 keeper sinks.
- [ ] C2 R2-2 + R2-3 (Low): both CLIs refuse an unparseable SUPABASE_URL / RPC URL naming only the variable; a boot
      refusal carries the provider's `details`, redacted, on one line.
- [ ] Proof: signature probes, classifier differential vs origin/main, over-redaction, seeded fuzz, mutants, keeper
      Node 20 + 22.
- [ ] One `agent-verify.sh --keeper --codeql` on the last code commit; evidence; push.
