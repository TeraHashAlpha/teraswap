# Sprint 25B — Merge & Deploy Prompt

> **Sprint:** 25B (P141–P148 Hotfixes)
> **Branch:** `fix/quote-routing-and-sim`
> **Audit:** APPROVED — 0C/0H/0M/0L/5 INFO (see `Audits/SPRINT-25B-AUDIT.md`)
> **Date:** 2026-05-20

---

## Context

Sprint 25B resolves all swap execution failures discovered during production testing. The branch includes Sprint 24 (P134–P137), Sprint 25 (P138–P140), and Sprint 25B (P141–P148), all audited and approved. Production on `main` is currently broken for end users — swaps fail due to CORS, gas underestimation, and missing selectors/routers. This merge is urgent.

## Objective

Merge the branch to `main` and verify production deployment.

## Steps

### 1. Pre-merge verification
```bash
git checkout fix/quote-routing-and-sim
npx tsc --noEmit          # must be 0 errors
npx vitest run            # must be 839/839 passing
```

### 2. Merge to main
```bash
git checkout main
git merge fix/quote-routing-and-sim --no-ff -m "Merge fix/quote-routing-and-sim — Sprint 24+25+25B

Sprint 24 (P134-P137): Mobile UX + Execution History v2
Sprint 25 (P138-P140): FeeCollector revert parsing + simulation + MEV
Sprint 25B (P141-P148): CORS fix, gas floor, Augustus V6, source toggle, refresh button

Audit: APPROVED 0C/0H/0M/0L/5 INFO (Audits/SPRINT-25B-AUDIT.md)
839/839 tests passing. TypeScript clean."
```

### 3. Push to trigger Vercel production deploy
```bash
git push origin main
```

### 4. Post-deploy smoke test
After Vercel build completes (~2 min):
1. Open https://teraswap.app
2. Connect wallet (Ethereum Mainnet)
3. Test KyberSwap swap quote (ETH → USDC, any amount)
4. Test Uniswap V3 Direct swap quote
5. Test source toggle: disable Uniswap V3, verify it disappears from quotes
6. Test refresh button (⟳) next to countdown
7. Verify console has no CORS errors (`eth.merkle.io` should not appear)

### 5. Commit the audit report
```bash
git add Audits/SPRINT-25B-AUDIT.md
git commit -m "docs(audit): Sprint 25B audit — APPROVED 0C/0H/0M/0L/5 INFO

All swap execution failures resolved. KyberSwap + Uniswap V3 Direct working.
Velora pending FeeCollector V2 switch after router timelocks 2026-05-22."
git push origin main
```

## Do NOT
- Do NOT delete the branch yet (keep for reference until Sprint 26)
- Do NOT change `NEXT_PUBLIC_FEE_COLLECTOR` env var on Vercel yet (wait for timelocks)
- Do NOT revert P141 yet (wait for router timelock execution 2026-05-22)

## Expected Output
- `main` branch updated with all Sprint 24+25+25B commits
- Vercel production deploy successful
- Audit report committed to `main`
- Users can execute swaps on production

## Quality Criteria
- 839/839 tests passing on `main`
- TypeScript: 0 errors
- No CORS errors in browser console
- At least KyberSwap + Uniswap V3 Direct quotes returning successfully
