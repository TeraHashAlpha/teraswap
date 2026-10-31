# fix/ui-v2-dca-audit-fixes — feedback (A70 0C/0H/1M/2L at 9096dc5 → fixed; A70b re-check follows)
Off origin/main `9096dc5`; 4 signed commits; `src/ui/v2/dca/**` + docs/feedback only; mocked tests. **AUDITOR REQUIRED.**
**1. Findings** (all 9 new M-1 / L-1 tests fail on origin/main sources, pass on head)
| id · commit | A70 file:line | change | test (dca-signing.test.tsx) |
|---|---|---|---|
| M-1 `6f05419` | lifecycle:153, sheet:89 | Create/Retry re-run `prepare({ack})` | gate closed since failure / since review |
| | form:285 | fresh tier due → review reopens unticked | tier moved; consent again after failure |
| | form:285 | Retry: fresh draft, no stored ack | Retry re-runs, FRESH config, new floor |
| | DcaCard:455 | prices in the draft key (review only) | price moves → review closes |
| L-1 `2657685` | dca-model:215 | `reopenTierFromError`: unparsed → unpriced | pure · unparsed · random 409 · no loop |
| L-2 `e7ab91a` | dca-model:150 | docs only (see Calls) | — |
**2. Fresh floor** (0.5 WETH→USDC, 300 bps, USDC=1; test "Retry, the price moved"; all `bigint ===`)
first draft @2500 `1212500000` → v2 Retry @2600 `1261000000` = v1 derivation @2600 `1261000000`
= v1 DCAPanel `createOrder` @2600 `1261000000`. Nothing moved → fresh draft `toEqual` the first, `not.toBe`.
**3. 409 matrix** (`order_error` text → v2)
| text | result |
|---|---|
| `Acknowledgement required: this pair is "<tier>". Resubmit…` | consent reopens at `<tier>` |
| starts `Acknowledgement required`, unparsed | consent reopens at **unpriced**, unticked, no Retry |
| `Order already exists (409)`, rejection, lowercase, `''`, null | failure + Retry |
No loop: after an unparsed ack-409 the next `createOrder` has a NEW unpriced ack; plain-failure Retry waits for a re-tick.
**4. Verify** — suite **395 files / 6281 tests, 0 failed** (main 395 / 6271) · `eslint .` 93 = 93 · tsc 0 · build 0 ×2
· rpc-budget + isolation + Footer run alone: 4 files / 32 tests green · no file outside `src/ui/v2/` + feedback, no deps.
**v1 proof** (base `9096dc5` built in its own worktree vs head, same env): route tables identical · client chunks:
251 common, byte-compared, **0 differ**; the 1 that differs holds the v2 DCA code and is used only by `/v2`, `/v2/[tab]`
· server chunks 356 + 710 same names (content-hashed); only html/rsc that embed the buildId differ.
`git diff --stat origin/main...HEAD`: 11 files, +360 −73.
Compare: https://github.com/TeraHashAlpha/teraswap/compare/main...fix/ui-v2-dca-audit-fixes
**Calls to confirm**
- **Price key** split: a tick closes the *review* (old floor), not a *frozen* order (feeds poll 30 s). A test pins it.
- **L-2 = docs option.** v1 does use `<ConnectButton />` (`DCAPanel.tsx:1503`) but has no DCA wrong-network CTA; v2 keeps
  `useConnectModal` + frame words, like v2 Swap. `ConnectButton` would lose `Switch to {chain}` and the review's switch.
- `prepare({ack})` skips the server tier call (v1 parity); on-chain Create passes `startSound:false`; on-chain Retry goes
  straight to `createOrder(fresh)`, consent tiers return to the review. Gates read the render-time closure, as v1 does.
- A stray interactive `git checkout -p` was stopped unanswered; nothing was discarded.
