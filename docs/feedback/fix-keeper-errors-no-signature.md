# fix/keeper-errors-no-signature — feedback

Goal: A87 finding S-2 (audit of PR #709, pre-existing on origin/main). `redactError` printed viem's `err.message`, whose
`args:` carry the order's EIP-712 signature, to the keeper log and Telegram; long texts (> 4,096) were refused by Telegram.
Base: origin/main 7bd3ec12. Keeper code: Draft PR, **Auditor required**. Long tables: `fix-keeper-errors-no-signature.tables.md`.

## Owner answers (asked once, 2026-11-18; they supersede the goal text)

1. redactError output: `Name: shortMessage` (else first line) + decoded revert reason + viem's own `URL:`/`Status:`/`Details:`
   lines, then URL redaction, args/data/Request Arguments + 130+ hex scrub, 600 cap with marker. (Two existing tests,
   redact.test.mjs:105-114 and redact-s7-userinfo.test.mjs:55-58, pin those lines; a literal "first line only" breaks them.)
2. App: one shared scrub in `src/lib/alert-channels/utils.ts` (configured channel secrets by value, sanitizeUpstreamError
   rules, 130+ hex, cap 1,000) on the alert reason in all three outgoing bodies AND on the error each channel throws.
3. Extra keeper guards, both: a `0x`-prefixed 130+ hex scrub in `redactUrl` (fatal stack at executor.js:2665, alertOps
   details, final pass of every Telegram alert) and a cap below 4,096 in alert.js `sendTelegramAlert` after its final pass.

## Checklist

- [ ] 1. Inventory: every place error text reaches a log or alert (keeper + app), file:line
- [ ] 2. Step 0 tests, red on origin/main (9 viem cases leak a dummy signature; one alert > 4,096)
- [ ] 3. redactError rewrite (redact.js)
- [ ] 4. redactUrl `0x` hex scrub + capAlertText (redact.js)
- [ ] 5. monitor.js cap; alert.js final cap
- [ ] 6. Property test (seeded) + mutation proof (scratch copy)
- [ ] 7. App shared scrub + three-channel test
- [ ] 8. Keeper suite Node 20 + 22; vitest; agent-verify --keeper --codeql (once, load < 10); gen-claude-state --check
- [ ] 9. Push, compare link, evidence 1-5
