## Feedback — fix/source-health-relative-baselines

### Edge case
- All kv-backed state this fix introduces (`known-sources` set, per-source
  `known-quoting` TTL flag, per-source `zero-win-streak` counter) starts
  empty/zero on first deploy. Two transient consequences, both self-resolving
  within a few windows and neither requiring action:
  - `silence` won't fire for ANY source until it's been observed quoting at
    least once post-deploy (nothing is "previously-quoting" yet).
  - `drift` (the K-consecutive-zero-win-windows check) needs
    `DRIFT_ZERO_WIN_STREAK_WINDOWS` (3) fresh windows to accumulate before it
    can fire, even for a source that was already dead-weight before deploy.

### Concern
- None outside the above — the detector is otherwise pure/synchronous-testable
  and the acceptance snapshot (six-row production data) is asserted to
  produce zero findings.
