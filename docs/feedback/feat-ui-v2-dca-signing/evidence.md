# B6b evidence detail (referenced from `../feat-ui-v2-dca-signing.md`)

## 2. Arg-equality matrix (`dca-signing.test.tsx` 15 · `dca-cancel.test.tsx` 7)
v1's DCAPanel and the v2 card run on ONE fake engine (`dca-engine-fake.tsx`, v1's observable contract); each is driven the way its user drives it; the recorded call sequences must be `toEqual`.

| scenario | engine calls (v1 = v2) | also equal / asserted |
|---|---|---|
| standard (on-chain feed) | `createOrder(cfg)` · `confirmOrder()` | cfg deep-equal, `useOrderApproval` args `[tokenIn, amountIn, chainId, true]`, sounds, toasts, 1 POST |
| offchain-price + consent | same | `floorAck.tier = 'offchain-price'` (acknowledgedAt normalised) |
| unpriced + consent | same | `floorAck.tier = 'unpriced'` |
| approval first | `createOrder` · `approve()`×1 · `confirmOrder()` | `Approve WETH` → `Confirm & Sign Order`, note text switches |
| consent not ticked | — | Create disabled, no call, no sheet |
| 409 (server `unpriced`) | `createOrder` · `confirmOrder` · `createOrder` · `confirmOrder` | consent reopens unticked and focused; `#2 = #1 + floorAck.unpriced`; POSTs `[undefined, 'unpriced']`; v1's toast raised |
| wallet rejects | `createOrder` · `confirmOrder` | **0 POST**, `Signature rejected in wallet.` verbatim, stop + cancel sounds, retry re-sends the **same object**, loop restarts |
| API error | `confirmOrder`×1 | repeated press / Esc / Cancel / backdrop while signing change nothing; server text verbatim |
| wrong network | — | `Switch to Base` = `switchChain({ chainId })`, no call |
| cancel one | `cancelOrder('a1')` · `confirmCancel()` | same sound + toast as v1; Keep / Esc → `clearPendingCancel`, never `confirmCancel` |
| Cancel All | `cancelAllOrders()` · `confirmCancel()` | plan sheet = v1's arithmetic (`2 total (2 cancelOrder calls — DCA orders)`) |
| list | — | no status flip before the event, cancelled row moves to History after it, `fetch` never called by v2 |

## 4. Sound + toast parity (v1 = v2 unless marked; `dca-signing.test`, `dca-gate-sounds.test`)
| moment | sounds | toast |
|---|---|---|
| form press, on-chain tier | playTouchMP3 · startWaitingSound (runs on into the EIP-712 review — B6a's one difference, closed) | — |
| form press, weaker tier → consent → Create | touch · start · stop (consent) · start (Create = DCAPanel.tsx:825) | — |
| Approve / Confirm & Sign press | — (v1's modal plays nothing) | — |
| order_created | stopWaitingSound · playSwapConfirmMP3 | `DCA order placed` |
| order_error (rejection / API / 409) | stopWaitingSound · playCancelOrderMP3 | `DCA order failed` + text, or `DCA temporarily paused` |
| order_cancelled | playCancelOrderMP3 | `DCA order cancelled` |
| review Cancel / Esc / draft change / sign-sheet Cancel | **v2 stopWaitingSound** (v1 leaves the loop running) | — |

## 5. a11y + edge (`dca-a11y-edge.test.tsx` 20)
One dialog from frozen through signing to the outcome (the busy button is `aria-disabled`, never `disabled`, so it keeps focus; the outcome focuses View positions / the retry) · Tab cycles inside incl. the busy button · `aria-live="polite"` timeline with `aria-current="step"` · Esc / Cancel / backdrop dead while creating or signing, live on the idle review (focus returns to the CTA), the frozen review (= `clearPendingOrder`) and both outcomes · a draft change (amount, buys, interval) closes the review and drops a frozen order; a consent does not carry to a new draft · two presses reach the engine once (card and hook) · a silently abandoned attempt disarms (a later poll event is not read as its outcome) · a pre-press event is ignored · reduced-motion scan (dca.css / modals.css declare no animation; swap.css's is guarded; no `animate-` / `transition-` in the three sheets).
