# TeraSwap — SPRINT-9G Audit Brief (Auditor agent prompt)

**Scope:** Make the safety/oracle/validation gates chain-aware now that **Base is LIVE**. These are
security/fund-flow gates → review for correctness, fail-closed behaviour, and **mainnet
byte-identical** preservation. Classify every finding **C / H / M / L**. **0C / 0H = APPROVED.**
Produce remediation prompts for the Code Agent — **do NOT edit code directly.**

**Branch:** `feat/sprint-9g-chain-aware-gates` (not merged, not deployed).
**Commits under review (signed):** G1 `3844cee` · G2 `2b11284` · G3 `d5c453f` · G4 `ddc2977` ·
G5 `eb6fc5d` · G6 `a50360b` · G7 `e78753b` · G8 `9ab95e3` · docs `8d417e6`.
**Baseline:** main @ #119 (Base live). Tests 1357 → **1391** (+34), typecheck 0, lint 0.
**Specs:** `docs/Prompts/SPRINT-9G.md` + `Audits/FULL-AUDIT-2026-06-02.md`.
**Pre-checks (CLAUDE.md):** no open C/H elsewhere in this file; every commit GPG/SSH-signed; CI green.

---

## Invariant to verify on EVERY gate
Mainnet (chainId 1) behaviour is **byte-identical** to pre-9G. Each helper must resolve chainId 1 to
today's path (`getPrivateClient()`/`/api/rpc`, DefiLlama `ethereum`, etc.). Prove via tests/diff.

## Per-gate questions

**G1 — Chainlink + L2 sequencer chain-aware [HIGH · `3844cee`]** (`chainlink.ts`, `price-monitor.ts`)
1. Do `isSequencerUp` + feed `readContract` now use `getPublicClientForChain(chainId)` /
   `getRpcUrlForChain(chainId)` for chainId≠1, so Base reads the **Base** sequencer/feed over the
   **Base** RPC (not mainnet addresses)?
2. chainId 1 still uses `getPrivateClient()` → byte-identical? Fail-closed on revert preserved?
3. Does the SL/TP/DCA price-monitor path now validate against the correct chain's feed?

**G2 — DefiLlama >$10k guard chain-aware [HIGH · `2b11284`]** (`defillama.ts`, `api/swap`)
1. Is the chain slug from `getChainConfig(chainId).slug` threaded into BOTH `fetchDefiLlamaPrice`
   calls (estimatedValueUsd + `validateSwapPrice`)? Default `ethereum` for chainId 1?
2. On Base: does a >$10k swap now actually validate Base prices (not always-block), and is the
   sub-$10k **fail-open** gap closed? Confirm the gate is not bypassable.

**G3 — Post-execution validator chain-aware [HIGH · `d5c453f`]** (`post-execution-validator.ts`)
1. Is `chainId` threaded from the caller route and the client built via `getPublicClientForChain`?
2. On Base: can the validator now read the receipt, detect a >2% shortfall, and fire the
   auto-disable + P0 path? No false-criticals on mainnet?

**G4 — Server-side activation gate [MED · `ddc2977`]** (`/api/swap`, `/api/spender`)
1. Does `/api/swap` reject `!isChainActive(chainId)` (and unsupported via `getChainStatus`) at the
   boundary, BEFORE building calldata / fee logic? Mainnet (default) unaffected?
2. Is `/api/quote` left intentionally multi-chain-open (per `route.integration.test.ts`) — gated to
   **supported** chains only, not broken? Confirm the test still encodes the intent.
3. Is the fee-incompatible-source (0x/cow/bebop) fee-free-calldata-for-inactive-chain hole closed?

**G5 — `useTokenBalances` chain-aware [MED · `eb6fc5d`]** — Base balances render; multicall targets
the active chain's catalog; gated by `isChainActive`, not strict `CHAIN_ID`.

**G6 — Single chain-id source of truth [MED · `a50360b`]** — `useSwap`/`useSplitSwap` now use
`useActiveChainId()`; the simulate/broadcast chain provably equals the quote chain (test).

**G7 — Balancer fail-closed whitelist [MED/LOW · `e78753b`] — AUDITOR FOCUS.**
The adapter now requires `data.to ∈ getRouterWhitelist(chainId)`. **Open question flagged by the
Code Agent:** the gate only allows the Balancer **V2 Vault** — confirm the live Balancer SOR
`/order` response `tx.to` per chain (Vault vs **BatchRelayer**). If the API returns a relayer, this
gate would wrongly reject valid Balancer swaps. Verify the real per-chain target (mainnet + Base)
before this can be relied on; classify as H if it would break/again-misroute Balancer execution.

**G8 — Low-risk correctness [LOW · `9ab95e3`]** — feeTier cache key scoped by chainId;
`fetchChainlinkPriceRaw` now enforces `startedAt>0` via `validateRoundData`. Confirm no behavioural
regression on the mainnet swap path.

## Cross-cutting
- Rule #9: with G1+G2, is Chainlink/DefiLlama validation now genuinely applied to Base swaps (not
  silently degraded)? 
- No Solidity/contract edits; keys server-only; no new unbounded loops.
- `FEEDBACK.md` triaged.

## Deliverable
Findings table (ID, severity, file:line, fix) + one Code Agent remediation prompt per C/H. Verdict
**APPROVED** only at 0C/0H. On approval: update `docs/security/AUDIT-TOTAL.md`, then ship via the
Vercel **Preview** gate (verify Base oracle/guard/validator live on Preview) before promoting.
