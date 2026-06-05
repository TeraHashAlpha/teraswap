# SPRINT-9Q — Chain-pin the mainnet-pinned reads (BASE-REVIEW P0) + rate-invert toggle

## Context
`Audits/BASE-REVIEW-2026-06-04.md` Phase 1 (URGENT/HIGH): every **ERC20-input swap on Base reverts**
because allowance/pre-flight reads are mainnet-pinned. `getPrivateClient()` (`src/lib/rpc.ts:53`) is
hard-pinned to viem `mainnet` and proxies `/api/rpc` with **no chainId**. Affected (per the review):
- `useSwap` allowance pre-flights (`useSwap.ts:492,533`)
- `useApproval` reads (omit chainId)
- receipt polling (`useSwap.ts:1004`, `useSplitSwap.ts:81`) → Base swaps "hang" / false split timeouts
- CoW pre-flight (same root, folded into P0 by the review)
Mechanism: allowance is read on MAINNET → UI thinks approval state is fine → the (chain-correct) sim
reverts on the missing **Base** transferFrom approval → 9O fallback retries other fee-routed sources →
all need the same Base approval → every source fails. ETH-input works (no approval) — the invariant
that proved spender + router whitelist are fine.

## Q1 — Fix (minimal, per the review)
Chain-pin all the above reads: use `getPublicClientForChain(activeChainId)` (note: for chainId 1 it
returns `getPrivateClient()` → mainnet byte-identical by construction) and/or pass `chainId` through to
`useApproval` and the `/api/rpc` calls (the proxy already accepts `?chainId=` since 9P). Cover every
site the review lists (allowance pre-flights, useApproval, receipt polling in both hooks, CoW
pre-flight). Consult the review doc for exact file:line.

Result expected: on Base, an ERC20-input swap correctly detects the missing allowance → shows the
approval step → after approval the sim passes → swap executes; receipts poll the right chain (no
hang); split timeouts stop being false.

## Q2 — Rate-invert toggle (owner request; SEPARATE final commit, pure UI)
In the quote panel, the Rate row ("1 USDC = 0.0006 ETH") becomes clickable (with a ⇄ icon) to flip the
direction ("1 ETH = 1,666.67 USDC"), so users can read the ETH price at a glance. Persist the chosen
direction for the session (component state is fine). No price math changes — display-only inversion
(guard division by zero / tiny values; sensible significant digits). Add a render/interaction test.

## Tests (TDD)
- Base ERC20-input: allowance absent → approval flow shown; (mocked) post-approval sim passes; ALL
  fee-routed sources no longer uniformly fail.
- Mainnet: byte-identical (default chainId path) — existing suites stay green.
- Receipt polling: polls the active chain's client (Base receipt resolves; mainnet unchanged).
- Rate toggle: flips display both ways, no math drift, handles extreme rates.

## Do NOT
- No safety-gate, FeeCollector, adapter, selector, or contract changes. The 9O fallback logic stays
  (it'll just stop firing spuriously once allowance reads are correct).
- Don't touch the split-swap Review issue or the frozen-pendingSwap modal (that's SPRINT-9R) or the
  Base Chainlink feed map (SPRINT-9S).
- Mainnet byte-identical (test-guarded). Keys server-only.
- Branch `feat/sprint-9q-chain-pinned-reads`, atomic SSH-signed commits (Q2 separate), CI green,
  append FEEDBACK. Not a security gate → no Auditor; Preview-test before prod. The live wallet
  confirmation (real USDC→ETH on Base) is an OWNER post-merge step — do everything automatable and
  STOP (no loop).
