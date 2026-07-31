# Feedback — FIX-DEPEG-GATE-HANDLER-TEST-COVERAGE (L-1)

## The mechanism, verified empirically before writing the fix

Confirmed by direct experiment (throwaway probes under `src/`, deleted after): `fireEvent.click` on
a disabled `<button>` never reaches its `onClick` at all. More importantly, this is **not** a DOM-
attribute issue — manually clearing `button.disabled` (both `removeAttribute('disabled')` and
`.disabled = false`) on the live node still does not let the click through. React's own event
dispatcher checks its **fiber-cached `disabled` prop** before invoking a click-type handler,
independent of the actual DOM state. So no amount of DOM manipulation fixes this; the only way to
genuinely exercise the handler is to invoke the React-attached `onClick` prop directly.

## Fix: `clickBypassingDisabled(el)`

Added identically to all three test files. Reads the `__reactProps$*` key React itself attaches to
the DOM node and calls `.onClick({})` directly — the exact closure the component rendered, over
that render's real state (`depegBlocking` computed fresh from the mocked `useDepegCheck` return).
Test-only reflection; no production file touched.

## Tests added (one per panel, existing tests left untouched)

- `src/components/DCAPanel.test.tsx:385` — `[L-1] the production handler itself refuses to create
  an order while blocked — not merely the disabled attribute`
- `src/components/LimitOrderPanel.test.tsx:248` — `[L-1] the production handler itself refuses to
  submit while blocked — not merely the disabled attribute`
- `src/components/ConditionalOrderPanel.test.tsx:213` — same title, SL/TP panel

## Mutation-check — and a finding worth flagging

Limit and SL/TP: deleting the in-handler guard (`if (depegBlocking) { setSubmitError(...); return
}`) makes **only the new `[L-1]` test fail** (1/1 each) — the old forced-click test still passes
trivially, since it never ran the handler in the first place. This is exactly the gap the audit
flagged, now closed for both panels.

**DCA is different, and I want to report it precisely rather than claim a clean mutation-kill that
doesn't hold.** DCA's `canCreate` boolean already includes `&& !depegBlocking`
(`DCAPanel.tsx:546`), and `handleCreate`'s first line is `if (!canCreate || ...) return`
(`DCAPanel.tsx:559`) — which fires *before* the standalone `if (depegBlocking) return`
(`DCAPanel.tsx:563-566`) is ever reached. Two-part mutation check confirms this precisely:

- Deleting **only** the standalone `if (depegBlocking) return` line → **all 19 DCA tests still
  pass**, including the new `[L-1]` test. That line is dead code today — `canCreate`'s own clause
  already blocks first.
- Deleting `&& !depegBlocking` from `canCreate` (leaving the standalone line intact) → **4 tests
  fail, including `[L-1]`**. This is the operative guard for DCA's reachable code path.

So the new DCA test does genuinely catch a regression — just not the specific redundant line the
finding's title suggests; it catches removal of `canCreate`'s `!depegBlocking` clause, which is
where the real protection lives for this panel. I did not touch DCA's production code (out of
scope), so the redundancy stands as-is; flagging it here rather than silently reporting a mutation
result that doesn't match what actually happened.

## Verify

`tsc --noEmit` → 0 new errors (2 expected pre-existing). `npm run lint` → 0 errors, 124 warnings
(unchanged from the branch baseline — no new warnings from these test-only additions). `npm test`
→ **3072 passed** (+3), 1 expected pre-existing `cuer` suite failure.
