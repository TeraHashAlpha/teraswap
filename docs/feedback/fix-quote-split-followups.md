# fix/quote-split-followups (**Auditor required**: rate limiting and which route Swap executes)

Follow-ups to PR #733 (audit A108: S-1 and the pre-existing list). Base: origin/main `68e817d0`. No limit number changes.

- [ ] 1. S-1: no split selected → the refresh is its own request; the route starts the main quote before the charge
- [ ] 2. The 429 wait follows `X-RateLimit-Reset`
- [ ] 3. A split switched off by hand stays off for that trade
- [ ] 4. One percent sign
- [ ] Each new test failing on origin/main first · differential · browser v1 and v2 · one verify run · push
