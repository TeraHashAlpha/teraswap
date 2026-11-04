## Feedback — fix/codeql-b1-b2 (CodeQL recon 82, batches B1+B2)

No PR. Base `origin/main` @ `3a78d86`. Baseline (full `javascript-security-extended`, `scripts/codeql-local.sh`): **19** alerts, identical to the recon.

- [ ] C1 B1 — #86 `rpc-env.ts` log injection + tests
- [ ] C2 B2 — #34 #13 #14 #42 #54 #30
- [ ] Full-suite CodeQL after · vitest vs main · lint delta · tsc · build
- [ ] Evidence 1–4 below, branch pushed + compare link

### Notes
- `capture-endpoint-baseline.ts` carries #14 (B2) **and** #11 (B3, TLS capture). Only the #14 write site is edited; the line-54 TLS code is untouched.
