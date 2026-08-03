# CHORE-STABLECOIN-CONSTANT — one chain-keyed stablecoin source of truth (AZ review, was batch commit 3)

> **Source:** A-Z review v2 — **6 divergent stablecoin lists** (SlippageModal, 2× SwapBox, useSplitRoute,
> chains/tokens) → **USDbC counts as ~$1 in one gate but not another.** Held from `CHORE-AZ-SECURITY-BATCH` (commit 3)
> until the SwapBox `lowConfidence` render (#272) merged; **SwapBox is now free.** This is **correctness, not style.**
> Chain-keyed. **No execution-gate / SC-04 / R1 / on-chain / contract change.** SSH-signed (noreply committer).

## Objective
Consolidate the 6 divergent stablecoin lists into **one source of truth keyed by chainId**, wire every call site to it,
and **document which gates change behaviour** (because the lists diverged) + why the new value is correct.

## Requirements
1. **One chain-keyed stablecoin constant** — mainnet: USDC/USDT/DAI/… ; Base: USDbC/USDC/… . A single source of truth
   (e.g. in `chains/tokens` or a dedicated constant), keyed by `chainId`.
2. **Enumerate the 6 current lists** (SlippageModal, SwapBox ×2, useSplitRoute, chains/tokens) + their **diffs**;
   determine the **correct canonical set per chain**; wire **every** call site to the constant.
3. **Consolidating WILL change some gate's behaviour** (the lists diverged) → **document in FEEDBACK which gates change
   + why the new value is correct** (e.g. USDbC must be a $1 stable on Base *everywhere*). If any list's exclusion
   looks **intentional/unclear**, **FLAG it** — do not silently absorb it.
4. **Add a test** asserting the per-chain stablecoin set + that each call site resolves to it.

## Do NOT
- No execution-gate / SC-04 / R1 / on-chain / contract change. Don't silently change a gate's stablecoin membership
  without documenting it. Don't hardcode a chain.

## Files affected (verify on main)
- A new chain-keyed stablecoin constant; `SlippageModal`, `SwapBox` (2 sites), `useSplitRoute`, `chains/tokens`; + a
  test. (Locate the exact 6 lists on main — the AZ review counted 6.)

## Expected output
- Branch `chore/stablecoin-constant` off latest `origin/main`; SSH-signed; CI green. All call sites use the single
  chain-keyed constant. FEEDBACK: the per-chain canonical set, which gates changed behaviour + why correct, and any
  flagged exclusion.

## Quality criteria
Stablecoin membership is single-sourced + chain-correct; every behaviour change is documented; no gate/contract change;
USDbC (and every per-chain stable) is consistent across all gates.

---

### `/goal` paste for the Code Agent (≤4000)
```
CHORE-STABLECOIN-CONSTANT per docs/Prompts/CHORE-STABLECOIN-CONSTANT.md. Branch
chore/stablecoin-constant off latest origin/main, SSH-signed (noreply committer),
CI green. Correctness, not style. No execution-gate/SC-04/R1/on-chain/contract
change.

Source: A-Z review v2 — 6 divergent stablecoin lists (SlippageModal, 2x SwapBox,
useSplitRoute, chains/tokens); USDbC counts as ~$1 in one gate but not another.
(Held until #272 freed SwapBox; now free.)

Do:
1. Create ONE chain-keyed stablecoin constant (mainnet USDC/USDT/DAI...; Base
   USDbC/USDC...), keyed by chainId — a single source of truth (chains/tokens or a
   dedicated constant).
2. Enumerate the 6 current lists (SlippageModal, SwapBox x2, useSplitRoute,
   chains/tokens) + their diffs; determine the correct canonical set PER CHAIN;
   wire EVERY call site to the constant.
3. Consolidating WILL change some gate's behaviour (the lists diverged) -> DOCUMENT
   in FEEDBACK which gates change + why the new value is correct (e.g. USDbC must be
   a $1 stable on Base everywhere). If any list's exclusion looks intentional/
   unclear, FLAG it — do not silently absorb.
4. Add a test asserting the per-chain stablecoin set + that each call site resolves
   to it.

Do NOT: execution-gate/SC-04/R1/on-chain/contract change; silently change a gate's
stablecoin membership without documenting; hardcode a chain.

Files (verify on main): a new chain-keyed stablecoin constant; SlippageModal,
SwapBox (2 sites), useSplitRoute, chains/tokens; + a test. FEEDBACK: the per-chain
canonical set, which gates changed behaviour + why correct, any flagged exclusion.
```
