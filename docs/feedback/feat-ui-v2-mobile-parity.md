## Feedback — feat/ui-v2-mobile-parity (last v2 slice before the full v2 Auditor + production flag)

Owner decision (asked in-session, supersedes the goal text): **Limit and SL/TP stay "Soon" in v2** until a pane exists.
Premise that was false: the goal assumed every tab has a v2 pane. `AppShell` renders the skeleton `TabPane` for `limit`/`sltp`;
v1's LimitOrderPanel / ConditionalOrderPanel have 0 % of their text in v2, and the tab used to turn clickable when v1's `isLimitLive` is true.

### Checklist
- [ ] C1 whole-app parity sweep (Swap, Portfolio, DCA, Limit, SL/TP, Orders, History, Analytics, landing × chains 1/8453/42161)
- [ ] C1 TabBar: Limit/SL-TP stay disabled "Soon" regardless of `isLimitLive` (owner answer), test fails on main
- [ ] C2 mobile 375: no horizontal overflow per route (test), bottom sheets, tap ≥ 44 px, sticky CTA, credits in footer, reduced motion
- [ ] C2 Playwright screenshots 375 + 1440 per tab
- [ ] C3 A69b S-1 min-output bigint parity (it.each 1/8453/42161)
- [ ] C3 A69b S-2 confirmGated = `cta.disabled && cta.kind !== 'in-flight'`, shows cta.label
- [ ] C3 A70b S-1 Create-path gate test exercises Create, not only Retry
- [ ] C3 A70b S-2 priceKey stored in the review, review closes when it changes
- [ ] C3 A70b S-3 with ack, the review/409 tier is used, not the cached tier
- [ ] Verify: suite vs main, lint delta 0, tsc, build, v1 module-identical, rpc-budget guards, CodeQL (0 new)

### Evidence (filled in as each lands)
1. Parity output + consolidated delta table: _pending_
2. 375/1440 screenshots + overflow test: _pending_
3. Five Lows, test fails on main: _pending_
4. rpc-budget + CodeQL counts: _pending_
5. v1 proof: _pending_
6. Suite / lint / tsc / build / diff --stat / compare link: _pending_
