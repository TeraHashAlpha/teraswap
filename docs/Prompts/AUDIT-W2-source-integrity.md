# AUDIT-W2-source-integrity — fix deployed-source-of-truth + refuse unusable quotes (W2-M-01 MED, W2-L-01 LOW)

> **Source:** T-SAF campaign 2026-07-01, Wave 2. **Not a live-contract defect** (fund-flow APPROVED 0C/0H) — these
> are a repo/deploy-integrity fix + a small app-side hardening. **No contract deploy, no Auditor re-pass required**
> (no on-chain logic changes). Commits SSH-signed (noreply committer). RICE: MED+LOW × low effort → do it.

## Context (proven on-chain in Wave 2)
The DEPLOYED FeeCollectors — mainnet `0x47f2…7459` + Base `0xeFC3…f130` — implement the **`minimumOutput`** swap
variants (`swapTokenWithFee(...,address,uint256)` `0x7f7663d4`, `swapETHWithFee(...,address,uint256)`), verifying
output against the **user's own balance delta** (`balanceOf(msg.sender)` before/after → `InsufficientOutput`). The
deployed bytecode matches **`contracts/TeraSwapFeeCollector.sol`** — **NOT** `TeraSwapFeeCollectorV2_flat.sol`,
which is a **stale, weaker, non-deployed** source that lacks minimumOutput. That mismatch fooled Wave 1 into
concluding (wrongly) that V2 had no on-chain minOutput. W0 recorded the on-chain code hashes
(mainnet FeeCollector V2 `0x3bde15fc219da158`; OrderExecutor `0x86c4cf824ab04c2d`; V1 `0x0462a4dea82127de`).

## Objective
Make it **impossible to mistake which source is deployed** (W2-M-01), and refuse swaps built on an unusable quote
so the on-chain per-leg minOutput check can't be silently disabled (W2-L-01).

## Requirements
### Part A — W2-M-01 (MED): deployed-source-of-truth
1. **Mark the stale source (do NOT delete — rule #4):** add a prominent header comment to
   `contracts/TeraSwapFeeCollectorV2_flat.sol` — `DEPRECATED / NOT DEPLOYED — superseded by
   contracts/TeraSwapFeeCollector.sol (the deployed FeeCollector). Do not audit/deploy/reference this file.` Prefer
   also renaming it to a clearly-non-deployed name (e.g. `*_DEPRECATED_flat.sol`) if the build tolerates it; if a
   rename risks CI, keep the name + the header. Ensure no build/test/import references it as authoritative.
2. **Create `docs/security/DEPLOYED-SOURCES.md`** — the canonical deploy map: for each deployed contract
   (both chains) a row of **address · chain · exact source file · solc version/settings · on-chain code hash**
   (reuse the W0 hashes; re-derive from the source build to confirm source == deployed). Cover FeeCollector
   (mainnet `0x47f2`, Base `0xeFC3`), FeeCollector V1 (`0x4dAE`), OrderExecutor (mainnet `0xeFC3`, Base `0x135B`).
   Add a one-line "how to re-verify" (`cast code` hash vs `forge build` artifact).
3. Optionally add a CI check that fails if a `*_flat.sol` (or any non-DEPLOYED-SOURCES source) is treated as the
   deployed contract — best-effort; document if deferred.

### Part B — W2-L-01 (LOW): refuse unusable quotes
4. In the swap-build path, when a leg's quote/`toAmount` is **malformed / zero / unparseable**, do **NOT** fall back
   to `minimumOutput = 0` (which disables the on-chain per-leg output check) — **refuse the swap** with a clear
   error instead. Preserve the legitimate flow (a valid `toAmount` → a real minimumOutput floor). Add a test:
   malformed `toAmount` → swap refused (not minOutput-0).

## Do NOT
- Do NOT delete the flat file (rule #4 — mark/deprecate). Do NOT change any deployed contract logic or deploy
  anything. Do NOT alter the live FeeCollector/OrderExecutor source. Do NOT weaken the minimumOutput floor for
  valid quotes. Do NOT hardcode secrets.

## Files affected (verify on main)
- `contracts/TeraSwapFeeCollectorV2_flat.sol` (mark deprecated) · new `docs/security/DEPLOYED-SOURCES.md` ·
  the swap-build/quote path that derives `minimumOutput` (`api/swap` / `swap-build-retry.ts` / the quote parser) +
  its test.

## Expected output
- Branch off latest `origin/main`; SSH-signed; CI green. The flat file is unambiguously marked non-deployed;
  `DEPLOYED-SOURCES.md` maps every deployed address → source → solc → code-hash (source == on-chain re-verified);
  the swap path refuses an unusable quote (test proves it). FEEDBACK notes the W1-I-02 refutation this closes.

## Quality criteria
No one can mistake the stale flat file for the deployed contract; a canonical addr→source→hash map exists and
re-verifies; unusable quotes are refused rather than silently zeroing the minOutput floor; no contract/deploy change.

---

## Implementation notes (Code Agent, 2026-07-02, branch `audit/w2-source-integrity`)
- **Part A:** flat renamed → `contracts/TeraSwapFeeCollectorV2_DEPRECATED_flat.sol` + ⛔ banner (build tolerates:
  both foundry projects glob-compile; nothing imports it — verified). `docs/security/DEPLOYED-SOURCES.md` created
  with per-row byte-level provenance: Base FeeCollector, FeeCollector V1 (solc 0.8.20, optimizer off, no via-IR)
  and BOTH OrderExecutors byte-proven (mainnet = source at commit `c22794c`; Base = tip; Base hash `0x34ef10ab25a43c51`
  newly baselined). Mainnet FeeCollector V2 pinned by hash + on-chain solc 0.8.28 + 19/19 selector proof; byte-exact
  repro deferred to the Etherscan-verified-settings pull (owner follow-up — Remix deploy, OZ revision unknown).
  The optional CI check was NOT deferred: `scripts/check-deployed-sources.mjs` (static, dependency-free) runs as
  the `deployed-sources-guard` job; `scripts/verify-deployed-sources.mjs` is the on-chain re-verifier (manual).
- **Part B:** the minOut-0 fallback lived in THREE sites (not `api/swap`/`swap-build-retry.ts` — the server never
  derives minimumOutput): `useSwap.ts`, `useSplitSwap.ts` (per-leg), `swap-simulation.ts` (`buildSimulationTx`).
  All three now call the shared `deriveMinimumOutput()` (`src/lib/minimum-output.ts`), which throws
  `UnusableQuoteError` on malformed/zero/unparseable/negative `toAmount` — single-swap: caught → error + 9O
  fallback-walk to the next source; split: leg marked error/skipped, nothing signed. Valid quotes and the
  slippage≥100% clamp are unchanged. Tests: `src/lib/minimum-output.test.ts` (new), `swap-simulation.test.ts`
  (builder refusal + direct-route pass-through + real-floor encode), `useSplitSwap.test.ts` (the old 10-L-01
  "minOut defaults to 0" test FLIPPED to refusal), `swap-validations.test.ts` A5 (now tests the real helper, not
  a mirror). CI-gated via the new `minimum-output-guard` job (the full vitest suite doesn't run in CI).
