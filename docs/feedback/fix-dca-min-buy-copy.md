## Feedback — FIX-DCA-MIN-BUY-COPY (10ebb9c)

### Edge case
- The toast copy for the DCA per-buy floor doesn't actually live in `DCAPanel.tsx` — it's built in
  `useOrderEngine.ts`'s `createOrder` (the pre-sign client-side floor guard, ~line 647). The goal's
  file scope named "DCAPanel + the per-buy-minimum validation util" but the requirement ("inline
  warning and toast use the same copy") only reaches its second half via `useOrderEngine.ts`, so
  that file needed a read + edit too. Flagging since a stricter read-only interpretation would have
  left the toast on the old developer-speak string while the inline warning changed underneath it —
  the two would have drifted instead of unifying.
