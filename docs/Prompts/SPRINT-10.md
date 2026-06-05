# Sprint 10 — Security Hardening + MEV UX + Clear Signing

**Sprint window:** Post-P68 deploy → TBD
**Sprint goal:** Harden supply chain security (signed commits, branch protection), improve MEV protection UX (auto-default, surplus metrics), prepare ERC-7730 clear signing for Ledger, and add educational MEV content.
**Owner:** TeraHash (founder/architect) + code agent
**Prerequisite:** Sprint 9B COMPLETE (P68 deployed, new FeeCollector address live).
**References:**
- CVE-2026-3854 (GitHub RCE via git push) — @sagitz_ / Wiz Research
- 1inch MEV article (2026-05-08) — intent-based execution positioning
- ERC-7730 clear signing registry — LedgerHQ/clear-signing-erc7730-registry
- Auditor recommendation: /ultrareview as pre-audit triage

---

## Sprint status table

| # | Prompt | Description | Priority | Status |
|---|--------|------------|----------|--------|
| 69 | Signed commits + branch protection | GPG enforcement + GitHub branch rules | P1 (RICE 42) | Pending |
| 70 | MEV protection as smart default | Auto-enable MEV when CoW wins best price | P2 (RICE 12.8) | Pending |
| 71 | MEV surplus display in QuoteBreakdown | Show estimated MEV savings on CoW quotes | P3 (RICE 5.6) | Pending |
| 72 | ERC-7730 clear signing metadata | JSON metadata for FeeCollector V2 Ledger display | P1 (RICE 27.2) | Pending |
| 73 | Educational MEV content | Blog-style content for landing page / docs | P2 (RICE 18) | Pending |
| 74 | SwapWithFee topic hash V2 (9B-I-01) | Update on-chain-monitor topic to 7-param V2 signature | P2 (RICE 16) | Pending |

---

## Prompt 69 — Signed commits + branch protection

**Status:** Pending

**Context:** CVE-2026-3854 demonstrated Remote Code Execution on GitHub via a single `git push`, affecting millions of repositories. While GitHub has patched the specific vulnerability, the broader supply chain risk remains: any DeFi project hosted on GitHub could have malicious code injected if a similar vulnerability emerges. TeraSwap currently relies on auditor review and CI checks, but neither cryptographically verifies commit authorship.

**Objective:** Enforce GPG-signed commits and strict branch protection on the `main` branch to prevent unauthorized code injection.

**Requirements:**

1. **Branch protection rules on `main`:**
   - Require pull request before merging (no direct pushes)
   - Require at least 1 approval
   - Require status checks to pass (ci, security-audit)
   - Require signed commits
   - Do not allow force pushes
   - Do not allow branch deletion
   - No admin bypass (except documented emergencies)

2. **GPG key setup documentation:**
   - Create `docs/Runbooks/SIGNED-COMMITS.md` with step-by-step:
     - Generate GPG key (or use existing SSH signing)
     - Add to GitHub account
     - Configure git locally (`git config --global commit.gpgsign true`)
     - Verify setup (`git log --show-signature`)

3. **Update CLAUDE.md:**
   - Add to "Do NOT" section: `NEVER commit without GPG signature — all commits must be signed.`

**Do NOT**

- Touch any application code
- Modify CI workflows (branch protection is GitHub Settings, not Actions)
- Generate GPG keys for the user (they do this themselves)

**Files affected**

- `docs/Runbooks/SIGNED-COMMITS.md` (new)
- `CLAUDE.md` (add signed commit rule)

**Expected output**

- 1 commit with the runbook + CLAUDE.md update
- TeraHash applies branch protection rules manually via GitHub Settings → Branches

**Quality criteria**

- Runbook is clear enough for a non-expert to follow
- CLAUDE.md rule is concise and unambiguous

---

## Prompt 70 — MEV protection as smart default

**Status:** Pending

**Context:** Currently, TeraSwap has a manual toggle for MEV protection in the SwapBox. When enabled, it filters quotes to CoW Protocol only. The 1inch approach (and industry trend) is to make MEV protection the default behaviour, not an opt-in setting.

