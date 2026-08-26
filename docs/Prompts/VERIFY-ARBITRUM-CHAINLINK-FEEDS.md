# VERIFY-ARBITRUM-CHAINLINK-FEEDS

**Date:** 2026-08-26 · **Branch:** `fix/arbitrum-feed-verification` · **Base commit:** `9f11618`
**Scope:** re-verification of the five Chainlink price feeds in `CHAINLINK_FEEDS_BY_CHAIN[42161]`
(`src/lib/chains/chainlink-feeds.ts`) + one comment correction. **No address, threshold, feed-map
entry, or gate logic was changed.**

---

## 1. Why re-verify

The 42161 feed block carried this standing claim:

> `CONFIG-ONLY / dark: unreachable while contracts.feeCollector is null (isChainActive(42161) === false).`

That claim is **false in Production**, and it was never a property of the file that asserted it:

| Fact | Source |
| --- | --- |
| `isChainActive(chainId)` ⇔ `getChainConfig(chainId).contracts.feeCollector !== null` | `src/lib/chains/activation.ts:16-22` |
| Arbitrum's `feeCollector` is env-driven: `(process.env.NEXT_PUBLIC_ARBITRUM_FEE_COLLECTOR \|\| null)` | `src/lib/chains/registry.ts:124` |
| `NEXT_PUBLIC_ARBITRUM_FEE_COLLECTOR` is set in Vercel Production (added 2026-07-20); Arbitrum is offered in the chain selector and swaps execute | deployment fact, supplied by the owner |

So activation is a property of the **environment**, not of the config. The block is **live** wherever
the variable is set and **dark** only where it is unset — local checkouts and preview deployments.
That is exactly the environment in which a developer reads the comment, which is how a conditional
state got written down as a permanent one and then outlived the deploy that falsified it.

These five feeds gate real swaps today. They had been verified **once**, under the belief that they
were unreachable. The precedent that makes re-verification non-optional: `AUDIT-ARBITRUM-46-47`
found **all five** then-configured feed addresses had **zero on-chain bytecode** — hand-transcribed
hex drift, each sharing a prefix with the genuine feed and diverging after it.

## 2. Method

Re-runnable: `node scripts/verify-arbitrum-chainlink-feeds.mjs` (added by this change).

- **No hex is ever retyped.** All five addresses, the Base ETH/USD anchor, the claimed pair for each
  feed (`FEED_EXPECTATIONS`, ADR-018) and each heartbeat (`FEED_HEARTBEAT_SEC`) are **parsed out of
  `chainlink-feeds.ts` programmatically**. The parser asserts it found exactly 5 feeds and that the
  declared pairs are exactly the five required, so a parser that drifts from the source fails loudly
  instead of silently verifying the wrong thing.
- **Every comparison is computed and lower-cased, never eyeballed** — a prefix-sharing address is
  indistinguishable from the real one at a glance, which is the whole failure mode.
- **Two independent public RPCs per chain, no API keys, read-only.** `eth_chainId` is asserted on
  every endpoint first (`0xa4b1` / `0x2105`): a misconfigured or hostile RPC could otherwise lie
  about which chain it is serving.
  - Arbitrum One: `https://arb1.arbitrum.io/rpc`, `https://arbitrum-one-rpc.publicnode.com`
  - Base (anchor only): `https://mainnet.base.org`, `https://base-rpc.publicnode.com`
- Per feed: `eth_getCode`, `description()`, `decimals()`, `latestRoundData()`, `aggregator()`.

## 3. Readings — all five, both RPCs

Read `2026-08-26T08:00:55Z`. **`eth_getCode` non-empty on all five** — the check the earlier incident
failed; every other check is vacuous until it passes.

| Pair (on-chain `description()`) | Feed proxy | dec | Answer (scaled) | Round age | Heartbeat | `aggregator()` | Code | Both RPCs agree |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `ETH / USD` | `0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612` | 8 | **$2,461.85338878** | 331 s | 1755 s | `0xd827123d014578c965f6c9d87a641ec05faa5501` | 9571 B | **YES** |
| `USDC / USD` | `0x50834F3163758fcC1Df9973b6e91f0F0F0434aD3` | 8 | **$0.99990871** | 205 s | 255 s | `0x085a38e33a14b1e3078b0614380b4469aea4e0f2` | 9571 B | **YES** |
| `DAI / USD` | `0xc5C8E77B397E531B8EC06BFb0048328B30E9eCfB` | 8 | **$0.99958476** | 40 393 s | 86 400 s | `0xe8df13fa9d99ae5ac929a5250fda3b463c463622` | 9571 B | **YES** |
| `USDT / USD` | `0x3f3f5dF88dC9F13eac63DF89EC16ef6e7E25DdE7` | 8 | **$0.99980505** | 126 s | 255 s | `0x3cbdf88cd62a5532db88faba1a3b2043302bf655` | 9571 B | **YES** |
| `WBTC / USD` | `0xd0C7101eACbB49F3deCcCc166d238410D6D46d57` | 8 | **$78,901.42200612** | 318 s | 86 400 s | `0xb19d0b75191894de745b61342d728e5fc6ead1ba` | 9571 B | **YES** |

