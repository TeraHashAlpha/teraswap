## Feedback — fix/codeql-b1-b2 (CodeQL recon 82, batches B1+B2)

No PR. Base `origin/main` @ `3a78d86`; head = this branch (3 commits, all SSH-signed, noreply committer).

- [x] C1 B1 #86 · [x] C2 B2 #34 #13 #14 #42 #54 · [x] CodeQL/suite/lint/tsc/build · [x] pushed
- [ ] #30 — **owner decision: left out** (see Premise below)

### 1. Per-alert
| # | Rule · file:line | Change | Test |
|---|---|---|---|
| 86 | log-injection · rpc-env.ts:91 | `logSourceOnce` resolves the id via `RPC_ENV_CHAIN_IDS.find` — only a static literal is logged, set bounded to 3 | rpc-env.test +2 (hostile ids never logged, resolution unchanged; 1/8453/42161 once) |
| 34 | xss-through-dom · TokenAddressBadge.tsx:124 | `explorerHref()`: `isAddress` + `new URL` + https-only, anchor renders on non-null | badge test +4 (href unchanged, hostile addr, non-https base, flag off) |
| 13 | clear-text-logging · setup-telegram-webhook.ts:34 | prints `Secret token: set` (no length) | none (operator script) — CodeQL |
| 14 | file-system-race · capture-endpoint-baseline.ts:241 | read, ENOENT = none; `existsSync` check removed. #11 (line 54) untouched | none — CodeQL |
| 42 | http-to-file-access · verify-arbitrum-addresses.mjs:238 | `eth_blockNumber` schema-checked, re-emitted as same hex | live run: blocks `0x1f109f62`, 24/24, same format |
| 54 | file-access-to-http · verify-arbitrum-chainlink-feeds.mjs:179 | feed address → `getAddress(feed.toLowerCase())` before any RPC body | live run: 5 feeds OK, RPCs agree |

### Premise (recon was wrong on two of six)
- **#30**: not the bot token. SARIF path = baseline file (`fingerprint-validator.ts:162`) → `disabledReason` → Telegram text → `fetch` body. A URL helper cannot clear it; clearing means dropping baseline detail from operator messages (behaviour change). **Owner: leave out.** Stays UI-dismissed.
- **#54**: not RPC hosts; tainted value is the file-derived feed address in the request body. Fixed by validating that instead.

### 2. CodeQL (full `javascript-security-extended`, `codeql-local.sh`, 1026 files)
before **19** → after **13**. Gone: #86 #34 #13 #14 #42 #54. Still firing: orders/route.ts ×8, auth.ts, api-auth.ts, fingerprint-validator.ts:319, capture-endpoint-baseline.ts:54, telegram/webhook:163 — all pre-existing, all out of scope (B3–B6, #30). **No new alerts.**

### 3. Checks
vitest 6550/6550 (410 files) vs origin/main 6544/6544 (+6 = new tests) · eslint 93 warn / 0 err, same as main, changed files 0 · `tsc --noEmit` clean · `next build` exit 0.

### 4. Diff
`git diff --stat origin/main..HEAD`: 9 files, +139/−13 (+ this file's final edit). Compare: https://github.com/TeraHashAlpha/teraswap/compare/main...fix/codeql-b1-b2

### Concern
- `// codeql[...]` comments don't suppress (recon finding); remaining dismissed alerts re-open if their line moves.
