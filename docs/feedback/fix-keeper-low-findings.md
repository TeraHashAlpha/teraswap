# fix/keeper-low-findings — feedback (A71b S-1..S-4, A73d L-1..L-2)

Base origin/main `f7c4887`. Auditor-note: keeper code, Lows only — owner opens the PR as DRAFT.
Compare: https://github.com/TeraHashAlpha/teraswap/compare/main...fix/keeper-low-findings
- [x] S-1 · [x] S-2 · [x] S-3 · [x] S-4 · [x] L-1 · [x] L-2 · [x] suites both Nodes · [x] CodeQL · [x] pushed

## 1. Per-finding (one commit each; "fails on main" = its test files vs that commit's source reverted to f7c4887)
| id | commit | file | change | test | fails on main |
|---|---|---|---|---|---|
| S-1 | 60279e8 | rpc-auth.js onRpcSuccess; event-watcher.js (poll) | clear only when `streaks.size === 0`; watcher reports `event-watcher:poll` success | rpc-auth-pause-clear.test.mjs | 3/4 |
| S-2 | 4cf8a7b | rpc-auth.js readOwnedState/writeOwnedState | `lstat`, refuse symlinked dir; `O_NOFOLLOW` read+write | rpc-auth-state-dir-symlink.test.mjs | 4/6 |
| S-3 | 769e540 | redact.js SCHEME_URL, ENCODED_SLASH/COLON | no lookbehind (leftmost); decode `%2F` `%252F` `/` `\x2f` `&#x2F;` `&#47;` `&sol;` first | redact-shapes.test.mjs | 19/31 |
| S-4 | 5631c2f | EXECUTOR-OPERATIONS.md §7 | `grep -iF` / `-HniF` | runbook-rpc-inventory.test.mjs (runs the block) | 2/3 |
| L-1 | 93873a5 | retry-policy.js collectErrorText | one `MAX_CAUSE_DEPTH = 10` for both walks | retry-policy-chain-depth.test.mjs (real viem BaseError chains) | 5/6 |
| L-2 | a36fd09 | rpc-auth.js classifyRpcError | viem's guessed revert (InternalRpcError, no ExecutionRevertedError, no hex data) is not a revert | rpc-auth-internal-rpc-error.test.mjs (readContract/writeContract vs the stub) | 4/10 |
Extra commit 0ed3f6d: two runbook rows (recovery wording, −32603+auth words ⇒ rpc-auth). L-2: `rpc-transport` → `rpc-auth`, still infra.

## 2. Redaction shapes (key `TESTKEY`; before f7c4887 → after)
glued `0x`+40 hex+`https://…` LEAK→clean · 30 glued letters LEAK→clean (26: already clean; boundary was exactly 27) ·
`host%2Fv2%2Fkey` / `%2f` / `%252F` / `https%3A%2F%2F…` / schemeless `%2F` LEAK→`https://host/REDACTED` ·
`/`, double-escaped, `&#x2F;` LEAK→clean · `&#47;` clean→clean · controls (plain, `\/`, `rpc_https://`) clean→clean.

