# fix/ui-v2-dca-audit-fixes — feedback (A70 0C/0H/1M/2L at 9096dc5 → fixed; Auditor re-check A70b follows)
Off origin/main `9096dc5`. 3 signed commits, only `src/ui/v2/dca/**` + docs/feedback. Mocked wallet/RPC/API, nothing signed. **AUDITOR REQUIRED.**
**1. Findings** (all `src/ui/v2/dca/`; "main" = the 7 M-1 / 2 L-1 tests run against origin/main's sources: all 9 fail there)
| id · commit | file:line (A70) | change | test (dca-signing.test.tsx) | fails on main |
|---|---|---|---|---|
| M-1 `6f05419` | lifecycle:153, sheet:89, form:285 | Create/Retry call `prepare({ack})` again | gate closed since failure (depeg) | yes |
| | | gate blocks → nothing to engine, review closes | gate closed since review (oracle) | yes |
| | | fresh tier due → review reopens unticked | tier moved on-chain→unpriced | yes |
| | | Retry = fresh prepare, no stored draft/ack | Retry re-runs, FRESH config; consent again | yes |
| | DcaCard:455 | prices in the draft key (review only) | price moves → review closes | yes |
| L-1 `2657685` | dca-model:215 | `reopenTierFromError`: unparsed ack → unpriced | pure · unparsed → unpriced · random 409 | yes |
| L-2 `e7ab91a` | dca-model:150 | docs only, below | — | n/a |
**2. Fresh-draft equality** (0.5 WETH→USDC, 300 bps, USDC=1; test "Retry, the price moved", all `bigint ===`)
`first draft @2500 = 1212500000` · `v2 Retry @2600 = 1261000000` · `v1 deriveSigningMinAmountOut @2600 = 1261000000`
· `v1 DCAPanel createOrder @2600 = 1261000000` (`priceInUsd` 2600 travels with it). Nothing moved → fresh draft `toEqual`, `not.toBe`.
**3. 409 matrix** (server text → v2)
| `order_error` text | result |
|---|---|
| `Acknowledgement required: this pair is "offchain-price"\|"unpriced". Resubmit…` | consent reopens at that tier (as B6b) |
| starts `Acknowledgement required` but unparsed (cut / reworded / unknown tier / bare) | consent reopens at **unpriced**, unticked, no Retry |
| `Order already exists (409)`, wallet rejection, lowercase / mid-sentence "acknowledgement required", `''`, null | plain failure + Retry |
Loop check: after an unparsed ack-409 the next `createOrder` carries a NEW unpriced ack (`not.toBe` the refused one); after a plain failure
Retry sends nothing until the box is ticked again (`seq` stays `[createOrder, confirmOrder]`).
**4. Verify** — suite **395 files / 6281 tests, 0 failed** (origin/main 395 / 6271: +10 new) · `eslint .` **93 = 93** · tsc 0 ·
`next build` 0 · rpc-budget guards + `isolation.test` green (in the suite) · **v1 module-identical:** `git diff --name-only
origin/main...HEAD` outside `src/ui/v2/` + `docs/feedback/` = ∅; package files 0 lines · no deps, secrets, force-push.
`git diff --stat origin/main...HEAD`: 11 files, +330 −73 before this file's last edit (src 8, feedback docs 3). Compare:
https://github.com/TeraHashAlpha/teraswap/compare/main...fix/ui-v2-dca-audit-fixes
**Judgement calls (owner / A70b to confirm)**
- **Price key:** prices are keyed separately — a tick closes the **review** (it prints the old floor) but does NOT drop a frozen order
  (feeds poll every 30 s; the sign sheet prints the exact struct). Test pins it. Literal single key would drop the sign sheet on a tick.
- **L-2 chose the docs option.** v1 *does* use RainbowKit `<ConnectButton />` (`DCAPanel.tsx:1503`, `Connect Wallet`) but has no DCA
  wrong-network CTA; v2 uses `useConnectModal` + frame words exactly as the accepted v2 Swap. Swapping to `ConnectButton` would lose
  `Switch to {chain}` and the review's switch button — flip is cheap if you want parity over the frame.
- `prepare({ack})` skips the server tier call (v1 `handleCreate(ack)`); on-chain-tier Create passes `startSound:false` (v1 starts nothing).
- Retry on the on-chain tier goes straight to `createOrder(fresh)` (v1 "Start again"); consent tiers return to the review.
- Awaited gates in `prepare()` read the render-time closure, as v1's `handleCreate` does. I ran a stray interactive `git checkout -p`
  once and stopped it unanswered: nothing was discarded (worktree verified).
