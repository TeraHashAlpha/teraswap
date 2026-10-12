# Feedback — fix/codeql-log-injection

Goal: clear the log-injection / format-string CodeQL alerts (log calls only) with one shared sanitiser.

## Checklist
- [ ] 1 Sanitiser `src/lib/log-sanitize.ts` + test; reconcile rpc-chain-identity `forLog`
- [ ] 2 Apply at log calls (#8 #9 #15 #17–28 #39 #40 #57 #58 #4 #59 + cheap tooling)
- [ ] 3 #12 fingerprint-validator evidence (read-only)
- [ ] 4 Verify: suite vs origin/main, lint delta, tsc, diff --stat
- [ ] 5 Push + compare link

## Notes
- Premise: `docs/feedback/fix-codeql-log-injection.md` did not exist on origin/main; created here.
