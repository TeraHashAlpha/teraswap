# Recon — CodeQL on main (2026-11-03)

READ-ONLY. Base `origin/main` @ `19cced7` (PR #637). Local CLI 2.27.2 (`gh codeql`), suite
`codeql/javascript-queries:codeql-suites/javascript-security-extended.qls` via `scripts/codeql-local.sh`
(1015 TS/JS files + 9 Actions files scanned). No source, workflow, query or alert state touched.

- [x] Run full security-extended suite on origin/main → **19 alerts**
- [x] List GitHub code-scanning for `refs/heads/main` (read-only)
- [x] Reconcile local vs GitHub
- [x] Table + PRIORITY flags + fix batches

## Reconciliation (local 19 vs GitHub)

GitHub, ref main: **1 open** (#86 `js/log-injection` `src/lib/rpc-env.ts:91`) + **18 dismissed** (#2, #11–14, #30, #34, #42–48, #50, #51, #54, #79).
Local: 19 results. Matched 1:1 on rule id + file:line (orders/route.ts 165/174/256 each fire twice = #43–48; plus 481 = #50, 493 = #51). **No difference in suite or query set**: `codeql.yml` already runs `security-extended`, so there is no default-vs-extended gap. The gap is purely **dismissals**: the Security tab's open filter hides 18 alerts that the local run (which knows nothing of dismissals) prints.

Side finding: the inline `// codeql[js/...]` comments in `orders/route.ts` and `fingerprint-validator.ts` have **no effect** — the local run still reports every one of those lines. The 18 are suppressed only by UI dismissals, so they will resurface as NEW open alerts if a refactor moves/changes the flagged line (fingerprint change). Not compared: pinned Action v4.37.4 query pack vs latest local pack (counts coincide, so no drift seen).

## Alerts (19). Group B (keeper) and D (tests): 0 alerts — nothing under `contracts/order-engine/` or `*.test.*` is flagged.

Sev = GitHub `security_severity_level`. "GH" = alert number/state (open / dismissed).

| GH | Rule | Sev | File:line | Reachable from | Real risk | Proposed fix (code-level) | Eff |
|---|---|---|---|---|---|---|---|
| **A — production server** | | | | | | | |
| #86 open | log-injection | med | src/lib/rpc-env.ts:91 | `?chainId=` on `/api/quote?debug=sources` (bearer-gated by `DEBUG_QUOTE_TOKEN`; `getChainStatus` rejects unsupported ids; `Number()` can't carry CR/LF; logged name comes from a static array) | none (log-flood bound only if gate absent) | in `logSourceOnce`: `if (!(chainId in SERVER_NAMES)) return` before add/log — also bounds `loggedChains` | S |
| #43 | user-controlled-bypass | high | api/orders/route.ts:165 | request body `signature` presence | none — rejects, ECDSA recovery at :370–377 is the boundary | move presence/format checks into one `parseOrderBody()` result type consumed by the route | M |
| #44 | user-controlled-bypass | high | api/orders/route.ts:165 | same line, 2nd path (`orderHash`) | none | same as #43 | (batch) |
| #45 | user-controlled-bypass | high | api/orders/route.ts:174 | body `amountIn` | none — fast-fail; signed amount + on-chain `OrderTooSmall` bind | same | (batch) |
| #46 | user-controlled-bypass | high | api/orders/route.ts:174 | 2nd path | none | same | (batch) |
| #47 | user-controlled-bypass | high | api/orders/route.ts:256 | body `priceFeed` | none — format check; feed is signature-bound + on-chain `_checkPriceCondition` | same | (batch) |
| #48 | user-controlled-bypass | high | api/orders/route.ts:256 | 2nd path | none | same | (batch) |
| #50 | user-controlled-bypass | high | api/orders/route.ts:481 | body `routerDataHash` (v3 non-DCA) | none — hash is in the verified EIP-712 message (recovery :370 precedes :481) | same | (batch) |
| #51 | user-controlled-bypass | high | api/orders/route.ts:493 | body `orderData.routerData` | none — presence precondition for `verifyRouterDataHash` (:499) | same | (batch) |
| #79 | insufficient-password-hash | high | src/lib/auth.ts:47 | env `ADMIN_API_KEYS_SECRET` (+ request `Authorization`) | none today (HMAC comparator, machine token, no stored digest) | length-normalise + `timingSafeEqual` on raw Buffers without hashing a secret-named value; re-run local CodeQL to confirm it clears | S |
| #2 | insufficient-password-hash | high | src/lib/api-auth.ts:94 | request API key → `hashApiKey` → DB lookup | none — 256-bit random token, lookup digest | only real fix is keyed HMAC + migration of stored `key_hash` (dual-read window) | L |
| #30 | file-access-to-http | med | api/telegram/webhook/route.ts:163 | env `TELEGRAM_BOT_TOKEN` into fixed host `api.telegram.org`; `text` is bot-built | none (secret stays in URL path to a fixed host; `err.message` only logged) | single `telegramApi(method)` helper owning the URL; webhook + setup script share it | S |
| #12 | disabling-certificate-validation | high | src/lib/fingerprint-validator.ts:319 | none — `captureLiveTLS(ep.hostname)`, hostnames from static `MONITORED_ENDPOINTS` (monitoring-loop.ts:270) | none (cert read for pin compare; no payload) | no clean fix (`rejectUnauthorized:false` is the point); consolidate with #11 into one shared helper so 1 alert instead of 2 | S |
| **C — client** | | | | | | | |
| #34 | xss-through-dom | high | src/components/TokenAddressBadge.tsx:124 | token address from token list / search results (third-party) | none — rendered only if `isAddress(address)` | compute `href` in a helper returning `string \| null` that re-validates and builds via `new URL`; render anchor on non-null | S |
| **E — scripts/tooling (operator-run, not in bundle)** | | | | | | | |
| #11 | disabling-certificate-validation | high | scripts/capture-endpoint-baseline.ts:54 | script-only (CLI host list) | none | share helper with #12 | S |
| #14 | file-system-race | high | scripts/capture-endpoint-baseline.ts:241 | script-only | none | write temp file + `renameSync` (drop exists-then-write) | S |
| #13 | clear-text-logging | high | scripts/setup-telegram-webhook.ts:34 | script-only; prints only `length` of env secret | none | print `set` without the length | S |
| #42 | http-to-file-access | med | scripts/verify-arbitrum-addresses.mjs:238 | RPC responses → fixed path `docs/Reports/ARBITRUM-ADDRESS-MANIFEST.json`, only when 0 failures | none (superseded manifest) | write only the pre-validated manifest object (schema-check before write) | S |
| #54 | file-access-to-http | med | scripts/verify-arbitrum-chainlink-feeds.mjs:179 | script-only; registry JSON → RPC URLs | none | allow-list RPC hosts before `fetch` | S |

## PRIORITY (fund flow / signing / order creation / auth / secrets)

1. **`api/orders/route.ts` #43–48, #50, #51 — order creation + signing.** Path: POST body → `/api/orders` → shape checks (:165, :174, :256) → `recoverTypedDataAddress` vs `body.wallet` (:370–377) → v3 `routerDataHash`/`routerData` checks (:481–499) → persisted order the keeper replays. All 8 are reject-on-bad-input guards upstream of or bound to the signature; I found no path where a body value skips signature recovery or the on-chain checks. Any refactor here is fund-flow → **Auditor**.
2. **`auth.ts:47` / `api-auth.ts:94` — auth/secrets.** Path: `Authorization` header → `verifyBearerToken` (admin/monitor/debug gates incl. `DEBUG_QUOTE_TOKEN`) and API key → `hashApiKey` → `api_keys.key_hash`. No weakness found (random 256-bit tokens); the only real change (keyed hash) touches stored credentials → **Auditor**, and is L.
3. **`telegram/webhook/route.ts:163`** — bot token (secret) interpolated into a fixed-host URL; no leak path seen (error log prints `err.message` only). Low; note for a shared helper.
4. `fingerprint-validator.ts:319` feeds `forceDisable` (kill-switch) in the monitor; hostnames are static, so not attacker-reachable.

## Fix batches (none propose dismissing)

| Batch | Alerts | Model / effort | Auditor? | Note |
|---|---|---|---|---|
| B1 | #86 | Sonnet, low | no | only open alert; makes GH open count 0 |
| B2 | #34, #13, #14, #42, #54, #30 | Sonnet, low | no | small, isolated; one PR, verify with codeql-local |
| B3 | #11, #12 | Sonnet, medium | no | shared TLS-capture helper; still leaves ≥1 alert (inherent) |
| B4 | #79 | Sonnet, medium | **yes** | auth comparator; must keep timing-safety tests green |
| B5 | #43–48, #50, #51 | Sonnet, high | **yes** | `parseOrderBody()` refactor; no behaviour change allowed; CodeQL may still fire → prove with local run before claiming a clear |
| B6 | #2 | Opus/high, plan first | **yes** + owner decision | needs key_hash migration + dual-read; defer unless owner wants it |

Whatever lands, each PR should include a `codeql-local.sh` run on its own tree (before/after counts) — the inline `// codeql[...]` comments cannot be relied on, and dismissed alerts re-open when their line changes.