However, we should NOT simply force CoW-only routing. Our competitive advantage is meta-aggregation — showing the best price across 11 sources. The improvement is: when CoW Protocol wins (or is within a small threshold of the best price), automatically route through CoW without requiring the user to toggle anything.

**Objective:** Make MEV protection automatic when CoW offers competitive pricing, while keeping the manual toggle as an override.

**Requirements:**

1. **Smart MEV routing logic in `useQuote` or `SwapBox`:**
   - When CoW quote is within 0.3% of the best non-CoW quote, prefer CoW (MEV-protected)
   - When CoW quote is >0.3% worse, use the best quote (show "MEV exposure" warning)
   - When MEV toggle is ON (manual override), always force CoW-only (existing behaviour)
   - Threshold of 0.3% is configurable via constant `MEV_PREFERENCE_THRESHOLD`

2. **UI indicator in QuoteBreakdown:**
   - When smart MEV routing kicks in, show a subtle shield icon + "MEV Protected" badge on the selected quote
   - When best quote has MEV exposure, show a small warning: "This route is not MEV-protected. Enable MEV Protection for sandwich attack prevention."

3. **Rename toggle label:**
   - From "MEV Protection" → "Force MEV Protection"
   - Update tooltip: "Always route through CoW Protocol regardless of price. When off, TeraSwap automatically prefers MEV-protected routes when pricing is competitive."

**Do NOT**

- Change the CoW adapter or any API integration
- Modify the fee calculation logic
- Remove the manual toggle — it stays as an override
- Change behaviour when toggle is ON — existing MEV-force behaviour is unchanged

**Files affected**

- `src/components/SwapBox.tsx` (smart routing logic, toggle rename)
- `src/components/QuoteBreakdown.tsx` (MEV badge logic)
- `src/lib/constants.ts` (add `MEV_PREFERENCE_THRESHOLD = 0.003`)

**Expected output**

- 1 commit with smart MEV routing + UI updates
- Existing 423 tests pass (no test changes needed — logic is additive)

**Quality criteria**

- When CoW wins or is within 0.3%, route automatically goes through CoW without user action
- Manual toggle ON still forces CoW-only
- No regression in swap execution flow

---

## Prompt 71 — MEV surplus display in QuoteBreakdown

**Status:** Pending

**Context:** The post-execution validator (`post-execution-validator.ts`) already calculates surplus (actual output vs expected minimum). When a swap goes through CoW Protocol, solvers often capture positive surplus for the user — this is money the user saved vs a public mempool execution. Currently this data exists but is not shown to the user.

**Objective:** Display estimated MEV savings when showing CoW Protocol quotes, and actual surplus after swap execution.

**Requirements:**

1. **Pre-swap estimate in QuoteBreakdown:**
   - When the selected quote is from CoW, show estimated savings:
     - Compare CoW quote output vs median of all non-CoW quotes
     - If CoW output > median: show "Est. MEV savings: +X.XX USDC (Y.Y%)"
     - If CoW output ≤ median: don't show savings line (CoW may still protect but no measurable surplus)
   - Use muted green text, small font, below the price impact line

2. **Post-swap confirmation:**
   - In the swap success state (after `validatePostExecution` returns), if surplus > 0 and source was CoW:
     - Show "You saved ~$X.XX vs public mempool execution" in the success toast/modal
   - Use the surplus data already calculated in `post-execution-validator.ts` line 278-279

3. **Analytics tracking:**
   - Log `mev_savings_estimate` and `mev_savings_actual` to the existing `log-swap` API route
   - Add these fields to the Supabase `swap_logs` table (nullable numeric columns)

**Do NOT**

