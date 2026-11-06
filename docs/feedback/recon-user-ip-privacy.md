# Feedback — recon/user-ip-privacy (READ-ONLY recon, no source edits)

Owner question: is the user's IP hidden from third parties on teraswap.app? Help copy says "IPs never exposed" (backlog 68).

## Task checklist
- [x] Branch `recon/user-ip-privacy` cut from `main`
- [ ] Read scoped files: wagmiConfig, rpc*, chains/**, /api/rpc, /api/token-logo, next.config.js CSP, sw.js, Sentry/analytics/WC init, usePortfolio, Docs/Legal/help claims
- [ ] Headless-Chromium host capture, v1 + v2, Ethereum/Base/Arbitrum, disconnected (+ connected via mock)
- [ ] Server-side IP retention (trustedClientIp, rate-limit keys, Supabase)
- [ ] Per-claim true/false/partly table
- [ ] Report in chat + push + compare link
