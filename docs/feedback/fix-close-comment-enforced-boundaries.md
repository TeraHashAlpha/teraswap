# Feedback — fix/close-comment-enforced-boundaries

## L-1 — which route, and why

**Dropped the re-export from the barrel** (`src/lib/order-engine/index.ts`), not a scope-guard test.

Verified the #424 Auditor's enumeration myself before choosing: `grep -rl "ORDER_EXECUTOR_V3_BY_CHAIN" src` turned up exactly six files —
`config.ts` (the definition), `index.ts` (the re-export), and four test files
(`src/app/page.arbitrum-dark.test.tsx`, `src/hooks/useOrderApproval.v3.test.ts`,
`src/lib/dca-launch.arbitrum-activation.test.ts`, `src/lib/order-engine/config.test.ts`). No
production consumer outside `config.ts`. Also confirmed no namespace/`require`/dynamic-import form
reaches the map anywhere (`grep -rn "import \* as.*order-engine"` — empty), which is the specific
gap `usd-scope-guard.test.ts` already learned the hard way and I was told not to re-learn narrowly.

Given that, the stronger route is strictly better: a scope-guard test can only ever say "we noticed
you did the forbidden thing" after the fact, in the one file that thought to check; removing the
export from the public barrel makes the forbidden thing **not exist** — every future importer,
whether or not anyone remembers to add it to an allowlist, hits a compiler error naming the
offending identifier.

Two of the four test files (`page.arbitrum-dark.test.tsx`,
`dca-launch.arbitrum-activation.test.ts`) were **not** incidental — they import the raw map
specifically to prove an env var reached the module before trusting that the gated getter returns
null for it (the "vacuous pass" guard both files' own comments call out). `config.test.ts` and
`useOrderApproval.v3.test.ts` were already unaffected: the former imports from `./config` directly,
the latter only mentions the map name in a comment. So the two real consumers were switched to
import `ORDER_EXECUTOR_V3_BY_CHAIN` from `@/lib/order-engine/config` (the internal module) instead
of `@/lib/order-engine` (the public barrel) — same value, same invariant proven, just sourced from
the one place the map is meant to be read directly.

`config.ts` itself is untouched (`git status --short` confirms zero diff on it throughout this
branch) — only the barrel's export list and two tests' import lines changed.

## Acceptance results

**1. Prove L-1 bites.** Wrote a throwaway file importing the map from the barrel:
```ts
import { ORDER_EXECUTOR_V3_BY_CHAIN } from '@/lib/order-engine'
export const offending = ORDER_EXECUTOR_V3_BY_CHAIN
```
`npx tsc --noEmit`:
```
src/lib/order-engine/__l1-offender.ts(1,10): error TS2724: '"@/lib/order-engine"' has no exported
member named 'ORDER_EXECUTOR_V3_BY_CHAIN'. Did you mean 'ORDER_EXECUTOR_BY_CHAIN'?
```
Deleted the offender; `npx tsc --noEmit` returns clean again. ✅

**2. Prove the L-2 test fails on the exact regression it exists to catch.** Temporarily changed
`getOrderExecutorV3` in `config.ts` to skip the eligibility check:
```ts
export function getOrderExecutorV3(chainId: number): `0x${string}` | null {
  // TEMP: ignore the allowlist (acceptance-2 demonstration only)
  return ORDER_EXECUTOR_V3_BY_CHAIN[chainId] ?? null
}
```
`npx vitest run src/app/api/orders/orders-v3-eligibility-integration.test.ts`:
```
AssertionError: expected '0x5555555555555555555555555555555555555555' to be null
❯ expect(getOrderExecutorV3(42161)).toBeNull()
```
The test fails — but at its own sanity check, one line before the route composition it's actually
about. That's the design working as intended: the sanity assertion exists precisely so a broken
allowlist can never let the 400 assertion pass for the wrong reason (or not be reached at all,
since the route would now return 200 or a different error further down the pipeline). Restored
`config.ts` from a pre-edit backup; `git status --short src/lib/order-engine/config.ts` is empty,
and the suite passes 2/2 again. ✅

**3. No production behaviour changes.** `ORDER_EXECUTOR_V3_ELIGIBLE_CHAINS`, `getOrderExecutorV3`,
and `src/app/api/orders/route.ts` are all byte-identical to `origin/main` — `git diff` touches only
`src/lib/order-engine/index.ts` (export list), two existing test files' import lines, and one new
test file. `config.ts` has zero diff. ✅

**4. Full suite, lint, typecheck.** `npx vitest run`: **233 files / 3344 tests, all green**.
`npm run lint`: exit 0, 94 warnings (unchanged — same ceiling as `--max-warnings 94`, no new ones).
`npm run typecheck`: exit 0. ✅

## Notes

- The new integration test (`orders-v3-eligibility-integration.test.ts`) needed to mock
  `@supabase/supabase-js` and `@/lib/kv-rate-limiter` (matching the pattern every sibling test in
  this directory already uses) but deliberately mocks nothing in `@/lib/order-engine/config` — that
  omission is the entire point of the file. `getDcaFreezeState` and `bodySizeGuard` are left
  unmocked (as the pre-existing `orders-v3.test.ts`/`orders-create.validation.test.ts` already do);
  both fail open with no KV/env configured, and the 400 under test fires before either could matter.
- A positive control against Base (8453, the eligible chain) is included so the primary case
  can't be vacuously true (route always 400s regardless of chain) — it asserts only that the
  response is *not* the chain-eligibility 400, since this fixture's non-recoverable signature makes
  a full 201 unreachable without also standing up a real EIP-712 signer, which is out of scope for
  what L-2 asks this test to prove.
