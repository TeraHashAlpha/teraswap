# INVESTIGATE-ARBITRUM-READINESS — read-only recon for launching Arbitrum One (42161) swaps

> **Source:** Architect chain-expansion analysis 2026-07-09 (RICE 7.7 — Arbitrum next after the v3 sprint prompts are
> dispatched). External facts already established: all 12 sources support Arbitrum; Chainlink has rich feeds there;
> Alchemy serves it; DefiLlama covers pricing. This recon verifies the **codebase + on-chain specifics** so the
> implementation sprint (SPRINT-ARBITRUM, to be written next) starts from confirmed facts, not assumptions.
> **Read-only: NO source changes** — output is a report + the committed spec. Not fund-flow → no Auditor.
> SSH-signed; branch `chore/arbitrum-readiness` off latest `origin/main` in a dedicated worktree.

## Objective
Produce `docs/Reports/ARBITRUM-READINESS.md`: a readiness matrix (READY / NEEDS-CODE / NEEDS-DEPLOY / UNKNOWN per
item) + the gap list that defines the implementation sprint's scope.

## Scope (verify, do not fix)

### 1. Codebase chain-assumptions sweep
- Enumerate every chain-conditional site: `getChainConfig` callers, hardcoded `chainId === 1` / `=== 8453`,
  two-chain assumptions (arrays/switches that enumerate {1, 8453}), `CHAIN_CONFIGS` shape.
- `gasModel` usage: where `'op-stack'` branches (L1 data-fee estimation, gas UI). What breaks with Arbitrum Nitro
  (neither pure eip1559 nor op-stack)? Report the minimal change (new enum variant vs mapping).
- Order-engine gates: confirm DCA/order paths pin `chainId === 8453` and that ADDING a 42161 ChainConfig cannot
  leak orders/executor UI onto Arbitrum (fail-closed like Base pre-launch). List every gate that assumes
  "L2 == Base".

### 2. Adapter-by-adapter Arbitrum readiness (all 12)
For each (1inch, 0x, Velora, Odos, KyberSwap, CoW, OpenOcean, UniswapV3, SushiSwap, Balancer, Curve, Bebop):
current URL/param shape in the adapter code, what 42161 requires (path/param/slug — e.g. CoW chain slug, Kyber
`arbitrum` slug), per-chain contract addresses needed (UniswapV3 factory/quoter, Curve registries on Arbitrum),
and whether the existing API key covers Arbitrum (key-scope note only — do NOT print keys).

### 3. On-chain facts (read-only RPC/cast against a public Arbitrum endpoint)
- Velora/Augustus **V6.2 at the canonical cross-chain address**: confirm deployed bytecode on 42161 (+ record the
  address for the router whitelist).
- Permit2 canonical address present; CoW vault relayer address on Arbitrum.
- Token catalog anchors: WETH, **USDC native vs USDC.e (bridged)** — record both, flag which the catalog should
  list; USDT, DAI, WBTC, wstETH.
- Chainlink: sequencer uptime feed address on Arbitrum (verify it answers); ETH/USD, BTC/USD, USDC/USD + feeds for
  the intended catalog tokens (record addresses + heartbeat/decimals).
- DefiLlama chain slug for 42161 pricing.

### 4. Env & infra inventory
List every env var the launch needs (RPC URLs primary/fallback, `NEXT_PUBLIC_*` FeeCollector placeholder — null
until deploy, adapter key scopes) mirroring the Base pattern — names only, no values.

## Do NOT
- Do NOT modify any source file, config, or test. Do NOT deploy anything. Do NOT print/commit secrets or key
  values. Do NOT call authenticated adapter APIs beyond a key-scope check. Do NOT touch the v3 sprint files
  (`TeraSwapOrderExecutorV3*`, ADR-013) — a parallel session owns them.

## Files affected
- **New:** `docs/Reports/ARBITRUM-READINESS.md`, `docs/Prompts/INVESTIGATE-ARBITRUM-READINESS.md` (this spec).
- **Read-only:** `src/lib/chains/**`, `src/lib/adapters/**` (or actual adapter paths), `constants.ts`, order-engine
  gates, `.env.example`.

