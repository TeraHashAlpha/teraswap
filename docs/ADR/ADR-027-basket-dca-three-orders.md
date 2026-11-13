# ADR-027: Basket DCA on the V3 executor, three orders per basket

- **Status:** Proposed (Architect, 2026-11-13). The three points of §7 are closed; becomes Accepted on the owner's sign-off.
- **Fund-flow:** yes. The keeper change decides which order fills and when. Auditor pass with 0C/0H before any merge of the keeper and API work.
- **Contract change:** none. No deploy, no timelock (phase 1).
- **Follows:** ADR-013 (on-chain floor), ADR-024 (price quorum: skip the cycle, never the order), ADR-026 (infra misses never burn an order).
- **Evidence:** analyst package v2, v3, v3.1, v3.2 (`docs/Reports/basket-dca/` once moved in; engine `src/engine_discrete.py`, 17 engine tests, 271 056 runs with exact chunks). Owner decisions of 2026-11-07.
- **Spec:** `docs/Prompts/SPEC-BASKET-DCA.md`.

## 1. Context

A Basket DCA splits one recurring purchase over three tokens and, each cycle, buys the one that fell most since the previous cycle. The promise to the user is one sentence: **the split you ask for is the split you get.** Nothing is promised about price or return.

The V3 executor (`contracts/order-engine/TeraSwapOrderExecutorV3.sol`, read 2026-11-13 at `7e566fd`) signs one `tokenOut` per order, sells a fixed chunk `amountIn / dcaTotal` per execution (the last takes the exact remainder), allows at most one execution per `dcaInterval`, stops after `dcaTotal` (`DCAComplete`), stops after `expiry`, pulls the money chunk by chunk, sends the output to `order.owner` only, and applies the oracle floor when both tokens are registered in `tokenUsdFeeds`. It has no notion of a variable amount or of a choice between tokens.

The first model of the basket ("A+ continuous") spent a variable amount per cycle. The contract cannot execute that. A new contract would mean a new address, an audit, a 48 h timelock and a migration.

## 2. Decision

**One basket is three ordinary V3 DCA orders, one per leg, signed by the user. The keeper decides, each cycle, which legs execute.** The contract is untouched.

For leg *i* with weight `w_i`, capital `C`, `N` cycles and cadence `T`:

| Signed field | Value |
|---|---|
| `amountIn` | `w_i × C` (the three sum to `C` exactly; rounding dust goes to the last leg) |
| `dcaTotal` | `n_i`: largest-remainder (Hamilton) split of `N` by weight, at least 1, at most `⌊w_i × C ÷ minFill⌋` |
| `dcaInterval` | `T ÷ 2` (at most 2 chunks of one leg per cycle) |
| `expiry` | `start + (N + 3) × T + margin` |

The keeper applies the selection rules of the analyst's discrete engine (spec §4): a calendar of chunks due, the worst-performing eligible leg first (rule 4, on the ADR-024 resolved price), a one-cycle cooldown (rule 5), catch-up for legs behind their own count, the drawdown protection (rule 9, soft mode by default, threshold 25%, soft window the last quarter of the order), and "no price, no purchase for that leg this cycle".

## 3. What is enforced where

| Property | Enforced by | If the keeper is wrong or compromised |
|---|---|---|
| A leg never receives more than `w_i × C` | contract (`amountIn`, `dcaTotal`) | cannot be broken |
| Every purchase is one fixed chunk | contract | cannot be broken |
| Output goes to the owner; router whitelisted | contract | cannot be broken |
| Price floor per purchase (feed-registered tokens) | contract (ADR-013 §1) | cannot be broken |
| Nothing after `expiry`; cancel is terminal | contract | cannot be broken |
| At most one chunk per leg per `T ÷ 2` | contract | cannot be broken |
| Which leg buys in which cycle | **keeper** | worst case: all three legs fill at their maximum rate, so the basket completes in about half the planned time, at floored prices, with the exact split. It degrades into three plain DCAs. |
| Rule 9 and "no price" pauses | **keeper** | same worst case: a paused leg buys anyway, at a floored price |

The split of what is bought is exact by construction. What is not bought by `expiry` never left the wallet.

## 4. Alternatives rejected

- **New contract with variable amounts (V4).** Exact match to the first model, but a new address, audit, timelock and migration for a first version of a product with no users yet. Revisit only if the discrete form proves insufficient in production.
- **One order, off-chain split.** One `tokenOut` per order makes it impossible without custody. Rejected.
- **`dcaInterval = T` (L = 1).** 1 800 of 41 636 modelled positions ended incomplete (up to 27.4% of capital) against 102 (up to 6.5%) with `T ÷ 2`.
- **`n_i = ⌈w_i × N⌉`.** Up to 2 purchases more than `N`; Hamilton gives at most 1.

## 5. Consequences

- The user signs three orders (three signatures, one approval for `C`). Cancelling on-chain is three `cancelOrder` calls; DCA orders do not consume the nonce bitmap, so `invalidateUnorderedNonces` does not cancel them.
- **An old keeper would execute the three legs as three independent DCAs**, each as fast as its `dcaInterval` allows. Basket creation must therefore be impossible until the keeper of that chain has published that it understands baskets (spec §6). Deploy order: keeper first, then API, then UI.
- The API rule "DCA must have 2-365 executions" (`src/app/api/orders/route.ts`) does not fit a leg with `n_i = 1`; basket legs get their own validation path.
- `MAX_EXPIRY_DAYS = 90` caps the weekly cadence at 9 cycles, the 3-day cadence at 26 and the daily at 86.
- A decision journal per cycle becomes part of the product (it feeds the closing report and makes the keeper restart-safe).
- Phase 1 opens only for legs registered in `tokenUsdFeeds` on Base (read on-chain 2026-11-13): WETH, cbBTC, VIRTUAL, COMP, and a stable leg, USDT or DAI; USDC is the token sold. EURC is registered but pegged to the euro and stays out. Every further token (AERO, cbETH, wstETH, LINK, AAVE, USDS) needs a feed registration by the owner's timelock.

## 6. Not measured by the model (to be observed in production)

Gas per order with three orders; the real submission order inside a cycle; the second chunk of a leg half a cycle later (modelled in the same tick); the real quorum price against the feed price used in the model.

## 7. Open points for the owner

1. **Soft mode on short baskets.** Closed 2026-11-13 (analyst v3.2): the soft-mode window is `k_soft = max(1, ceil(N ÷ 4))`, no cap. The fixed 10 of v3.1 never blocked a basket of 10 cycles or fewer (0 of 475 136 positions, 112 796 of which had a leg down 25% or more) and, capped at 10, left long baskets incomplete. With the new rule: 0 incomplete positions in 855 428. Cost to state honestly: in short weekly baskets the largest single-cycle spend rises (41.7% to 66.7% of capital at N = 6).
2. **Stable leg. Owner, 2026-11-13: phase 1 must offer at least one stable leg**, and the interface says which tokens exist today and that more are being added. Closed: USDT and DAI have registered feeds on Base, so the stable leg and the peg band are in phase 1 (spec §4a). v3.2 confirmed the feed parameters (0.3%, 86 400 s) and 0 incomplete positions for WETH + cbBTC + USDT or DAI at every band.
3. **Arbitrum.** Closed 2026-11-13: the executor is not paused, the keeper signer is whitelisted, feeds are registered (read on-chain for WETH, USDC, WBTC, ARB), and the owner confirmed on the host that the Arbitrum keeper process is online. Phase 1 still ships on Base first; Arbitrum opens by itself when its keeper publishes the basket capability, after a check of its registered feeds.
