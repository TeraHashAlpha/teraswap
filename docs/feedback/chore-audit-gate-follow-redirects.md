# Feedback — chore/audit-gate-follow-redirects

Measured 2026-10-31 ~11:30 WET, base origin/main `9096dc5`, `.npmrc` min-release-age=7.

## Checklist
- [x] Commit 1: facts
- [ ] Commit 2: decode-uri-component override + allowlist entry deleted; follow-redirects allowlisted
- [ ] audit-gate exit 0, suite vs origin/main, build, lint delta 0
- [ ] Push + compare link

## 1. Facts

| Package | Installed | Advisory (range → patched) | Patch published | Age | Rule → action |
|---|---|---|---|---|---|
| follow-redirects | 1.16.1 (existing `overrides` pin, exact) | GHSA-mrwp-f3q8-3g9p, `>=1.16.0 <=1.16.1` → **1.16.2** | 2026-10-25T21:32Z | 5.6 d (<7) | allowlist, expires 2026-11-01 |
| decode-uri-component | 0.5.0 (existing `overrides` pin) | GHSA-qr28-fpjm-wq7f, `<=0.5.0` → **0.5.1** | 2026-10-23T12:48Z | 7.9 d (≥7) | override → 0.5.1, delete allowlist entry |

Dependents (one path each, both client-side transitive):
- follow-redirects: wagmi > @wagmi/connectors > @base-org/account > @coinbase/cdp-sdk > axios@1.20.0 (overridden) > follow-redirects
- decode-uri-component: wagmi > @wagmi/connectors > @walletconnect/ethereum-provider > @walletconnect/utils > query-string@7.1.3 > decode-uri-component

## Findings
- The brief's premise "follow-redirects has no override yet" does not apply: an exact pin `1.16.1` already exists and is itself inside the vulnerable range. The rule still gives the same answer (patch < 7 d → allowlist); the pin must be bumped to 1.16.2 once it passes 7 d, i.e. after **2026-11-01T21:32Z**.
- `audit-gate.mjs` never reads `expires`; it only reads `ageInOn` (absent on all entries), so allowlist expiry is not enforced by the gate and the stale-entry nudge never fires. Follow-up candidate, not changed here.
