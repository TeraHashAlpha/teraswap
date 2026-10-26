# Feedback — chore/copy-leftovers

Display/copy/plumbing only. No tier, gate, quote or pricing logic; nothing under `src/ui/v2`.

- [x] C1 one price notice, from the tier
- [ ] C2 source counts that mean something
- [ ] C3 help-content leftovers
- [ ] C4 token-logo rate limit + CSP + Velora labels
- [ ] C5 flaky `usePortfolio` test
- [ ] Verify + evidence 1–6

## Premise check
- The blue "No oracle available…" notice was in `SwapBox.tsx` (else-branch of the `oracleUnavailable` block), not
  `QuoteBreakdown.tsx`; QuoteBreakdown only holds the tier notices. Same notice, wrong file in the goal — proceeded.

## 1. Notice matrix (pair with no Chainlink feed, 5 units; real SwapBox + real QuoteBreakdown)
| tier | before | after |
|---|---|---|
| priced | blue | none |
| single-source | blue + amber | amber |
| unpriced | blue + "No reference price" | "No reference price" |
| unknown (null) | blue | none |
Before = the new matrix test run against unfixed SwapBox: 4/4 failed with `legacyBlue: true`. The USD-gate notices
(amber "high value swap", red "Swap blocked") are separate and untouched. Static guard:
`no-legacy-oracle-notice.test.ts` (no such string under `src/components`).
