# Feedback — fix/quote-limiter-music-toggle

Checklist (ticked as I go; final edit = evidence 1-4):

- [ ] C1 /api/quote limiter -> checkRateLimitWithin (A76b S-8) + test
- [ ] C2 /api/quote answers with a hung KV (< 5 s) + test
- [ ] C3 v2 music toggle: startBackgroundMusic() guard + tests a-d
- [ ] Verify: suite vs origin/main, lint delta 0, tsc, build, parity + rpc-budget, CodeQL 0 new
- [ ] Push + compare link
