# Sprint 21 — Monitoring-Loop Integration Tests for On-Chain Scan & Circuit Breaker

**Date:** 2026-05-18
**Architect:** Claude (Senior Architect)
**Closes:** 18-I-01 (mocks no-op suppress coverage of on-chain-monitor and circuit-breaker paths in tick)
**Branch:** `test/monitoring-integration` (single branch, single PR)
**Estimated effort:** ~0.1 pw (1 prompt)

---

## Motivation

Sprint 18 (P124) fixed the 18 failing monitoring-loop tests by adding 4 missing
`vi.mock()` declarations with no-op defaults. The auditor flagged 18-I-01 (INFO):
the no-op defaults mean the tick never exercises the branches where
`shouldRunOnChainScan` returns `true`, `runOnChainScan` returns results, or
`checkCircuitBreaker` returns a triggered result. Those modules have their own
unit tests, but the **integration** of those results into the tick return object
and the error-resilience of those paths within `runMonitoringTick()` are untested.

This sprint adds integration tests that use `mockResolvedValueOnce` to override
the no-op defaults per-test, exercising each path within the tick context.

**Deploy strategy:** Single branch `test/monitoring-integration`, one commit, one
PR. Test-only change — zero production code modified.

---

## RICE

| # | Scope | R | I | C | E (pw) | RICE | Pri |
|---|-------|---|---|---|--------|------|-----|
| 131 | Add integration tests for on-chain scan + circuit breaker in monitoring tick | 8 | 2 | 0.90 | 0.10 | 144.0 | P0 |

---

## Prompt 131 — On-Chain Scan & Circuit Breaker Integration Tests

**Context:** `src/lib/monitoring-loop.test.ts` has 18 passing tests covering H5 quorum wiring, alert path, and state transitions. The following mocks at L145-156 have no-op defaults:

```typescript
vi.mock('./on-chain-monitor', () => ({
  shouldRunOnChainScan: vi.fn().mockResolvedValue(false),
  runOnChainScan: vi.fn().mockResolvedValue(null),
}))

vi.mock('./circuit-breaker', () => ({
  checkCircuitBreaker: vi.fn().mockResolvedValue(undefined),
}))
```

The monitoring-loop integrates these at:
- **L226-235:** On-chain scan — `if (await shouldRunOnChainScan()) { result = await runOnChainScan() }`
- **L249-258:** Circuit breaker — `circuitBreakerResult = await checkCircuitBreaker(finalStatuses)`
- **L303-315:** Tick return — spreads `onChainScan` and `circuitBreaker` into result when present

To override per-test, you need references to the mock functions. Import them after the mocks:

```typescript
import { shouldRunOnChainScan, runOnChainScan } from './on-chain-monitor'
import { checkCircuitBreaker } from './circuit-breaker'
```

Then use `vi.mocked(shouldRunOnChainScan).mockResolvedValueOnce(...)` per-test.

**Objective:** Add a new `describe` block with integration tests covering the on-chain scan and circuit breaker branches within the monitoring tick.

**Requirements:**

Add a new `describe('on-chain scan & circuit breaker integration', () => { ... })` block after the existing test blocks. Include these test cases:

### T1 — On-chain scan result included in tick when shouldRunOnChainScan is true
```
setup: vi.mocked(shouldRunOnChainScan).mockResolvedValueOnce(true)
        vi.mocked(runOnChainScan).mockResolvedValueOnce({
          fromBlock: 19000000,
          toBlock: 19000100,
          eventsFound: 2,
          criticalCount: 0,
          warningCount: 1,
          infoCount: 1,
        })
assert: result.onChainScan is defined
assert: result.onChainScan.fromBlock === 19000000
assert: result.onChainScan.eventsFound === 2
assert: result.onChainScan.warningCount === 1
```

### T2 — On-chain scan skipped when shouldRunOnChainScan is false (default)
```
setup: (no overrides — use default mocks)
assert: result.onChainScan is undefined
assert: 'onChainScan' NOT in result (key absent, not just undefined value)
assert: runOnChainScan NOT called
```

### T3 — On-chain scan returns null → no onChainScan key in result
```
setup: vi.mocked(shouldRunOnChainScan).mockResolvedValueOnce(true)
        vi.mocked(runOnChainScan).mockResolvedValueOnce(null)
assert: 'onChainScan' NOT in result
```

### T4 — On-chain scan error is swallowed, tick completes
```
setup: vi.mocked(shouldRunOnChainScan).mockRejectedValueOnce(new Error('viem RPC timeout'))
        spy on console.warn
assert: tick completes (result.timestamp defined)
assert: 'onChainScan' NOT in result
assert: console.warn called with message containing 'On-chain scan failed'
```

