# fix/keeper-low-findings — feedback (A71b S-1..S-4, A73d L-1..L-2)

Base origin/main `f7c4887` (PR #656 merged). Auditor-note: keeper code, Lows only — owner opens the PR as DRAFT.
Compare: `main...fix/keeper-low-findings` (link in the final report).

## Checklist
- [ ] S-1 pause clears only when NO origin has an open streak (+ watcher `poll` success report)
- [ ] S-2 state dir: lstat, refuse symlink, O_NOFOLLOW on the gate file
- [ ] S-3 redactor: glued scheme (leftmost), `%2F` / `/` / `&#x2F;` decoded first
- [ ] S-4 runbook inventory `grep -iF` + upper-case runbook test
- [ ] L-1 collectErrorText bounded at collectErrorMeta's depth
- [ ] L-2 auth check sees through InternalRpcError (-32603 + auth words ⇒ rpc-auth, still infra)
- [ ] Both Nodes 0 cancelled · full suite · lint/tsc · CodeQL · evidence 1-4 below

## Process notes
- Node 20.20.2 / 22.23.4 are not on the host: official darwin-arm64 tarballs, SHA-256 checked against
  nodejs.org SHASUMS256, unpacked in the session scratchpad (nothing installed on the host).
- Extra read (premise check for S-1, grep + 2 line ranges): `onRpcSuccess/onRpcError` call sites in
  `event-watcher.js` / `executor.js`. Finding: the watcher tags the log-processing phase `event-watcher:poll`
  (`event-watcher.js:242`) but never reports a success under that origin.
