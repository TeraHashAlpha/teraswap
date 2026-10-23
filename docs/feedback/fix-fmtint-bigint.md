# fix/fmtint-bigint — FEEDBACK

Symptom: Footer shows "Base · Block #0" (`useBlockNumber` → bigint → `fmtInt` scaled it as an 18-dp token amount).

## Checklist
- [ ] C1 `toFiniteNumber` default `decimals` 18 → 0; `FmtInput` JSDoc rule; format.test + Footer.test
- [ ] C2 call-site audit + regression tests
- [ ] Verify (suite vs origin/main, lint delta, tsc, diff --stat), push, compare link

## Deviations (recorded)
- Out-of-list read: grep-only of `fmtUsd|fmtPct|fmtGas|fmtGasCost` call sites, to prove no caller relied on bigint→18-dp scaling (none passes a bigint). Needed to apply the rule to those formatters safely.
- Goal says `fmtInt`/`fmtFixed` call `toFiniteNumber(value, 0)`; the root cause is the `= 18` default at :74, so it is changed there (same effect for those two, and also fixes `fmtUsd`/`fmtPct`/`fmtGas`, which take no `decimals`). `fmtToken` already passes `decimals` explicitly.
- Goal's "52 656 825" uses plain spaces; the §3 spec separator is U+2009, so tests assert U+2009.