- Modify the post-execution validator logic (only read its output)
- Show negative savings (if CoW is worse, just don't show the line)
- Hardcode USD conversion — use the existing Chainlink price feed for the output token

**Files affected**

- `src/components/QuoteBreakdown.tsx` (pre-swap estimate display)
- `src/components/SwapBox.tsx` or success state component (post-swap savings)
- `src/app/api/log-swap/route.ts` (accept new fields)
- `src/lib/analytics.ts` (pass new fields)
- Supabase migration: add `mev_savings_estimate` and `mev_savings_actual` to `swap_logs`

**Expected output**

- 1 commit with UI + analytics changes
- Supabase migration SQL provided as separate file

**Quality criteria**

- Savings only shown when positive and source is CoW
- No UI changes for non-CoW swaps
- Analytics fields nullable (no migration breaking existing rows)

---

## Prompt 72 — ERC-7730 clear signing metadata for FeeCollector V2

**Status:** Pending (blocked by P68 — needs final contract address)

**Context:** Ledger users currently see hex calldata ("blind signing") when approving TeraSwap swaps. ERC-7730 is an open standard that maps contract calldata to human-readable fields on the Ledger Secure Screen. The registry is at `github.com/LedgerHQ/clear-signing-erc7730-registry`.

After P68 deploys the new FeeCollector V2, we have the final contract address needed to create the metadata file.

**Objective:** Create an ERC-7730 JSON metadata file for TeraSwap FeeCollector V2 and prepare a PR to the LedgerHQ registry.

**Requirements:**

1. **Create ERC-7730 metadata file:**
   - Cover `swapTokenWithFee(address token, uint256 totalAmount, address router, bytes routerData, address tokenOut, uint256 minimumOutput)`:
     - Display: token symbol (via `token` address → ERC-20 metadata), `totalAmount` with decimals, router label (lookup from known addresses), `tokenOut` symbol, `minimumOutput` with decimals
     - Exclude: `routerData` (opaque bytes, not human-readable)
   - Cover `swapETHWithFee(address router, bytes routerData, address tokenOut, uint256 minimumOutput)`:
     - Display: ETH amount from `@.value`, router label, `tokenOut` symbol, `minimumOutput` with decimals
     - Exclude: `routerData`

2. **Validate with ERC-7730 CLI:**
   - Install: `npm install -g @ledgerhq/erc7730-cli`
   - Run: `erc7730 validate <file>.json`
   - Must pass with 0 errors

3. **Prepare PR to LedgerHQ registry:**
   - Fork `LedgerHQ/clear-signing-erc7730-registry`
   - Add metadata file to `registry/ethereum/` following their naming convention
   - PR title: `feat: add TeraSwap FeeCollector V2 clear signing metadata`
   - PR body: describe contract, functions covered, link to verified contract on Etherscan

**Do NOT**

- Submit the PR until the contract is verified on Etherscan (depends on P68)
- Include routerData in human-readable display (it's arbitrary bytes)
- Modify any TeraSwap application code

**Files affected**

- `docs/erc7730/teraswap-feecollector-v2.json` (new — metadata file)
- External PR to LedgerHQ registry

**Expected output**

- 1 commit with the metadata file in the repo
- PR to LedgerHQ registry (after P68 + Etherscan verification)

**Quality criteria**

- ERC-7730 CLI validation passes
- Both swap functions covered with readable field descriptions
- No blind signing for any field that can be decoded

---

## Prompt 73 — Educational MEV content for landing page

**Status:** Pending

**Context:** 1inch published an educational article (2026-05-08) positioning MEV protection as their key differentiator. TeraSwap has MEV protection via CoW Protocol + meta-aggregation across 11 sources, which is arguably stronger — we find the best price AND protect against MEV. But we don't communicate this effectively.

**Objective:** Add an MEV education section to the docs page and create a standalone content piece.

**Requirements:**

1. **Add MEV section to DocsPage (`src/components/DocsPage.tsx`):**
   - New section: "MEV Protection"
   - Subsections:
     - What is MEV? (2-3 sentences, plain language)
     - How TeraSwap protects you (CoW batch auctions, no mempool exposure)
     - Why meta-aggregation matters (best price + MEV protection, not one OR the other)
   - Keep consistent with existing docs page styling

2. **Create content file for marketing repo:**
   - File: `dex-aggregator 2.marketing/content/mev-protection-explainer.md`
   - Long-form (800-1200 words) educational piece suitable for blog/X thread
   - Tone: educational, not salesy. Factual, with comparisons to how other aggregators handle MEV
   - Key message: TeraSwap is the only aggregator that compares 11 sources including CoW and automatically routes through MEV-protected paths when pricing is competitive

**Do NOT**

- Name competitors negatively (keep it factual and educational)
- Make claims we can't back up (e.g., "zero MEV" — say "significantly reduced MEV exposure")
- Put marketing content in the main repo — the `.md` file goes to `dex-aggregator 2.marketing/`

**Files affected**

- `src/components/DocsPage.tsx` (add MEV section)
- `dex-aggregator 2.marketing/content/mev-protection-explainer.md` (new — marketing repo)

**Expected output**

- 1 commit for DocsPage update (main repo)
- 1 separate file for marketing content (marketing repo)

**Quality criteria**

- DocsPage MEV section renders correctly, consistent styling
- Marketing content is factually accurate, educational tone
- No competitor bashing, no unsubstantiated claims

---

## Prompt 74 — SwapWithFee topic hash V2 (9B-I-01)

**Status:** Pending

**Context:** Auditor finding 9B-I-01 (LOW). The on-chain monitor in `on-chain-monitor.ts` line 82 uses the V1 `SwapWithFee` topic hash with 5 parameters: `SwapWithFee(address,address,address,uint256,uint256)`. FeeCollector V2 emits a 7-parameter event: `SwapWithFee(address,address,address,uint256,uint256,address,uint256)` — adding `tokenOut` and `outputAmount`. The monitor currently misses all V2 swap info events (admin/critical events are unaffected).

**Objective:** Update the SwapWithFee topic hash to match the V2 event signature, and optionally keep the V1 hash for backward monitoring.

**Requirements:**

1. **Update topic hash in `on-chain-monitor.ts`:**
   - Change line 82 from: `SwapWithFee: topic('SwapWithFee(address,address,address,uint256,uint256)')`
   - To: `SwapWithFee: topic('SwapWithFee(address,address,address,uint256,uint256,address,uint256)')`
   - Add V1 hash as: `SwapWithFeeV1: topic('SwapWithFee(address,address,address,uint256,uint256)')`

2. **Update event parsing/classification:**
   - Ensure `SwapWithFee` (V2) is classified as `warning` for large swaps (existing behaviour)
   - `SwapWithFeeV1` from the V1 contract should also be classified as `warning`
   - Both topic hashes should be included in the FeeCollector getLogs filter

3. **Update tests:**
   - Any test mocking the SwapWithFee topic hash must use the V2 signature
   - Add test case for V1 hash still being detected from V1 contract logs

**Do NOT**

- Change any other topic hashes
- Modify alert routing logic
- Touch contract code

**Files affected**

- `src/lib/on-chain-monitor.ts` (topic hash + classification + filter)
- Test file(s) for on-chain-monitor if they exist

**Expected output**

- 1 commit with topic hash fix
- All existing tests pass + new test for V1 backward compat

**Quality criteria**

- V2 SwapWithFee events from `0x47f2...7459` are captured by monitor
- V1 SwapWithFee events from `0x4dAE...58eD` are still captured
- No change to admin/critical event monitoring

---

## Pre-audit checklist

Before passing Sprint 10 to the Auditor:

- [ ] Run `/ultrareview` on the sprint branch (first paid trial — evaluate finding quality)
- [ ] All 423+ tests passing
- [ ] `npm run build` succeeds
- [ ] `npx eslint src/` — 0 errors
- [ ] No new npm audit HIGH findings
- [ ] Branch protection rules applied by TeraHash (manual step, not in code)
- [ ] ERC-7730 metadata validated with CLI (Prompt 72 only after P68)

---

## Dependencies

```
P68 (FeeCollector V2 deploy)
  └── Prompt 72 (ERC-7730 — needs contract address)

All other prompts (69, 70, 71, 73, 74) can start immediately after P68.
```

---

## RICE Summary

| Item | Reach | Impact | Confidence | Effort | Score |
|------|-------|--------|------------|--------|-------|
| P69 Signed commits + branch protection | 10 | 3 | 70% | 0.5pw | 42.0 |
| P72 ERC-7730 clear signing | 8 | 2 | 85% | 0.5pw | 27.2 |
| P73 MEV educational content | 10 | 1 | 90% | 0.5pw | 18.0 |
| P70 MEV smart default | 8 | 2 | 80% | 1pw | 12.8 |
| P74 SwapWithFee topic hash V2 (9B-I-01) | 8 | 2 | 100% | 0.1pw | 16.0 |
| P71 MEV surplus display | 6 | 2 | 70% | 1.5pw | 5.6 |
