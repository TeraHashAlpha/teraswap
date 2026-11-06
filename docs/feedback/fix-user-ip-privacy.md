# Feedback — fix/user-ip-privacy

Base: origin/main `fabaa30`. Recon: `docs/feedback/recon-user-ip-privacy.md` (origin/recon/user-ip-privacy `482f309`).
Owner goal: "this site never sends the user's IP to a third party" is TRUE for everything the site controls, and the
copy says plainly what the wallet does on its own. DRAFT PR, Auditor required (RPC proxy + rate limiting).

## Checklist
- [ ] C1 L2 reads through `/api/rpc?chainId=` (wagmi + clients.ts), allow-list, batch cap, per-call limit, 1–2 s cache
- [ ] C2 imported-token + portfolio logos → `/api/token-logo`; WalletConnect page-load telemetry/config off
- [ ] C3 CSP: connect-src 'self' + exact wallet hosts; img-src 'self' data: blob:; remotePatterns dropped; CI capture job
- [ ] C4 rate-limit keys + log lines use HMAC(IP, daily salt); four raw-XFF routes → trustedClientIp; Sentry statement
- [ ] C5 honest copy, v1 == v2 (Help, Docs, Privacy §3.2/§5/§8, product-claims) + content-map delta
- [ ] Verify: suite vs origin/main, lint delta 0, tsc, build, v1/v2 parity, rpc-budget, capture, CodeQL 0 new
- [ ] Evidence 1–6 below; branch pushed; compare link

## Findings (filled as found)

## Evidence (filled as measured)