### T5 — runOnChainScan error is swallowed, tick completes
```
setup: vi.mocked(shouldRunOnChainScan).mockResolvedValueOnce(true)
        vi.mocked(runOnChainScan).mockRejectedValueOnce(new Error('getLogs rate limited'))
        spy on console.warn
assert: tick completes (result.timestamp defined)
assert: 'onChainScan' NOT in result
assert: console.warn called with message containing 'On-chain scan failed'
```

### T6 — Circuit breaker result included in tick when triggered
```
setup: vi.mocked(checkCircuitBreaker).mockResolvedValueOnce({
          triggered: true,
          disabledCount: 7,
          totalSources: 11,
          disabledSources: ['1inch', '0x', 'velora', 'odos', 'kyberswap', 'sushiswap', 'openocean'],
          triggerReason: '7 of 11 sources disabled in 10-min window',
        })
assert: result.circuitBreaker is defined
assert: result.circuitBreaker.triggered === true
assert: result.circuitBreaker.disabledCount === 7
assert: result.circuitBreaker.disabledSources.length === 7
```

### T7 — Circuit breaker not triggered → no circuitBreaker key
```
setup: (no override — default mock returns undefined)
assert: 'circuitBreaker' NOT in result
```

### T8 — Circuit breaker returns non-triggered result → included in tick
```
setup: vi.mocked(checkCircuitBreaker).mockResolvedValueOnce({
          triggered: false,
          disabledCount: 2,
          totalSources: 11,
          disabledSources: ['velora', 'sushiswap'],
        })
assert: result.circuitBreaker is defined
assert: result.circuitBreaker.triggered === false
assert: result.circuitBreaker.disabledCount === 2
```

### T9 — Circuit breaker error is swallowed, tick completes
```
setup: vi.mocked(checkCircuitBreaker).mockRejectedValueOnce(new Error('KV read timeout'))
        spy on console.error
assert: tick completes (result.timestamp defined)
assert: 'circuitBreaker' NOT in result
assert: console.error called with message containing 'Circuit breaker check failed'
```

### T10 — Both on-chain scan AND circuit breaker results in same tick
```
setup: vi.mocked(shouldRunOnChainScan).mockResolvedValueOnce(true)
        vi.mocked(runOnChainScan).mockResolvedValueOnce({
          fromBlock: 19000000, toBlock: 19000100,
          eventsFound: 1, criticalCount: 1, warningCount: 0, infoCount: 0,
        })
        vi.mocked(checkCircuitBreaker).mockResolvedValueOnce({
          triggered: true, disabledCount: 6, totalSources: 11,
          disabledSources: ['1inch', '0x', 'velora', 'odos', 'kyberswap', 'openocean'],
          triggerReason: 'coordinated attack detected',
        })
assert: result.onChainScan is defined AND result.circuitBreaker is defined
assert: result.onChainScan.criticalCount === 1
assert: result.circuitBreaker.triggered === true
assert: tick has all standard fields too (timestamp, checksRun, failures, etc.)
```

**Total: 10 new test cases.**

**Implementation notes:**
- Add the mock function imports at the import block (after L164):
  ```typescript
  import { shouldRunOnChainScan, runOnChainScan } from './on-chain-monitor'
  import { checkCircuitBreaker } from './circuit-breaker'
  ```
- Use `vi.mocked()` to get type-safe access to the mock functions
- Each test must call `beginTick()` in beforeEach (follow existing pattern)
- `mockResolvedValueOnce` / `mockRejectedValueOnce` ensures no leaking between tests
- For console spy tests, use `vi.spyOn(console, 'warn')` or `vi.spyOn(console, 'error')` with `.mockImplementation(() => {})` and restore after

**Do NOT:**
- Change ANY production code (only the test file)
- Remove or modify existing tests
- Change the default mock return values (only use `Once` overrides per-test)
- Add new dependencies

**Files affected:**
- `src/lib/monitoring-loop.test.ts` (10 new test cases in new describe block)

**Quality criteria:**
- `npx vitest run src/lib/monitoring-loop.test.ts` → 28/28 pass (18 existing + 10 new)
- `npm test` → all pass (~756 total = 746 + 10)
- `npx tsc --noEmit` clean
- Zero changes to production code
- Every new test verifies tick completion AND the specific field presence/absence

---

## Execution order

Single prompt, single commit on `test/monitoring-integration`.

## Post-sprint checklist

- [ ] On-chain scan happy path, skip, null, and error paths tested within tick
- [ ] Circuit breaker triggered, not-triggered, non-triggered-result, and error paths tested
- [ ] Combined on-chain + circuit breaker tick tested
- [ ] Total test count ~756 (746 + 10)
- [ ] No production code changed
