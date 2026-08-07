# Feedback — fix/signing-min-price-integrity

## Feedback — FIX-SIGNING-MIN-PRICE-INTEGRITY (4fa348b, f7dd729, e5c649f)

### Assumption that turned out wrong
- The spec's WETH price `1942.47` does **not** reproduce `5728680972022426` (it gives
  `5728668747491990`). Inverting the derivation instead pins a UNIQUE answer — both windows are one
  integer wide — at `pOut = 194246585493`, i.e. **$1942.46585493**, a raw Chainlink 8-dp reading
  whose implied ratio matches the spec's `1.853314` exactly. `1942.47` was a display rounding.
  Reproduction is exact; the test uses the precise value.

### Concern — scope, flagged for the Auditor
- D2 says "remove it from the signing inputs **at the call site**". I removed `approxPrice{In,Out}`
  from `DeriveSigningMinParams` entirely, so the policy is compiler-enforced rather than
  conventional. Deliberately broader than the letter; revert to a call-site-only change if the
  Auditor prefers the narrower diff.

### Security concern discovered during implementation
- **No CI guard job covers `v3-min-derivation`** (`.github/workflows/ci.yml` has no entry). This
  fund-flow module's tests — including the new regression suite — do not run in CI. Not fixed here:
  `ci.yml` is outside the spec's file list. Recommend a guard job before merge.
- D1 is not limited to the table: `in=defillama, out=chainlink` was also mislabelled `'chainlink'`,
  so any mixed live-source pair under-reported its weakest tier. Fixed and pinned symmetrically.

### Edge case
- `APPROX_PRICES` remains stale (`ETH: 3500` vs a live 1911.90) and still drives displayed USD and
  the DCA min-chunk dust guard. Out of scope here, recorded as follow-up 1 in the incident.
- Two pre-existing tests pinned the buggy behaviour and had to be rewritten, both outside the spec's
  file list: the approx-tier case in `v3-min-derivation.test.ts`, and — more tellingly —
  `DCAPanel.v3.test.tsx`, which asserted the decay warning stayed **hidden** when both live sources
  failed. That is the incident's UI symptom encoded as an expectation; it now asserts the warning is
  shown. Full suite 3197/3197 green.

### Not established
- Whether order `ef85438b` predates `35fac22` (2026-07-29), which gave `useChainlinkPrice` its
  composed-feed resolution and would have priced cbETH. Needs the order's `created_at`. The class of
  defect was open regardless.
