# CHORE-47C-ARBITRUM-CATALOG — populate the 42161 token catalog from the manifest (closes audit M-01)

> **Source:** AUDIT-ARBITRUM-46-47 re-run (2026-07-09): **#303 APPROVE-TO-MERGE 0C/0H**, with **M-01 (MED,
> fail-safe, non-blocking)** — `CHAIN_TOKENS[42161]` is empty, so the Arbitrum selector is empty and the runbook's
> Preview smoke (WETH→USDC) cannot run on the env-flip alone; a catalog-population step (+ the USDT0
> symbol-mismatch allowlist entry) must exist before §6. **Owner decisions:** launch catalog = the 5
> **feed-covered** manifest tokens — WETH, USDC (native), USDT (on-chain symbol `USD₮0`), DAI, WBTC; **wstETH
> intentionally deferred** post-activation (L-01 adjudicated: launch set ⊆ Chainlink-feed-covered set).
> Branch off `origin/main` **post-#303 merge**. Strictly additive + still dark (feeCollector env unset) →
> Auditor note; the Preview gate is the functional check. Per [[feedback_address_hygiene]]: **no hand-typed hex —
> catalog addresses come from `docs/Reports/ARBITRUM-ADDRESS-MANIFEST.json`, programmatically.**
> SSH-signed; branch `chore/47c-arbitrum-catalog`, dedicated worktree; 3 droppable commits.

## Requirements (per-commit)

### 1. Catalog population (from the manifest, not from anywhere else)
- `CHAIN_TOKENS[42161]` = WETH, USDC (native), USDT, DAI, WBTC — **addresses imported/derived from
  `ARBITRUM-ADDRESS-MANIFEST.json`** (compile-time import or a codegen step; zero hex literals typed into the
  catalog file). Decimals from the manifest's on-chain reads (6/18/6/18/8). Logos via the existing token-logo
  pipeline (reuse the coverage/fallback pattern).
- **USDT0 handling:** catalog key/symbol shown = `USDT`; add the **`symbolMismatchExempt`** entry the audit
  requires (on-chain `symbol()` = `USD₮0`) so the catalog collision/verified-badge guard does not flag it; comment
  citing the audit adjudication.
- NO wstETH (deferred, owner decision — record in a comment).

### 2. Guard extension
Extend `arbitrum-manifest.test.ts` (or a sibling) so the CATALOG addresses are also diffed against the manifest —
a catalog entry whose address diverges from the manifest fails CI, same as config. Assert the catalog is exactly
the 5-token launch set (adding a 6th without updating the test = intentional friction).

### 3. Runbook step + tests
- `ARBITRUM-FEECOLLECTOR-DEPLOY.md`: insert the explicit pre-§6 step "catalog populated + guard green (this
  chore merged)" so the Preview smoke has WETH→USDC available; note the USDT0 label nuance for whoever runs smoke.
- Tests: catalog resolution for 42161 (5 tokens, correct decimals, dark state unchanged — selector still gated by
  `isChainActive`), symbolMismatchExempt honored, collision/decimals guards green.

## Do NOT
Flip envs; deploy; add wstETH or any 6th token; type any hex literal; touch adapters/routers/config beyond the
catalog + guard + runbook step; touch v3 files.

## Files affected (read ONLY these + new)
Token catalog module for 42161, `src/lib/chains/arbitrum-manifest.test.ts` (extend), catalog guard config
(symbolMismatchExempt), `docs/Runbooks/ARBITRUM-FEECOLLECTOR-DEPLOY.md` (one step),
`docs/Prompts/CHORE-47C-ARBITRUM-CATALOG.md`. Read-only: `docs/Reports/ARBITRUM-ADDRESS-MANIFEST.json` (source of
truth), the #303 audit review, token-logo pipeline.

## Expected output
Branch + PR, CI green (push + report, don't poll). FEEDBACK ≤1 screen: the 5 entries (address ← manifest,
decimals, logo status), the USDT0 exempt entry, guard coverage. Auditor note in the PR body (functional check =
the runbook's Preview gate).

---

### `/goal` paste for the Code Agent (≤4000)
```
CONTROL: model Sonnet · effort low · NO CI-poll (push + report, don't watch) · read ONLY the listed files · NEVER invoke credential helpers or read the keychain · FEEDBACK <= 1 screen.

CHORE-47C-ARBITRUM-CATALOG per docs/Prompts/CHORE-47C-ARBITRUM-CATALOG.md (commit the spec in this PR). Branch chore/47c-arbitrum-catalog off origin/main (post-#303 merge) in a DEDICATED worktree, SSH-signed, CI green. Closes audit M-01 (empty CHAIN_TOKENS[42161] -> Preview smoke impossible). Strictly additive, chain stays DARK (env unset) -> Auditor note only. HARD RULE: no hand-typed hex — every catalog address comes from docs/Reports/ARBITRUM-ADDRESS-MANIFEST.json programmatically (import or codegen).

Owner decisions: launch catalog = the 5 FEED-COVERED manifest tokens: WETH, USDC (native), USDT (on-chain symbol "USD₮0"), DAI, WBTC. wstETH intentionally DEFERRED post-activation (launch set ⊆ Chainlink-feed-covered set) — record in a comment.

Commits (droppable, in order):
1. CHAIN_TOKENS[42161] = the 5 tokens, addresses imported/derived from the manifest (ZERO hex literals in the catalog file), decimals from the manifest's on-chain reads (18/6/6/18/8), logos via the existing token-logo pipeline (coverage/fallback pattern). USDT0: catalog key/symbol shown = USDT + add the symbolMismatchExempt entry (on-chain symbol USD₮0) so the collision/verified-badge guard doesn't flag it; comment cites the audit adjudication.
2. Guard extension: arbitrum-manifest.test.ts (or sibling) also diffs CATALOG addresses vs the manifest — divergence fails CI; assert the catalog is EXACTLY the 5-token set (6th token without test update = intentional friction).
3. Runbook + tests: ARBITRUM-FEECOLLECTOR-DEPLOY.md gains the explicit pre-§6 step "catalog populated + guard green (this chore merged)" + note the USDT0 label nuance for the smoke runner. Tests: 42161 catalog resolution (5 tokens, decimals), dark state unchanged (selector still gated by isChainActive), symbolMismatchExempt honored, collision/decimals guards green.

Do NOT: flip envs; deploy; add wstETH or a 6th token; type hex; touch adapters/routers/chain config beyond catalog + guard + the one runbook step; touch v3 files.

Files: 42161 token catalog module, src/lib/chains/arbitrum-manifest.test.ts (extend), catalog guard config (symbolMismatchExempt), docs/Runbooks/ARBITRUM-FEECOLLECTOR-DEPLOY.md (one step), docs/Prompts/CHORE-47C-ARBITRUM-CATALOG.md. Read-only: docs/Reports/ARBITRUM-ADDRESS-MANIFEST.json (source of truth), the #303 audit review, token-logo pipeline.

Expected: PR open, CI green (push + report). FEEDBACK <=1 screen: the 5 entries (address<-manifest, decimals, logo status), the USDT0 exempt entry, guard coverage. Auditor note in the PR body (functional check = the runbook's Preview gate).
```