## 3. Suites
Keeper `node --test` 1025/1025 (base 976, +49): Node 20.20.2 (`npm ci --ignore-scripts`) 3/3 runs, Node 22.23.4 (`npm ci`) 3/3 runs, 0 cancelled.
vitest 415 files / 6674 · tsc 0 · eslint 93 warnings (limit 94; every changed file is ESLint-ignored).
CodeQL `security-extended` (CI's suite): origin/main 13 → branch 13, no per-rule/file difference.

## 4. Diff
`git diff --stat origin/main`: 12 files, +679 −24 (excl. this file: 11 files, +641 −24) — 4 src (rpc-auth, redact, retry-policy, event-watcher), 6 tests (one extended: runbook-rpc-inventory, redact-shapes), 1 runbook + this file.

## Notes
- Node 20/22 are not on the host: official tarballs, SHA-256 checked against nodejs.org, run from the session scratchpad.
- Extra read (premise check, grep + 2 line ranges): onRpc* call sites in event-watcher.js/executor.js. S-1's premise held: the
  watcher tags its processing phase `event-watcher:poll` but never reported success for it. No deadlock: a paused cycle still
  returns normally, so `cycle`/`balance-read` keep reporting (idle mode only slows it).
- S-3 "`/` encodings": the goal text shows a bare `/`; read as the other slash escapes and covered all of them (over-decoding only over-redacts).
- Edge (S-1): an origin that stops being called holds the pause; every current origin is called each poll/cycle.
- Edge (S-2): a refused write means "not persisted", so a symlinked state dir alerts on every boot (louder, by design).

---

# A74 (blocked 0C/4H) — S-5..S-12 fixed on this branch

Audited head `0ec5676`. One commit per id; every test file was run RED on the head it was written against
(counts below are failing/total on the immediately preceding commit) and GREEN after. Fixture key `TESTKEY` only.
- [x] S-5 · [x] S-6 · [x] S-7 · [x] S-8 · [x] S-9 · [x] S-10 · [x] S-11 · [x] S-12 · [x] suites (Node 20 + 22) · [x] lint/tsc · [x] CodeQL · [x] pushed (draft stays the owner's)

## Per-finding
| id | sev | commit | file | change | test (red→green) |
|---|---|---|---|---|---|
| S-5 | H | a3db04f | redact.js | one fixpoint decoder (`%`×n, `\u` `\u{}` `\x`, octal `\057`, `&#x…;?` `&#…;?` `&name;` behind any `&amp;`) for `/ : @ ? # \ %`; authority that is not plain host[:port] → `[authority-redacted]`; >16 mixed layers fail closed | redact-s5-delimiters.test.mjs 55/68 → 68/68 |
| S-6 | H | 099e9ef | redact.js | no boundary: schemeless host:port / dotted-host patterns anchor on the path delimiter and look BEHIND it (same regex as the scheme URL); schemeless `user:secret@host/path` loses its userinfo | redact-s6-schemeless.test.mjs 16/32 → 32/32 |
| S-7 | H | ed344e1 | redact.js | scheme userinfo is its own group `(?:[^\s/?#]*@)?` in front of TAIL | redact-s7-userinfo.test.mjs 13/25 → 25/25 |
| S-8 | H | 1fffa20 | redact.js | allow-list keeps only `^/(tx\|address\|block)/0x[0-9a-f]+$` on an authority that is exactly an allowed host (no port/userinfo) | redact-s8-explorer-tails.test.mjs 23/37 → 37/37 |
| S-9 | M | c646748 | redact.js | `\\{1,8}` in all three decoders + one linear clamp of runs ≥9 to 8 | redact-s9-backslash-dos.test.mjs 9/19 (8 timing cases at 5–8 s each, measured on the audited code) → 19/19 |
| S-10 | L | e6932cf | rpc-auth.js | streak ages out after `RPC_AUTH_STREAK_TTL_MS` (15 min) without a new auth error; stale count restarts at 1 | rpc-auth-streak-aging.test.mjs 5/7 → 7/7 |
| S-11 | L | 23423e9 | executor.js runTick | no `onRpcSuccess("cycle")` when the cycle moved `stats.pausedCycles` | executor-paused-cycle.test.mjs (runs the SHIPPED runTick text, real monitor) 3/6 → 6/6 |
| S-12 | L | d8ce445 | rpc-auth.js (+runbook row) | parent (HOME) not group/other-writable; dir pinned by fd (O_DIRECTORY\|O_NOFOLLOW, same inode, fchmod); file opened w/o O_TRUNC, fstat (regular, uid, nlink 1), path+dir re-lstat after open, then ftruncate/fchmod 0600/write | rpc-auth-state-fd.test.mjs 16/21 → 21/21 |

## Judgement calls (deviations from the finding text, with reasons)
1. **S-9** — `\\{1,8}` as asked, PLUS the clamp. `\\{1,8}` alone decodes 8 backslashes per pass, so 9+ backslashes in front of a
   delimiter leave a residue that hides it (`https:` + 20×`\` + `/` …) and would cost one full pass per 8; tests cover 1/2/8/9/16/100/5000.
2. **S-6** — not "allow a start after a /": the schemeless patterns no longer start at a host at all (see table). Dropping the
   boundary from the old shape would re-match an already-handled allowed explorer link and make every position pay a
   255-char scan (measured: 1 MB of `a` is 74 ms now).
3. **S-7** — a group in the scheme alternative, not a separate earlier pass: a pre-pass loses "this URL had userinfo ⇒ always
   redacted" (pinned by redact.test.mjs) and would let `https://u:KEY@basescan.org/tx/0x…` through S-8 as a clean link.
4. **S-10** TTL = 15 min (> 2× the 5-min idle cadence at which a still-refused origin re-reports). Consequence the Auditor
   should know: with S-11, a pause held by a `cycle` streak clears up to 15 min after the key is fixed (a paused cycle cannot
   prove the origin); if `cycle` is still refused it re-pauses (runtime alert again) — noisy, never silent. Runbook row says so.
5. **S-11** — detection is the `stats.pausedCycles` delta around `executeCycle` (no signature change; idle-backoff pins
   still pass). A cycle that trips the pause during itself counts as paused.
6. **S-12** — strict: any group/other-writable parent refuses (no sticky-bit exemption); the write refuses BEFORE `mkdir`
   under such a parent. `readOwnedState`/`writeOwnedState` are exported with a test seam `{ afterOpen }`.
   `uid`/`nlink` cannot be forged unprivileged: the predicate `assertOwnedRegularFile` is unit-tested with stat-shaped objects,
   nlink with a real hard link.
7. **Behaviour changes to know**: the `file://` keep-the-frame exception now needs an EMPTY authority and no userinfo;
   decoding applies to the whole alert text, so a stray `%3A`/`%40` anywhere becomes `:`/`@` (over-decode only over-redacts);
   plain `&amp;` is never decoded (Telegram HTML needs it); an authority outside plain host[:port] (e.g. an IDN host) is shown as
   `[authority-redacted]`.

## Hostile-shape matrix (before = `0ec5676`, after = this head; `redactUrl`, key `TESTKEY`; script in the session scratchpad)
| id | shape | before (0ec5676) | after |
|---|---|---|---|
| S-5 | %3F in authority | **LEAK** `https://base-mainnet.g.alchemy.com%3Fapikey=TESTKEY` | clean `https://base-mainnet.g.alchemy.com/REDACTED` |
| S-5 | %23 in authority | **LEAK** `https://base-mainnet.g.alchemy.com%23TESTKEY` | clean `https://base-mainnet.g.alchemy.com/REDACTED` |
| S-5 | %253F multi-fold | **LEAK** `https://base-mainnet.g.alchemy.com%253Fapikey=TESTKEY` | clean `https://base-mainnet.g.alchemy.com/REDACTED` |
| S-5 | %25253F triple | **LEAK** `https://base-mainnet.g.alchemy.com%25253Fapikey=TESTKEY` | clean `https://base-mainnet.g.alchemy.com/REDACTED` |
| S-5 | %40 userinfo boundary | **LEAK** `https://user:TESTKEY%40base-mainnet.g.alchemy.com/REDACTED` | clean `https://base-mainnet.g.alchemy.com/REDACTED` |
| S-5 | %3A host:port | clean `https://base-mainnet.g.alchemy.com%3A8545/REDACTED` | clean `https://base-mainnet.g.alchemy.com:8545/REDACTED` |
| S-5 | &#x3F; entity ? | clean `https://base-mainnet.g.alchemy.com&/REDACTED` | clean `https://base-mainnet.g.alchemy.com/REDACTED` |
| S-5 | &quest; named ? | **LEAK** `https://base-mainnet.g.alchemy.com&quest;apikey=TESTKEY` | clean `https://base-mainnet.g.alchemy.com/REDACTED` |
| S-5 | &#x23; entity # | clean `https://base-mainnet.g.alchemy.com&/REDACTED` | clean `https://base-mainnet.g.alchemy.com/REDACTED` |
| S-5 | &#x40; entity @ | **LEAK** `https://user:TESTKEY&/REDACTED` | clean `https://base-mainnet.g.alchemy.com/REDACTED` |
| S-5 | &amp;#x2F; stacked | **LEAK** `https:&amp;#x2F;&amp;#x2F;base-mainnet.g.alchemy.com&amp;#x2F;v2&a…` | clean `https://base-mainnet.g.alchemy.com/REDACTED` |
| S-5 | &amp;amp;#47; stacked x2 | **LEAK** `https:&amp;amp;#47;&amp;amp;#47;base-mainnet.g.alchemy.com&amp;amp…` | clean `https://base-mainnet.g.alchemy.com/REDACTED` |
| S-5 | &#x2F no ';' | **LEAK** `https:&#x2F&#x2Fbase-mainnet.g.alchemy.com&#x2Fv2&#x2FTESTKEY` | clean `https://base-mainnet.g.alchemy.com/REDACTED` |
| S-5 | &#47 no ';' | **LEAK** `https:&#47&#47base-mainnet.g.alchemy.com&#47v2&#47TESTKEY` | clean `https://base-mainnet.g.alchemy.com/REDACTED` |
| S-5 | &#x2F glued to 0x… | clean `https://base-mainnet.g.alchemy.com&/REDACTED` | clean `https://base-mainnet.g.alchemy.com/REDACTED` |
| S-5 | &#37;2F entity-wrapped % | clean `https://base-mainnet.g.alchemy.com&/REDACTED` | clean `https://base-mainnet.g.alchemy.com/REDACTED` |
| S-5 | \057 octal slash | **LEAK** `https:\057\057base-mainnet.g.alchemy.com\057v2\057TESTKEY` | clean `https://base-mainnet.g.alchemy.com/REDACTED` |
| S-5 | \072 \057 octal colon+slash | **LEAK** `https\072\057\057base-mainnet.g.alchemy.com\057v2\057TESTKEY` | clean `https://base-mainnet.g.alchemy.com/REDACTED` |
| S-5 | \100 octal @ | **LEAK** `https://user:TESTKEY\100base-mainnet.g.alchemy.com/REDACTED` | clean `https://base-mainnet.g.alchemy.com/REDACTED` |
| S-5 | \u003f / \x3f | **LEAK** `https://base-mainnet.g.alchemy.com\u003fapikey=TESTKEY` | clean `https://base-mainnet.g.alchemy.com/REDACTED` |
| S-5 | authority host:KEY | **LEAK** `https://base-mainnet.g.alchemy.com:TESTKEY` | clean `https://[authority-redacted]/REDACTED` |
| S-5 | authority host;KEY | **LEAK** `https://base-mainnet.g.alchemy.com;TESTKEY` | clean `https://[authority-redacted]/REDACTED` |
| S-6 | after '/' (/rpc/host/v2/KEY) | **LEAK** `GET /rpc/base-mainnet.g.alchemy.com/v2/TESTKEY` | clean `GET /rpc/base-mainnet.g.alchemy.com/REDACTED` |
| S-6 | after '/' via %2F | **LEAK** `GET /rpc/base-mainnet.g.alchemy.com/v2/TESTKEY` | clean `GET /rpc/base-mainnet.g.alchemy.com/REDACTED` |
| S-6 | after ':' | **LEAK** `url:base-mainnet.g.alchemy.com/v2/TESTKEY` | clean `url:base-mainnet.g.alchemy.com/REDACTED` |
| S-6 | after '=' | clean `endpoint=base-mainnet.g.alchemy.com/REDACTED` | clean `endpoint=base-mainnet.g.alchemy.com/REDACTED` |
| S-6 | 0x<64 hex> glued | **LEAK** `0xabababababababababababababababababababababababababababababababab…` | clean `0xabababababababababababababababababababababababababababababababab…` |
| S-6 | 0x<64 hex> glued, host:port | clean `0xabababababababababababababababababababababababababababababababab…` | clean `0xabababababababababababababababababababababababababababababababab…` |
| S-6 | schemeless user:KEY@host/path | **LEAK** `conn user:TESTKEY@base-mainnet.g.alchemy.com/v2/x` | clean `conn base-mainnet.g.alchemy.com/REDACTED` |
| S-7 | password with ')' | **LEAK** `https://user:pa)TESTKEY@base-mainnet.g.alchemy.com/v2/x` | clean `https://base-mainnet.g.alchemy.com/REDACTED` |
| S-7 | password with '(' | **LEAK** `https://user:pa(TESTKEY@base-mainnet.g.alchemy.com/v2/x` | clean `https://base-mainnet.g.alchemy.com/REDACTED` |
| S-7 | password with ',' | **LEAK** `https://user:pa,TESTKEY@base-mainnet.g.alchemy.com/v2/x` | clean `https://base-mainnet.g.alchemy.com/REDACTED` |
| S-7 | password with "'" | **LEAK** `https://user:pa'TESTKEY@base-mainnet.g.alchemy.com/v2/x` | clean `https://base-mainnet.g.alchemy.com/REDACTED` |
| S-7 | password with '"' | **LEAK** `https://user:pa"TESTKEY@base-mainnet.g.alchemy.com/v2/x` | clean `https://base-mainnet.g.alchemy.com/REDACTED` |
| S-7 | password with '<' '>' | **LEAK** `https://user:pa<TESTKEY>@base-mainnet.g.alchemy.com/v2/x` | clean `https://base-mainnet.g.alchemy.com/REDACTED` |
| S-7 | bare host + ')' userinfo | **LEAK** `https://TESTKEY)@base-mainnet.g.alchemy.com` | clean `https://base-mainnet.g.alchemy.com/REDACTED` |
| S-8 | explorer ?apikey= | **LEAK** `https://basescan.org/api?apikey=TESTKEY` | clean `https://basescan.org/REDACTED` |
| S-8 | explorer /v2/KEY | **LEAK** `https://basescan.org/v2/TESTKEY` | clean `https://basescan.org/REDACTED` |
| S-8 | tx link + ?apikey= | **LEAK** `https://basescan.org/tx/0xabababababababababababababababababababab…` | clean `https://basescan.org/REDACTED` |
| S-8 | tx link + #KEY | **LEAK** `https://basescan.org/tx/0xabababababababababababababababababababab…` | clean `https://basescan.org/REDACTED` |
| S-8 | tx link + /KEY | **LEAK** `https://basescan.org/tx/0xabababababababababababababababababababab…` | clean `https://basescan.org/REDACTED` |
| S-8 | tx link + %3Fapikey= | **LEAK** `https://basescan.org/tx/0xabababababababababababababababababababab…` | clean `https://basescan.org/REDACTED` |
| S-8 | good tx link (kept) | kept `https://basescan.org/tx/0xabababababababababababababababababababab…` | kept `https://basescan.org/tx/0xabababababababababababababababababababab…` |
| S-9 | 80k '\' + 'q' (time) | clean, 12577 ms | clean, 0 ms |
| S-9 | 50 '\' before '/' (decoded) | clean `https://base-mainnet.g.alchemy.com/REDACTED` | clean `https://base-mainnet.g.alchemy.com/REDACTED` |

rows leaking before: 35 / 45; after: 0 / 45

## Known residuals (not in A74's list; none reproduces the audited leaks)
- Schemeless `user:KEY@host.example` with NO path after it (looks like an e-mail address) is left alone.
- `\` as a URL separator (`https:\\host\v2\KEY`, which WHATWG parsers read as `/`) is not treated as a slash — only the *escaped* slash forms are.
- Schemeless IPv4 + path without a port (`10.0.0.5/v2/KEY`) is not matched (pre-existing); with a scheme it is.
- A password containing whitespace ends the userinfo at the space; TAIL still stops a PATH/query secret at `( ) , ' " < >`.
- `<a href="https://host">me@x.com</a>` (no path after the host) reads `">me@` as userinfo and is over-redacted.
- Letters written as entities (`&#104;ttps`) or fullwidth look-alikes are not decoded.

## Suites
Keeper `node --test`: **1240/1240** (0 cancelled, 0 skipped) — Node 20.20.2 (`npm ci --ignore-scripts`) 3/3 runs, Node 22.23.4 (`npm ci`) 3/3 runs (base 1025 at `0ec5676`, +215).
vitest 415 files / 6674 · tsc 0 · eslint 93 warnings (limit 94) · CodeQL `security-extended` (CI's suite): merge-base `f7c4887` 13 → head 13, identical rule+file+line sets (diff empty), 0 new, none in `contracts/order-engine/executor/`.
Node 20/22: official darwin-arm64 tarballs, SHA-256 checked against nodejs.org SHASUMS256.txt, run from the session scratchpad.

## Feedback — CI red on PR #659 (fix commit: this one; `keeper-suite` + `Keeper Tests`, 1240 tests / 1239 pass / 1 fail / 0 cancelled)

### Assumption that turned out wrong
- The "1240/1240 on Node 20 and 22" claim above was measured on macOS only. It said nothing about Linux: the failing test passed on every local run because the host's `TMPDIR` is a private 0700 directory.

### Root cause
- Failing test: `boot gate — one alert per cooldown across pm2 restarts` → `an explicit file round-trips on the real filesystem` (`contracts/order-engine/executor/rpc-auth.test.mjs`, `true !== false` on the second `check().send`).
- The test put the gate file at `<mkdtemp(os.tmpdir())>/gate.json`, so the *state directory* was the mkdtemp dir and its **parent was `os.tmpdir()`**. On the ubuntu-24.04 runner that is `/tmp` (mode 1777, group/other-writable), which the A74 S-12 `assertTrustedParent` check refuses by design — the write was refused (swallowed, "louder, never quieter"), the file was never created, and the second boot found no state ⇒ `send === true` instead of `false`.
- It is NOT the HOME check (no test reads the real HOME; the S-12 suites build their own HOME fixtures) and NOT the S-10 ageing/timers (nothing time-dependent in the failing test).
- Reproduced locally with `TMPDIR=/tmp` (macOS `/tmp` is 1777 too): same assertion, 36/37 in the file. Full suite under a CI-like env (`env -i`, no TTY, `CI=true`, umask 022, `TMPDIR=/tmp`) on Node 20.20.2 before the fix: 1240 / 1239 / 1 / 0 — identical to the CI numbers.

### Fix
- Test only: the state directory now lives inside the test's own 0700 mkdtemp dir (`<mkdtemp>/state/gate.json`). Production code is unchanged — the parent-writability check stays strict.

### Test gap
- No other test in the executor suite builds a state directory directly under `os.tmpdir()` (the S-12 / boot-gate / boot tests all use a mkdtemp dir as HOME, so the parent is private). Worth keeping that rule for any future gate fixture: never let `os.tmpdir()` be the state directory's parent.
- Verification matrix now includes `TMPDIR=/tmp`: Node 20.20.2 ×3 + Node 22.23.4 ×3 under the CI-like env, HOME 0755: 1240/1240, 0 fail, 0 cancelled; plus Node 20 with HOME 0775 and 0700: same.
