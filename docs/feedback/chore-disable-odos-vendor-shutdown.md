## Feedback — chore/disable-odos-vendor-shutdown (02915f5, 8ce66eb, 52cb59f)

### Edge case
- `src/components/SourceToggle.tsx` (`TOGGLEABLE_SOURCES`) lists every real
  adapter for the "N/M sources" user toggle — the prompt didn't name it, but
  it's a user-visible active-source list/count, so it fell under scope.
  Removed odos, updated its guard test (`SourceToggle.test.tsx`, was pinned
  to 12) to 11 and added an explicit `not.toContain('odos')` assertion.

### Concern
- `src/lib/monitored-endpoints.ts` still lists odos as a `critical: true`
  entry (`api.odos.xyz`), consumed by the separate H1/H2 tick loop in
  `src/lib/monitoring-loop.ts` (TLS+DNS integrity monitor, distinct from the
  `DISABLED_SOURCES`-gated quote path). Verified this is **not currently
  paging**: `source-state-machine.ts::recordHealthCheck` only alerts on a
  state *transition* (active→degraded→disabled), and odos is presumably
  already sitting in `disabled` state from the original auto-disable — further
  failures just increment a counter, no repeat alert. But the tick loop will
  keep making pointless network calls to a permanently-dead host forever, and
  `critical: true` means if the state machine's disabled→active auto-recovery
  ever mis-fires (e.g. the shuttered domain gets repurposed and starts
  returning 200s), it could re-page as a critical source. Left untouched —
  out of the prompt's explicit scope (only `DISABLED_SOURCES` was named as
  "the mechanism"), but the balancer precedent in this same file already
  downgrades a disabled source to `critical: false` rather than removing it;
  doing the same for odos (or removing the entry, matching that dead domains
  can't be DNS-hijacked into serving something worse) looks like a quick
  follow-up.
- `ODOS_API_KEY` env var reference in `src/lib/adapters/odos.ts` is now dead
  (adapter is never called) — left as instructed, not removed.