“Both RPCs agree” = identical `description()`, `decimals()`, `aggregator()`, and bytecode length;
all five also returned the **identical `roundId` and answer** on both endpoints.

Round IDs (phase-encoded): ETH `36893488147419208067` · USDC `36893488147419137086` ·
DAI `36893488147419103434` · USDT `36893488147419137090` · WBTC `36893488147419147861`.

Independent anchor — Base ETH/USD, parsed from the same file's `8453` block and read on two Base
RPCs: `0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70`, `ETH / USD`, 8 dp, **$2,461.07557432**, age 36 s,
both RPCs agree.

## 4. Sanity checks

### 4.1 IDENTITY — **PASS**

Each `description()` equals the pair the config itself declares in `FEED_EXPECTATIONS` (ADR-018),
compared as computed strings:

`ETH / USD` ✓ · `USDC / USD` ✓ · `DAI / USD` ✓ · `USDT / USD` ✓ · `WBTC / USD` ✓ — and `decimals()`
is 8 on all five, matching each declared expectation. No mismatch, so no hard stop.

Worth stating explicitly: `WBTC / USD` self-reports as a **dedicated WBTC feed**, not the `BTC / USD`
index feed. That substitution is the exact defect ADR-018 was written for (it happened on mainnet and
passed every guard, because nothing had ever asked the feed what it was).

### 4.2 MAGNITUDE — **PASS**

| Check | Required | Measured | Verdict |
| --- | --- | --- | --- |
| `USDC / USD` vs $1.00 | within 2 % | $0.99990871 → **0.0091 %** off | PASS |
| `DAI / USD` vs $1.00 | within 2 % | $0.99958476 → **0.0415 %** off | PASS |
| `USDT / USD` vs $1.00 | within 2 % | $0.99980505 → **0.0195 %** off | PASS |
| `WBTC / USD` vs `ETH / USD` | ≥ 5× | 78 901.42 / 2 461.85 = **32.05×** | PASS |
| Arbitrum `ETH / USD` vs Base `ETH / USD` | within 20 % | 2 461.853 vs 2 461.076 = **0.032 %** | PASS |

The cross-chain ETH check is the strongest of the five: two different chains, two different feed
addresses, four different RPC providers, agreeing to three decimal places. A denomination error — the
failure that passes identity and fails magnitude — would show here as an order-of-magnitude gap.

### 4.3 FRESHNESS — reported, not judged

Ceiling is the codebase's own `getFeedStalenessSec` = heartbeat × 1.5.

| Pair | Age | Heartbeat | Ceiling (×1.5) | Age / heartbeat | Within ceiling |
| --- | --- | --- | --- | --- | --- |
| `ETH / USD` | 331 s | 1755 s | 2633 s | 19 % | yes |
| `USDC / USD` | 205 s | 255 s | 383 s | **80 %** | yes |
| `DAI / USD` | 40 393 s (11 h 13 m) | 86 400 s | 129 600 s | 47 % | yes |
| `USDT / USD` | 126 s | 255 s | 383 s | 49 % | yes |
| `WBTC / USD` | 318 s | 86 400 s | 129 600 s | 0.4 % | yes |

All five were within the ceiling at read time. Two observations, offered without a recommendation:

- **`USDC / USD` was at 80 % of its heartbeat** when sampled. With a 255 s heartbeat the ×1.5 ceiling
  is 383 s, so the usable window past a missed round is ~2 minutes. This is a single sample, not a
  trend — but the tightest-heartbeat feeds are the ones where a normal late round is closest to
  reading as stale.
- **`DAI / USD` was 11 h 13 m old.** Expected for an 86 400 s deviation-threshold feed with a quiet
  peg (it only publishes when the price moves past the threshold), and comfortably inside the
  ceiling. Noted only because it is two orders of magnitude older than the other four.

## 5. Comment correction (the only source change)

`src/lib/chains/chainlink-feeds.ts` — the `CONFIG-ONLY / dark` sentence is replaced with a statement
of the actual condition (LIVE when `NEXT_PUBLIC_ARBITRUM_FEE_COLLECTOR` is set, which it is in
Production; dark only where unset), plus why the stale claim survived and how to re-run the
verification. **Comment lines only** — verified mechanically: every `+`/`-` line in the diff for that
file begins with `//`.

## 6. Task 4 — does this codebase consult an L2 Sequencer Uptime Feed?

**ANSWER: YES — found, on three layers. One path does not consult it (§6.4).**

