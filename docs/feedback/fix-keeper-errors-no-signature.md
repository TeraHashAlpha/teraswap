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

- [x] origin/main was 85a6f9cb at the start; it moved mid-round (e613792c, PR #716, token catalog, no keeper file): signed
      merge eeaf3661 before the verify.
- [x] C1 R2-1 (High), 68f5ab28: configured secrets removed by their literal value (redact.js SECRET_ENV_NAMES, built lazily
      once), last step of redactError / redactUrl / sendTelegramAlert's final pass / every CLI print; rpc-auth and
      retry-policy still read the raw text (S-5). Tests red on b367f054 first: the audit's 30 CLI runs, 3 call sites x 4 sinks.
- [x] C2 R2-2 + R2-3 (Low), b8afe818: both CLIs refuse an unparseable SUPABASE_URL / RPC URL naming only the variable; a
      boot refusal carries the provider's `details`, redacted, on one line.
- [x] Proof: signature probes, classifier differential vs origin/main, over-redaction, seeded fuzz, mutants, keeper
      Node 20 + 22.
- [x] `agent-verify.sh --keeper --codeql`: red on eeaf3661 (one CodeQL alert in my own test), fixed in 1a38a830, ONE run on
      1a38a830: PASS; evidence; push.

### Owner answers, round 3 (asked once, 2026-11-19; they supersede the goal text)

1. "Each of the audit's 30 CLI runs FAILS on b367f054 first": 23 of 30 do (14 print the key; 9 chain-verify runs lack the words R2-3 adds). The 7 `host:port/v2/<key>`
   echoes pass there: b367f054 already redacts them (the audit measured 14/30 leaking). Owner: accept 23/30 and record it; the 7 stay unchanged, as guards.
2. "agent-verify ONCE on the last code commit": the one verify is the single run on 1a38a830 (PASS). The reboot-killed attempt on b8afe818 (no result) and the red run on
   eeaf3661 (CodeQL 14 vs 13, an alert in my own new test, fixed in 1a38a830) are recorded as they happened (tables §R3-6). No further run.

### Evidence, round 3 (A93; tables in `fix-keeper-errors-no-signature.tables.md` §R3)

1. R2-1 (H) fixed: redact.js:248 SECRET_ENV_NAMES, :282 literals, :554 redactSecretLiterals, :213 redactUrl (first + last), :672/:774 redactError (fields, then last; cap
   after), alert.js:92, list-missing-fills.mjs:44 + backfill-execution.mjs:48 (every print). Tests redact-a93-r2-1-{cli,sinks,forms,names,fuzz}; on b367f054: 23 of the
   audit's 30 CLI runs fail (answer 1), 12/12 sinks, 12 forms cases. R2-2 (L) fixed: list-missing-fills.mjs:72, :257, backfill-execution.mjs:140 (redact-a93-r2-2-cli-url).
   R2-3 (L) fixed: chain-verify.js:259 (redact-a93-r2-3-boot-details). R2-2/R2-3 tests red on b367f054 and 68f5ab28 (13/14).
2. URL parts (userinfo, path segments, query values; never the host): RPC_URL, BACKFILL_RPC_URL, FLASHBOTS_RPC_URL, TERASWAP_API_URL, VAULT_ADDR, SUPABASE_URL. Whole:
   SUPABASE_SERVICE_ROLE_KEY, TELEGRAM_BOT_TOKEN, EXECUTOR_PRIVATE_KEY (+ without 0x), HEALTH_TOKEN, COINGECKO_API_KEY, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN.
3. Fuzz seeds 1-2000 x 60 x 9 sinks (Node 22; 1-200 Node 20; CI 1-12): 0 readable. Mutants 19/19 + 8/8 (§R3-4). Split by a line break: removed whole, also where redactError
   drops line 2; by a plain space: not matched (by design). Probes: 0 signature fragments; classifiers vs origin/main 0 of 40,000 differ.
4. ONE run on 1a38a830 (answer 2), load1 9.84: PASS (suite 11,363/0, CodeQL 13 = 13, keeper 2,300 x Node 20/22). SHAs: verified CODE 1a38a830; docs 95613438 + this trim.
   diff --stat b367f054..1a38a830: 41 files +4,525/−93 (keeper 13 +1,655/−61; main's 27). https://github.com/TeraHashAlpha/teraswap/compare/main...fix/keeper-errors-no-signature
   NOT verified: CI; real Telegram/provider/Supabase/chain (stubs); Linux; fuzz past seed 2000; executor.js raw body prints (below).

## Feedback — round 3 (A93)

### Edge case
- A secret split by a plain space (no line break) is not matched: a space is an ordinary character; skipping all would let a secret made of words match prose.
- The list is built once, at the first scrub (env.js loads first): a value put into process.env later is not seen (pinned by redact-a93-r2-1-names).

### Concern
- executor.js prints three response bodies through no redactor (:676 Supabase fetch error, :803 orders PATCH, :1028 Swap API error): a gateway echoing the service key
  there would print it. executor.js is off-limits here (as S-6).
- sendTelegramAlert's final pass writes `0x<hex N>` as a raw tag if a caller passes a raw 130+ hex run (Telegram would refuse it); no caller does today (latent, round 1).

## Round 4 — A96 audit of PR #717 round 3 (blocked 0C/1H), findings R3-1..R3-3

- [x] origin/main moved (e0c00390, PR #718): signed merge 96ad2f1f, no keeper file. [x] C1 R3-1 e338ec3e. [x] C2 R3-2 + R3-3 15463d12. [x] Proof. [x] ONE verify on 15463d12: PASS.
- No question asked (premise held). Not touched: executor.js, record-execution.js, basket-*, contracts, routes, UI, codeql-local.sh; R3-4..R3-7 out of scope.

### Evidence, round 4 (A96)

1. R3-1 (H): tests only, no production line changed (no new run leaked): redact-a93-r2-1-cli.test.mjs, 9 STDOUT runs in the extended group. Mutation (scratch copy, re-run on 15463d12): each say() definition unscrubbed is killed (backfill 5 tests, list 2); each call alone, killed by its own run: bkf :168 :171 :203 :247 :298, lmf :342 :348; all 9 pass on the head.
   R3-2 (L): redact.js readSpace + literalForms; redact-a96-r3-2-json-breaks.test.mjs (140, REAL HttpRequestError, 2 sites x 4 bodies x 9 sinks): 125/139 red on e338ec3e. R3-3 (L): chain-verify.js:260; redact-a96-r3-3-boot-head.test.mjs (9, one real HttpRequestError): 7 red on e338ec3e.
2. say() calls (bkf = backfill-execution.mjs, lmf = list-missing-fills.mjs). Can carry text, one run each: bkf :168 banner, :171 receipt, :203 order, :247 row, :298 write result; lmf :342 table, :348 result line. Cannot carry text, mutant survives (so no run): bkf :185 hex/bigint, :243 :272 :290 numbers/ISO,
   :275 :285 :293 :308 :310 constants, :284 :306 ok/status; lmf :322 address validated ^0x[0-9a-f]{40}$, :343 counts; bkf :228 and lmf :313 carry only redactError text (same scrub as its last step: equivalent; the scan-log run prints the line). No other console.* output (env.js:50 is stderr, redacted).
   Shown, not argued: scratch copy with BOTH say() scrubs removed, every text field of every stub answer (receipt, logs, block, order row, 401 body) = the marker, six modes run to exit 0 (backfill dry-run, APPLY, APPLY+401, --repair, --repair APPLY; lmf): the marker prints only on bkf :203 :247 :298 and lmf :342 (banner/receipt/:348 print it only from caller args or `to`, covered by the runs above); no other say() line ever carries it.
3. Verify: ONE run, on 15463d12, load1 4.4: PASS (suite 11,424/0, lint +0/+0, tsc 0, build ok, v1v2-parity 123, rpc-budget 36, keeper 2,458 on Node 20 and 22). Verified CODE 15463d12; docs commits after it. diff --stat beb2d0fd..15463d12, keeper dir: 5 files +599/-21 (rest of the range is main's PR #718).
   Compare: https://github.com/TeraHashAlpha/teraswap/compare/main...fix/keeper-errors-no-signature. Fuzz found two regressions of my own change (seeds 9, 383), fixed before the verify; seeds 1-600 pass. Probes: 0 signature fragments in 2,160 outputs (control 720/720 raw hold it); classifier differential vs origin/main and beb2d0fd: 20,000 cases, identical hash.
4. NOT verified: CodeQL not verified locally (pack broken on this Mac); CI; Linux; real Telegram/provider/Supabase/chain (stubs); fuzz past seed 600; %0a / &#10; breaks still not read as breaks; entity names case-sensitive (both pre-existing).

## Feedback — round 4 (A96)

### Edge case
- Reading `\t` as a blank made a secret's own backslash-t ambiguous after a break; fixed by the dropped reading, not by a rule in the walk. Secrets with more than 6 variable tokens get only the all-decoded / all-written / all-dropped forms (as before for escapes).
- e338ec3e's message says "ten" runs; it is nine (6 backfill, 3 list-missing-fills).

### Concern
- redact.js forms grow to 3^k for secrets holding k blanks or `\t`-like pairs (capped at 64, then 3 forms); no real secret has one.

## Round 5 — A99 audit of PR #717 round 4 (blocked 0C/4H), findings R4-1, R4-2, R4-3, R4-6, R4-8

- [x] origin/main unmoved (e0c00390): no merge. No question asked (premise held). [x] C1 R4-1 + R4-2 ae919c91. [x] C2 tests R4-3, R4-6, R4-8 b5400312. [x] re-pin 895554af, CodeQL fix a4cce00d. [x] Proof. [x] Verify. [x] Evidence.
- Not touched: executor.js, record-execution.js, basket-*, contracts, routes, UI; R4-4, R4-5, R4-7 out of scope.

### Evidence, round 5 (A99)

1. R4-1 (H): chain-verify.js:245 `scrubThenRedactUrls` (by value, then redactUrls) used by errText head :278 and details :281 and describeValue :299/:301; redact-a99-r4-1-scrub-order.test.mjs: 16 of 23 red on 31edeece (eth_chainId, eth_getCode schemeless, eth_call x LF/CRLF/LF+tab, 3 list-missing-fills child runs, describeValue, 3 redactError fallbacks); all 23 pass. R4-2 (H): same file, 6 tests (real viem Error(string) revert + injected, details "execution reverted"); green on 31edeece by design, red on mutant Q03 (6). R4-3: forms.test :175, red on P08 (1). R4-8: cli.test "decoded event" (hex-shaped service key as tokenIn), red on S185 (1). R4-6: json-breaks comment corrected, whole-message sink asserts the 600-char cap marker (red with the cap raised, 8) + new sink on the HttpRequestError message reaches Details (red with redactError(string) unscrubbed, 1).
2. Scrub-order sites: chain-verify.js details (was :267, fixed, R4-1) and head (was :264, already right, now via the helper); describeValue (was :285/:287; redactUrls with no by-value scrub; fixed); redact.js composeErrorText :736 (non-object) and :742 (no head) String(err) text reached redactUrlAndHex before the last scrub (fixed, scrubField). Checked, already right: redactUrl :218 (scrub, mask, scrub), redactError fields :726+, alert.js :83/:359, executor.js :2665 (all via redactUrl); rpc-auth.js :124 masks classified text, never printed; both CLIs' say() scrub only.
3. Verify (2 runs, load1 7.4 and 6.7): run 1 on 895554af: CodeQL 12 vs 11, 1 new js/incomplete-url-substring-sanitization at redact-a93-r2-3-boot-details.test.mjs:61 (my own added assertion), rest PASS; fixed in a4cce00d (assertion dropped, the exact string beside it proves the host is gone). Run 2 on a4cce00d: PASS (suite 11,424/0, lint +0/+0, tsc 0, build ok, parity 123, rpc-budget 36, CodeQL 11 = 11, keeper 2,491 on Node 20 and 22). Verified CODE a4cce00d (first code ae919c91); docs commit after it.
   diff --stat 31edeece..a4cce00d, keeper dir: 7 files +321/-15. Compare: https://github.com/TeraHashAlpha/teraswap/compare/main...fix/keeper-errors-no-signature
   Proof: classifier differential (classifyRpcError, classifyMissCause, classifyFailure), 20,000 seeded shapes: head vs origin/main 0 differ; refusals (3 sites + describeValue) and redactError with no secret configured: head vs 31edeece identical hash. Mutants 8/8 (c1) + 4/4 (c2) killed.
4. NOT verified: CI; Linux; real provider/chain (stubs); differential only with no secret configured (with one, refusal text changes by design); R4-4, R4-5, R4-7 open.

## Feedback — round 5 (A99)

### Edge case
- The mandated order changes the text of a refusal whose provider words hold a configured URL: `<redacted-url>` became `<redacted-url><redacted>` (the URL pattern stops at the mask's `<`), as the head has printed since A96. Four exact expectations (cli.test echoSchemeless x3, boot-details one) were re-pinned to the new exact text in 895554af; none loosened, the URL and key are still gone. A collapse of the glued mask (as redact.js MASK_IN_PATH does) would restore the old text; not done, to keep the order the audit named.

### Concern
- redact.js had two more String(err) fallbacks outside the two named sites (listed in evidence 2); contrived (an object with no message and a toString that holds a URL), fixed with the same order.
