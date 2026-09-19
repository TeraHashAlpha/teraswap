# Feedback — chore/erc7730-review-fixes

## Edge case
- `docs/erc7730/teraswap-feecollector-v2.json` was **not edited** — it already carried both fixes
  before this branch (v1-schema copy, different field labels/layout than the other two). Its
  `@.value` field was already `{ "format": "amount" }` with no params, and both `minimumOutput`
  fields (ETH and token) already had `nativeCurrencyAddress` — as a 1-element **array**, not the
  bare string the other two copies now use. Left as-is: no local schema file resolves that repo's
  external `$schema` URL, so there's nothing to lint it against here, and normalizing array→string
  would be a third, unrequested edit. Architect: worth a follow-up prompt to reconcile the two
  representations if the registry's `nativeCurrencyAddress` type is strictly `string`.

## JSON diff of the two fields (registry + the two identical teraswap copies)
```diff
- "minimumOutput": { ..., "params": { "tokenPath": "tokenOut" } }
+ "minimumOutput": { ..., "params": { "tokenPath": "tokenOut", "nativeCurrencyAddress": "0x0000000000000000000000000000000000000000" } }

- "@.value": { "format": "tokenAmount", "params": { "nativeCurrencyAddress": ["0xEeee...EEeE", "0x0000...0000"] } }
+ "@.value": { "format": "amount" }
```

## Registry checks (Repo A, pinned to CI's own versions)
- `uvx erc7730==1.0.10 lint registry/teraswap/calldata-TeraSwapFeeCollector.json` — same 7
  pre-existing warnings (missing display formats for 7 admin functions, out of scope), 0 errors,
  identical before/after.
- `uvx check-jsonschema==0.38.0 --schemafile specs/erc7730-v2.schema.json registry/teraswap/calldata-TeraSwapFeeCollector.json` — `ok`.
- `node .github/scripts/check-selector-coverage.js registry/teraswap/calldata-TeraSwapFeeCollector.json` — `0 of 1 descriptor(s) failed`.
- `uvx erc7730==1.0.10 format ...` — reflowed one line (`minimumOutput` object), no semantic change.
- Not run: the Sourcify/Rust clear-signing test runners (`.github/actions/run-{sourcify,rust}-tests`)
  — CI-only composite actions, no local binaries; the 3 checks above are what's runnable locally.

## sha256 (Repo B)
| File | Before | After |
|---|---|---|
| `contracts/clear-signing/erc7730-feecollector-v2.json` | `bd9ba652...dafb0e` | `0567f0da...88a882` |
| `contracts/clear-signing/registry-submission/calldata-TeraSwapFeeCollector.json` | `bd9ba652...dafb0e` | `0567f0da...88a882` |
| `docs/erc7730/teraswap-feecollector-v2.json` | `d346cbad...983298c4c` | unchanged (already fixed) |

The two identical-before copies stayed identical to each other after edit.

## Tests changed
Added to `src/lib/erc7730-descriptor.test.ts`, both new, nothing removed:
- `swapETHWithFee "@.value" field uses the amount format with no params`
- `swapTokenWithFee "minimumOutput" field resolves tokenOut === address(0) as native ETH`

Suite: 7 → 9 passing. Lint: 0 errors (unchanged, only lintable file in scope is the test file).
Typecheck: clean.

## For @fbwoolf on PR #2561
Pushed a fix commit addressing both review comments: `@.value` on `swapETHWithFee` now uses the
`amount` format instead of an unresolvable `tokenAmount`, and `minimumOutput` on `swapTokenWithFee`
now carries `nativeCurrencyAddress` so `tokenOut == address(0)` resolves as native ETH — ready for
re-review.
