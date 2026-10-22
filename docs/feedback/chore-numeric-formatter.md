# Feedback — chore/numeric-formatter

- [x] C1 `src/lib/format.ts` single formatter + `format.test.ts` (103 cases)  - [x] C2 call-site migration + guard test  - [x] verify

## 1. §3 (`~/Desktop/teraswap-round2-pack/README.md` L59-70; folder present)
"Token amount ≥ 1: **4 dp** (`1.7183 USDC`). < 1: **4 significant digits, max 8 dp**. Below 1e-8: `<0.00000001`." · "USD: `$` + 2 dp. Below $0.01: `<$0.01`." · "Gas: **2 significant digits** … Never `0.0000`." · "Percentages: up to 2 dp, trailing zeros trimmed" · "Addresses: lowercase `0x` + 4…4" · "Relative time: `2m ago`… Dates: `12 Oct 2026, 14:05`."
**§3 beat the goal text:** ≥1000 is 4 dp (not 2) · floor `<0.00000001` / `<$0.01` (no space) · dates + relative time are defined → `fmtDate`/`fmtRelTime` added.

## 2. Functions (real outputs; `·` = U+2009, `−` = U+2212)
| fn | examples |
|---|---|
| `fmtToken(v, dec?, {sign,exact})` | `1713.181`→`1·713.1810` · `0.00006792`→`0.00006792` · `1.5e18n`→`1.5000` · `1e-9`→`<0.00000001` |
| `fmtUsd(v, {sign,compact})` | `1234.56`→`$1·234.56` · `0.004`→`<$0.01` · `-12.3`→`−$12.30` |
| `fmtPct(v, dp=2, {sign})` | `0.1234`→`0.12%` · `0.3`→`0.3%` · `0.25`+sign→`+0.25%` |
| `fmtGas(eth)` / `fmtGasCost` | `0.0000012`→`0.0000012` · `0.0031`→`0.0031` · `(0.0000081,0.03)`→`~0.0000081 ETH ($0.03)` |
| `fmtAddress(a,{short})` | `0xd8da…96045`→`0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045` (checksum) · short→`0xd8dA…6045` · `undefined`→`—` |
| `fmtInt` / `fmtFixed(v,dp)` | `1234567`→`1·234·567` · `-12345`→`−12·345` · `(1234.5678,2)`→`1·234.57` |
| `fmtDate` / `fmtRelTime` | `12 Oct 2026, 14:05` · `5 Jan 2026, 03:07` · `2m ago` `3h ago` `5d ago` |
NaN/null/undefined/garbage → `—` everywhere. `formatDisplay`, `formatFeeUsd` marked `@deprecated`, not removed.

## 3. Migration — full per-file/line list with "display-only: yes": `docs/feedback/chore-numeric-formatter.migration.md`
37 of 52 files migrated (31 now clean). Kept, marked `numeric-format-allow:`: stored `outAmount` (SwapBox:377), input state parsed into signed orders (Limit/Conditional panels), SVG geometry. Not display, untouched: `src/app/api/**`, stored/ops lib files. Nothing signed/sent/compared/stored goes through `fmt*`; bigint inputs are read-only. Per-buy: DCAPanel now uses `perChunkRaw`+`fmtToken`, same as OrderReviewModal/OrbitStatRow.

## 4. Guard: `src/lib/format.guard.test.ts` scans components/app/hooks → **0 violations** (proved it fails on a planted `toFixed`).

## 5. Verify (vs origin/main `dd1dffa`)
Suite **4557/4557, 301 files** (base 4452/299; +105 tests, 15 expectations updated — all legitimate §3 string changes, listed in migration doc) · lint **93 = 93** · `tsc` clean · `git diff --stat origin/main`: **56 files, +677/−268 in src (incl. C1) + 2 new docs** · compare: https://github.com/TeraHashAlpha/teraswap/compare/main...chore/numeric-formatter

## Premises / owner decisions needed
- Grep gave **52** files, not 46; `format.ts` had no test. Extra read (not in list): `DigitRoller.tsx` (checked it renders non-digits as-is).
- Trailing zeros: kept at ≥1 (§3 `1810`), trimmed <1 (goal; §3 silent): `0.5` vs `1.5000`. **Confirm or flip.**
- Token K/M compaction removed (§3 has none); USD `compact` ($1.23M/$12.3K) kept for dashboards — §3 silent. Sub-cent asset prices/fees now `<$0.01`.
- Out of grep scope, still locale-dependent: `toLocaleDateString/TimeString` (SwapBox history date, Cow deadline, DCAPositionStats date) and ad-hoc `…ago` helpers. Address sites not migrated (not in set). Follow-up?
- `toFixed` is float-based (`0.35`→`0.3`), same as before.
