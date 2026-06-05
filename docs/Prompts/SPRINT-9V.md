# SPRINT-9V — Per-feed staleness thresholds + cbETH composed feed (SECURITY GATE — Auditor required)

## Context (Architect decision 2026-06-04, from 9S FEEDBACK)
The staleness gate uses a GLOBAL threshold (~1h raw path; 25h UI hook). Chainlink heartbeats differ
per feed: mainnet majors ≈ 1h, but Base stablecoin feeds (USDC/USD, DAI/USD — added in 9S) have **24h
heartbeats**. Result: those feeds pass the UI gate but are "stale" on the raw 1h gate → swaps fall to
multi-source comparison (SAFE but suboptimal — the oracle is fine, our threshold is just wrong for that
feed). Decision: staleness must be **per-feed, derived from the feed's official heartbeat**, not one
global number. Also from 9S: cbETH has no USD feed on Base — only **cbETH/ETH** — so cbETH needs a
**composed** price (cbETH/ETH × ETH/USD).

## V1 — Per-feed staleness
- Extend the feed-map entries (both chains) with the feed's official `heartbeat` (verified 3-way
  against the Chainlink directory, like 9S — evidence in the commit).
- Staleness threshold per feed = `heartbeat × 1.5` (margin for late rounds), replacing the global
  value in BOTH the raw gate and the UI hook (keep them consistent — one derivation, two consumers).
- **No loosening:** a feed beyond heartbeat×1.5 still hard-fails staleness; the 9G `startedAt`/round
  guards stay byte-identical; mainnet feeds with 1h heartbeats keep effectively the same threshold
  (1.5h vs 1h — justify or keep mainnet at min(global, heartbeat×1.5) if the Auditor prefers
  conservatism; surface this choice explicitly for the Auditor).
- Unknown/missing heartbeat → fall back to the CURRENT global threshold (fail-conservative).

## V2 — cbETH composed feed (Base)
- Add a `composed` feed type: cbETH/USD = cbETH/ETH × ETH/USD. BOTH legs must pass integrity
  (answer>0, round complete, startedAt, per-feed staleness) or the composition is unavailable (treat
  as no-oracle → existing calm warning + multi-source path). Decimals handled exactly.
- Verify the cbETH/ETH feed address 3-way. Mainnet map untouched.

## Tests (TDD)
- Per-feed: a 24h-heartbeat feed at 2h age → VALID; at 37h → stale (hard). A 1h-heartbeat feed at 2h →
  stale. Unknown heartbeat → global fallback. Raw gate and UI hook agree.
- Composed: both legs fresh → price correct (decimals!); either leg stale/invalid → unavailable (no
  partial pricing). No swap-blocking regression for unfeeded tokens.
- Mainnet behaviour: byte-identical or explicitly justified (the min() choice above) — test-pinned.

## Do NOT
- Do NOT touch deviation/manipulation thresholds, DefiLlama guard, sequencer check, or gate ORDER —
  this changes WHEN a feed counts as stale, nothing else.
- No contract changes. Keys server-only. Mainnet changes test-pinned and minimal.
- Branch `feat/sprint-9v-per-feed-staleness`, atomic SSH-signed commits (V1, V2 separate), CI green,
  append FEEDBACK. **This modifies a safety-gate mechanism (rule #9) → full Auditor review before
  prod** (focus: no loosening beyond heartbeat-justified, composition integrity, fallback
  conservatism). Browser checks are OWNER post-merge steps — do everything automatable and STOP.
