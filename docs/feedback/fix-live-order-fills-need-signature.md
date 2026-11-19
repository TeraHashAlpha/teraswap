# Feedback: fix/live-order-fills-need-signature (A87b R2-1, owner decision 2026-11-18)

Privacy. **Draft PR, Auditor required** (the owner opens it). Rig: `e2e/live-order-fills/` (local only, no CI).

## 1. Callers of `GET /api/orders/:id/executions` (browser, v1 + v2: 4 fetch sites, all now `fetchOrderExecutions`, `lib/order-engine/executions-client.ts`)
| Site | Used by | Sent before | Sends now |
|---|---|---|---|
| `hooks/useOrderExecutions.ts:61` | v1 `DCAPositionStats:76`, `MissionControlCard:61`; v2 `OrdersTab:108`, `DcaOrdersList:117`, `PositionSummary:31` | bare `fetch(url)` | cached read headers; 401 → list's `ensureOrdersReadAuth` → retry once; still 401 keeps rows on screen |
| `components/ExecutionTimeline.tsx:163` | v1 `OrderDashboard:446` | bare | same; 401 hides the block as any error did |
| `components/dca/SettlementReceiptModal.tsx:148` | v1 receipts (filled/cancelled only) | bare | same (server ignores headers for finished orders) |
| `ui/v2/dca/ReceiptSheet.tsx:127` | v2 receipts (same) | bare | same |
No caller outside `src/` is served (`contracts/order-engine/api/orders.ts:260` is marked SUPERSEDED, imported nowhere; untouched).

## 2. Status matrix (wallet's own order; cell = HTTP status; "before" = origin/main, all 200)
| Status | none | own valid | another wallet's (2 ways) | expired |
|---|---|---|---|---|
| active, executing, partially_filled*, made_up* | 401 | **200 fills** | 401 | 401 |
| executed, cancelled, expired, failed | 200 | 200 | 200 | 200 |
\*default-deny, not in the terminal set. Wrong wallet 403, unknown id 403, missing wallet 400: unchanged. 401 body == by-id's (tested equal). Fills table is not read on a 401 (asserted).

## 3. Browser (real Chromium, real CSP, production build, REAL routes on a PostgREST shim, wallet stub signs with a real key)
Steps: connect → Orders tab (v1 click / v2 `/orders`) → expand active DCA (2/5 fills) → "Completed" → expand finished DCA (3/3).
| Tree | UI | Wallet prompts | Console errors | Active-order calls | Fills shown |
|---|---|---|---|---|---|
| origin/main | v1 / v2 | 1 / 1 (`OrdersReadAccess`) | 1 / 1 (list's first unsigned 401, A87 S-6) | no headers, 200 | 2 and 3 / 2 and 3 |
| this branch | v1 / v2 | 1 / 1 | 1 / 1 | read headers, 200 | 2 and 3 / 2 and 3 |
Prompt you could see that you do not today: none in the normal flow. Edge: with `sessionStorage` blocked nothing caches, so each 401 re-prompts (the order list already does the same); a refusal is remembered session-wide and shared with the list.

## 4. Tests, seeds, mutation proof
- `orders-executions-live-auth.test.ts`: 8 statuses x 5 auth states on the real handlers + by-id 401 parity + unchanged answers. Property (seeds 1, 7, 42, 1117, 20261118 x 120 cases, non-vacuous counters). `executions-client.test.ts` 10, hook +2.
- CHANGED EXPECTATION x2: `orders-privacy-clause.test.ts` LIVE executions without signature: 200 WITH FILL -> 401 READ_AUTH_REQUIRED, NO FILL (plus a with-signature 200 case); `orders-read-no-signature.test.ts` executions for active/executing without signature: 200 -> 401 (200 with it).
- Mutants (scratch copy, all killed): status check removed 41 fail; inverted 69; second shorter terminal list 26; live allow-list instead of default-deny 21; gate after the fills read 16; client header dropped 4 unit + browser v1 AND v2 ("active DCA fills on the page: expected 2, got 0"); no retry after signing 3. Baseline and restored: 155/155.

## 5. Verify
`scripts/agent-verify.sh --codeql`, ONE run, load1 5.6, on `c75ddc96` (the head adds only this file's last edit): **PASS** suite 11444/0 (536 files), lint +0 err/+0 warn (7=7), tsc 0, build ok, v1v2-parity 123/0, rpc-budget 36/0, CodeQL 13=13 (0 new). `gen-claude-state --check`: current. gitleaks on the changed paths: 0 mine; 1 pre-existing (`useOrderEngine.ts:178` `LEGACY_OBFUSCATION_KEY`, also on origin/main), not suppressed.
Diff vs origin/main: 19 files, +1134/-18 (route +33, client helper +32, tests +547, rig +419). Compare: https://github.com/TeraHashAlpha/teraswap/compare/main...fix/live-order-fills-need-signature
**NOT verified:** keeper suite (`--keeper` calls brew; not run); a real wallet extension or WalletConnect; real Supabase/PostgREST (a shim over the vitest fake; RLS untouched); CI and a Vercel preview; the browser rig is local-only. Build note: Tailwind emitted a short CSS bundle (34 KB, unstyled page) on 2 of 4 builds on this machine, a clean rebuild gave the full 66 128 B; every browser result above was run only on a full-CSS build.

## Premise check and the one question
Premise TRUE, checked before any edit: the route selected `wallet` only (no status test, no signature check) and origin/main's `orders-privacy-clause.test.ts:124` pinned live fills as "RETURNED (200)"; after the change exactly the 4 live-order cases flipped, nothing else. So nothing to ask on the premise. Asked ONCE anyway, on three readings; owner: keep all (e2e rig in repo, signer registry in `read-auth.ts`, headers sent on finished orders too).
