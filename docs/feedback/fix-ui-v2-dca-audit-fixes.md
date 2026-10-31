# fix/ui-v2-dca-audit-fixes — feedback (A70 → fixes; Auditor re-check A70b follows)
Off origin/main `9096dc5`. Only `src/ui/v2/dca/**` + this file. Mocked tests; nothing signed or sent. **AUDITOR REQUIRED (signs orders).**

## Checklist (ticked as commits land)
- [ ] C1 M-1 — Create / Retry re-run `prepare()` (fresh gates, route check, tier, floor); Retry returns with consent unticked; price inputs in the draft key
- [ ] C2 L-1 — unparsed "Acknowledgement required…" 409 reopens consent at `unpriced`
- [ ] C3 L-2 — `Connect wallet` / `Switch to {chain}` recorded in the content-map deltas
- [ ] Evidence 1–4 below, verify run, push, compare link