## Expected output
Branch `chore/arbitrum-readiness` (dedicated worktree), SSH-signed, PR open, CI green — push + report, do NOT
watch CI. The report with the readiness matrix + gap list + a proposed sprint slicing (config/catalog → activation)
sized against the Base template (Sprints 43–45). FEEDBACK ≤1 screen in the PR body: top 5 gaps + anything UNKNOWN.

## Quality criteria
Every matrix row is verified (code cite or on-chain read), not assumed; USDC/USDC.e disambiguated; gasModel gap
precisely described; order-engine fail-closed on 42161 confirmed; zero source changes.

---

### `/goal` paste for the Code Agent (≤4000)
```
CONTROL: model Haiku · effort low · NO CI-poll (push + report, don't watch) · read ONLY the listed files · FEEDBACK <= 1 screen.

INVESTIGATE-ARBITRUM-READINESS per docs/Prompts/INVESTIGATE-ARBITRUM-READINESS.md (commit the spec in this PR). Branch chore/arbitrum-readiness off origin/main in a DEDICATED worktree, SSH-signed, PR open, CI green. READ-ONLY RECON: no source/config/test changes; output = docs/Reports/ARBITRUM-READINESS.md (readiness matrix READY/NEEDS-CODE/NEEDS-DEPLOY/UNKNOWN + gap list + proposed sprint slicing vs the Base template, Sprints 43-45). Not fund-flow -> no Auditor.

Context: TeraSwap is planning Arbitrum One (42161) swaps as the next chain after Base. Externally confirmed: all 12 sources support Arbitrum; Chainlink rich feeds; Alchemy; DefiLlama. This recon verifies codebase + on-chain specifics.

Verify (do NOT fix):
1. Chain-assumptions sweep: all getChainConfig callers; hardcoded chainId===1/8453; switches/arrays enumerating exactly {1,8453}; CHAIN_CONFIGS shape. gasModel usage: where 'op-stack' branches (L1 data-fee estimation, gas UI) and what Arbitrum Nitro needs (new enum variant vs mapping) — report minimal change. Order-engine gates: confirm DCA/order paths pin chainId===8453 and adding a 42161 config CANNOT leak orders/executor UI onto Arbitrum (fail-closed like Base pre-launch); list every gate assuming "L2 == Base".
2. All 12 adapters (1inch, 0x, Velora, Odos, KyberSwap, CoW, OpenOcean, UniswapV3, SushiSwap, Balancer, Curve, Bebop): current URL/param shape, what 42161 requires (path/param/slug), per-chain contract addresses needed (UniV3 factory/quoter, Curve registries), whether the existing API key scope covers Arbitrum (note only — NEVER print keys).
3. On-chain reads (public Arbitrum RPC, read-only): Velora/Augustus V6.2 bytecode at the canonical cross-chain address (record for router whitelist); Permit2; CoW vault relayer; token anchors WETH, USDC NATIVE vs USDC.e (record both, flag catalog choice), USDT, DAI, WBTC, wstETH; Chainlink sequencer uptime feed (verify it answers) + ETH/USD, BTC/USD, USDC/USD + catalog-token feeds (addresses, decimals, heartbeat); DefiLlama slug for 42161.
4. Env inventory mirroring Base: RPC vars, NEXT_PUBLIC_* FeeCollector placeholder (null until deploy), adapter key scopes — names only, no values.

Do NOT: modify any source/config/test; deploy; print/commit secrets; call authenticated APIs beyond key-scope checks; touch v3 sprint files (TeraSwapOrderExecutorV3*, ADR-013) — a parallel session owns them.

Files: NEW docs/Reports/ARBITRUM-READINESS.md + docs/Prompts/INVESTIGATE-ARBITRUM-READINESS.md. Read-only: src/lib/chains/**, adapter modules, constants.ts, order-engine gates, .env.example.

Expected: PR open, CI green (push + report). Report = verified matrix (code cite or on-chain read per row, no assumptions) + gaps + sprint slicing. FEEDBACK <=1 screen in the PR body: top 5 gaps + anything UNKNOWN.
```