Chainlink's L2 guidance is to check the sequencer before trusting a price: while the sequencer is
down, feeds freeze at their last answer, and on resume there is a grace period during which they are
still catching up. Both L2s have a feed configured — Base
`0xBCF85224fc0756B9Fa45aA7892530B47e10b6433` (`registry.ts:89`), Arbitrum
`0xFdB631F5EE196F0ed6FAa767959853A9F217697D` (`registry.ts:144`).

### 6.1 The shared implementation — `src/lib/chains/sequencer-check.ts`

```ts
export const SEQUENCER_GRACE_PERIOD_SEC = 3600            // :17

export async function isSequencerUp(chainId: number, publicClient: SequencerClient): Promise<boolean> {
  let feed: `0x${string}` | undefined
  try { feed = getChainConfig(chainId).sequencerUptimeFeed } catch { return true }
  if (!feed) return true                                   // L1 (mainnet) — no sequencer to check
  ...
      const isUp = answer === 0n                           // :116  0 = up, 1 = down
      const sinceStartedSec = Math.floor(Date.now() / 1000) - Number(startedAt)
      up = isUp && sinceStartedSec >= SEQUENCER_GRACE_PERIOD_SEC
    } catch {
      up = false                                           // :120  fail safe
    }
```

Correct posture on all three axes: `answer === 0` is up, the 1 h grace period is enforced, and an RPC
error **fails closed** rather than assuming up.

### 6.2 It gates the Chainlink price read itself — `src/lib/chainlink.ts:532-541`

```ts
  // [P218] L2 sequencer-uptime gate — never price on a down/recovering
  // sequencer. Mainnet (DEFAULT_CHAIN_ID) has no sequencer feed and skips this,
  // so the mainnet path is unchanged. Done ONCE up front; both composed legs share the chain.
  if (chainId !== DEFAULT_CHAIN_ID) {
    const seqUp = await isSequencerUp(chainId, getPublicClientForChain(chainId))
    if (!seqUp) {
      console.warn(`[TeraSwap] Sequencer down or in grace period on chain ${chainId}`)
      return null
    }
  }
```

This is inside `fetchChainlinkPriceRaw`, i.e. before any feed leg is read — so the server-side price
used by the oracle validation returns `null` (unpriceable) rather than a frozen answer.

### 6.3 Also gated: quote, swap, monitoring, and settlement

| Layer | Call site |
| --- | --- |
| Quote path | `src/lib/api.ts:119` → throws `SequencerDownError` → `/api/quote` maps to `503 { sequencerDown: true }` |
| Swap route | `src/app/api/swap/route.ts:128` |
| Price monitor | `src/lib/price-monitor.ts:71` |
| **On-chain settlement** | `contracts/order-engine/TeraSwapOrderExecutorV3.sol:_sequencerUp()` (ADR-013 N1) — `answer != 0` → false, `startedAt == 0` → false, `block.timestamp - startedAt <= SEQUENCER_GRACE_PERIOD` → false. `address(0)` feed (mainnet) ⇒ always up. |

The keeper therefore cannot settle an order on a down or recovering sequencer even if every
off-chain layer were bypassed.

### 6.4 The one gap — the browser hook is **not** gated

`src/hooks/useChainlinkPrice.ts` contains **no reference to the sequencer** (`grep -n
"sequencer\|Sequencer"` → no matches). It resolves feeds with `resolveFeed` and reads them directly
client-side via wagmi `useReadContract` — it does not go through `fetchChainlinkPriceRaw`, so it
never reaches the §6.2 gate.

Consequence, stated as scope rather than as a fix: during an L2 sequencer outage or its grace window,
the **displayed** Chainlink price in the browser — and anything derived from it in the client, such
as the DCA signing-floor preview — would use a frozen answer, while the server-side quote/swap path
and the on-chain executor both correctly refuse. The staleness guard (`getFeedStalenessSec`,
heartbeat × 1.5) is a partial mitigation only: a frozen feed eventually trips it, but the coverage is
incidental and very uneven across these five. An outage trips `ETH / USD` after 2633 s (~44 min) —
but `DAI / USD` and `WBTC / USD`, at an 86 400 s heartbeat, not until **129 600 s (36 h)**, so a
multi-hour outage would leave those two reading "fresh" in the browser throughout. And no staleness
ceiling covers the 1 h post-recovery grace window at any heartbeat, because a lagging round published
after recovery is genuinely fresh.

**Not implemented here, by instruction.** Flagged for a separate decision.

---

## Appendix — reproduction

```
node scripts/verify-arbitrum-chainlink-feeds.mjs
```

Read-only, public RPCs, no keys, no `.env`, no writes. Exits 1 if any feed has no code, fails
identity, fails a magnitude check, or the two RPCs disagree. Not wired into CI (public-RPC
flakiness) — same manual/audit-time role as `scripts/verify-arbitrum-addresses.mjs` and
`scripts/verify-base-cbeth-feeds.mjs`. The CI-safe static counterpart that pins these addresses
against silent drift is `src/lib/chains/arbitrum-manifest.test.ts`.
