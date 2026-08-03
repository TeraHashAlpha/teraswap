# CHORE-DEFILLAMA-ADAPTER — list TeraSwap on DefiLlama (volume + fees, aggregator)

> **Context:** TeraSwap is a **DEX aggregator** — it holds **~no TVL** (funds route through other DEXes; DCA pulls
> per-chunk from the user's wallet). So the listing is **volume + fees**, via the **`DefiLlama/dimension-adapters`**
> repo (NOT the `DefiLlama-Adapters` TVL repo). **Read-only on the TeraSwap contracts; the adapter is for the DefiLlama
> fork** (no TeraSwap contract change). SSH-signed. Not marketing (a dev integration artifact) — OK in-repo under
> `integrations/`.

## Requirements
1. **Confirm (read-only) the FeeCollector fee/swap event structure** on **mainnet FeeCollector V2 `0x47f2…7459`** +
   **Base FeeCollector `0xeFC3…f130`** — the event(s) emitted per fee-collected swap, with the swap amount(s) + the
   0.1% fee. (Volume = the swap notional; fee = 0.1% = protocol revenue.)
2. **Write a dimension-adapter** in DefiLlama's format (category **Dexs → Aggregator**) computing, per chain
   (`ethereum` + `base`): **daily volume** (sum of swap notional in USD via the event amounts + DefiLlama prices),
   **daily fees** (the 0.1%), **daily revenue** (= fees, the protocol keeps them). Use the standard dimension-adapters
   helpers (the `getLogs` / block framework, `FetchOptions`, `startTimestamp`).
3. **Deliver the adapter file** at `integrations/defillama/teraswap.js` (in this repo, for the record) **plus a short
   PR note**: how to add it to a fork of `DefiLlama/dimension-adapters` (the target path, e.g. `dexs/teraswap/index.js`)
   + a one-paragraph methodology description for the DefiLlama PR (per their submission process: fork → add adapter →
   PR with a brief explanation).

## Do NOT
- No TeraSwap contract / on-chain change (read-only). Don't put it in the TVL repo. Don't overstate TVL (it's ~0).

## Files affected (read ONLY these)
- Read-only: the FeeCollector ABI/events (mainnet + Base). Write: `integrations/defillama/teraswap.js` + a PR note.
  Don't scan the rest of the repo.

## Expected output
- Branch `chore/defillama-adapter` off `origin/main`; SSH-signed; **push + report "CI running" — do NOT poll CI**. The
  adapter computes volume+fees+revenue for ethereum+base from the FeeCollector events. **FEEDBACK ≤ 1 screen** (the
  event signature used + the exact DefiLlama target path + the methodology paragraph).

## Quality criteria
The adapter follows the dimension-adapters aggregator format, computes daily volume + fees + revenue on both chains
from real FeeCollector events, and comes with clear PR-to-DefiLlama instructions; no TVL claim; no contract change.

---

### `/goal` paste for the Code Agent (≤4000)
```
CONTROL: model Sonnet · effort medium · NO CI-poll (push + report, don't watch) ·
read ONLY the FeeCollector ABI/events · FEEDBACK <= 1 screen.

CHORE-DEFILLAMA-ADAPTER per docs/Prompts/CHORE-DEFILLAMA-ADAPTER.md. Branch
chore/defillama-adapter off origin/main, SSH-signed. Read-only on the TeraSwap
contracts; the adapter is for the DefiLlama fork (no TeraSwap contract change).

Context: TeraSwap is a DEX AGGREGATOR — ~no TVL (routes through other DEXes; DCA
pulls per-chunk). List on DefiLlama as VOLUME + FEES via DefiLlama/dimension-adapters
(NOT the TVL repo).

Do:
1. Confirm (read-only) the FeeCollector fee/swap event structure on mainnet
   FeeCollector V2 0x47f2...7459 + Base FeeCollector 0xeFC3...f130 — the event(s)
   emitted per fee-collected swap with the swap amount(s) + the 0.1% fee.
2. Write a dimension-adapter (DefiLlama format, category Dexs->Aggregator)
   computing per chain (ethereum + base): daily volume (swap notional USD via event
   amounts + DefiLlama prices), daily fees (0.1%), daily revenue (= fees). Use the
   standard dimension-adapters helpers (getLogs/block framework, FetchOptions).
3. Deliver integrations/defillama/teraswap.js (in-repo for the record) + a PR note:
   the DefiLlama target path (e.g. dexs/teraswap/index.js) + a one-paragraph
   methodology for the DefiLlama/dimension-adapters PR (fork -> add adapter -> PR).

Do NOT: TeraSwap contract/on-chain change; TVL repo; overstate TVL (~0).

Files: read-only the FeeCollector ABI/events (mainnet+Base); write
integrations/defillama/teraswap.js + PR note. FEEDBACK <= 1 screen: event signature
used + exact DefiLlama target path + the methodology paragraph.
```
