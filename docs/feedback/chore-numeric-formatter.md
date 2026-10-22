# Feedback — chore/numeric-formatter

## Checklist
- [x] C1 `src/lib/format.ts` single formatter + table-driven tests (`format.test.ts`, 99 cases)
- [ ] C2 migrate display call sites + guard test
- [ ] Verify (suite / lint / tsc / diff --stat) + compare link

Baseline origin/main `dd1dffa`: 299 files / 4452 tests pass, lint 93 warnings (cap 94), tsc clean.

## 1. §3 rules (`~/Desktop/teraswap-round2-pack/README.md` lines 59-70; folder present, not empty)
- "Token amount ≥ 1: **4 dp** (`1.7183 USDC`). < 1: **4 significant digits, max 8 dp** (`0.00006792 WETH`). Below 1e-8: `<0.00000001`."
- "USD: `$` + 2 dp (`$0.03`). Below $0.01: `<$0.01`." · "Gas: **2 significant digits** in ETH, plus USD (`~0.0000081 ETH ($0.03)`). Never `0.0000`."
- "Percentages: up to 2 dp, trailing zeros trimmed" · "Addresses: lowercase `0x` + 4…4" · "Relative time: `2m ago`… Dates: `12 Oct 2026, 14:05`."

**§3 beat the goal text (per "§3 wins")**: ≥1000 is 4 dp (goal: 2 dp; §3 example `1 713.1810`, zero kept); floor is `<0.00000001` (goal: `< 0.0001`); `<$0.01` has no space (goal: `< $0.01`); §3 defines dates + relative time → `fmtDate`/`fmtRelTime` added.

## Premises / judgement calls
- Grep returns **52** files today (not 46), incl. `format.ts` itself; `format.ts` had **no test** (added).
- Trailing zeros: §3 keeps them for ≥1 (`1810`), is silent for <1 → goal's "trimmed" applied to <1 only (`0.5`, but `1.5000`). **Owner: confirm or flip.**
- `fmtAddress`: goal says checksum body (viem `getAddress`); §3 only says lowercase `0x`. Address call sites are not in the grep set → none migrated.
- Tiny/negative: `<0.00000001` / `<$0.01` are unsigned magnitude floors.
- Extras beyond goal list (needed by call sites): `fmtInt`, `fmtFixed`, `fmtGasCost`, `fmtUsd {compact}`, `fmtToken {exact}` (§3: raw 18 dp only in signing review/tooltip).
- `formatDisplay` marked `@deprecated`; `formatWithSeparator`/`stripSeparator` kept un-deprecated (input masking in SwapBox, not display output).
