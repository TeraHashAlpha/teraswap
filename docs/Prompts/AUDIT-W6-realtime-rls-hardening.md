# AUDIT-W6-realtime-rls-hardening — make "anon can't read orders" safe-by-design (W6-M-01 realtime follow-up)

> **Source:** T-SAF W6-M-01 realtime follow-up (2026-07-01). Realtime does NOT leak today (the anon `orders` SELECT
> policy `wallet = jwt.sub` is unsatisfiable because the app never does Supabase Auth → zero delivery), so the
> channel is inert and users get updates via the #255-gated poll. But the guarantee is **accidental + lives in
> live-DB RLS state not in git**, and a future "make realtime work" change could re-open the leak on BOTH anon
> Realtime AND a direct anon `from('orders').select()` — bypassing the #255 REST gate. Turn it explicit. **DB/SQL +
> a small FE cleanup + a regression probe. No contract/app-runtime behaviour change (poll stays). Owner runs the SQL
> on live.** SSH-signed (noreply committer).

## Requirements
1. **`supabase/orders-rls-hardening.sql` (owner-run in the Supabase SQL editor, committed for record):**
   - **DROP** the anon SELECT policy `"Users read own orders"` on `orders` (it can never be satisfied — users are
     wallet-signature-authenticated, not Supabase-Auth users).
   - Add an **explicit deny-all-to-anon** on `orders` (RLS enabled, no anon policy → default deny; mirror the
     `circuit_breaker.sql` / `api-keys.sql` deny pattern + a comment stating the invariant). Server reads keep using
     the **service-role** key via the API (unaffected).
   - **Remove `orders` from the realtime publication:** `ALTER PUBLICATION supabase_realtime DROP TABLE orders;`
     (the channel is inert anyway; drop it so it can't be re-armed by a permissive policy). Header comment: re-add
     ONLY behind a wallet-authenticated channel (see req 3), never with an `anon`-readable policy.
2. **FE cleanup:** remove the dead client Realtime subscription for orders (`subscribeToOrders` in
   `src/lib/order-engine/supabase.ts` + its call in `src/hooks/useOrderEngine.ts`) since it delivers nothing and the
   poll drives updates — so no false "we have realtime" signal invites the regression. Keep the poll path intact.
3. **(Optional, do NOT implement now — document as the ONLY safe way to add live push):** a wallet-authenticated
   channel = issue a short-lived Supabase JWT with `sub = wallet` **only after** verifying the same read-signature
   #255 uses (so the `wallet = sub` policy scopes correctly), OR broadcast only non-sensitive fields (id, status)
   via a dedicated view/channel. Just document this; don't build it.
4. **Regression probe (the guarantee lives in DB state CI can't see):** add a smoke script + a scheduled/CI job that,
   with the **public anon key**, runs `from('orders').select('*').limit(1)` and a Realtime subscribe with a foreign
   `wallet=eq.<addr>` filter, and **FAILS if either returns any row/event**. Document that it needs the live
   `NEXT_PUBLIC_SUPABASE_URL` + anon key (a smoke test, not a unit test).
5. **Document the invariant** (in `docs/security/DEPLOYED-SOURCES.md` or a security note): *"No anon-key client can
   read another wallet's `orders` row over REST or Realtime; order strategy reads are gated (#255 read-token /
   service-role) — RLS is the transport-independent backstop."*

## Do NOT
- Don't break the app's poll-based order updates or the #255 gated service-role reads. Don't add a satisfiable anon
  SELECT policy without cryptographic wallet auth. Don't deploy the SQL (owner runs it on live). No contract change.

## Files affected (verify on main)
- New `supabase/orders-rls-hardening.sql`; `src/lib/order-engine/supabase.ts` (+ `useOrderEngine.ts`) remove
  `subscribeToOrders`; a new anon-probe script + CI/scheduled wiring; `docs/security/DEPLOYED-SOURCES.md` (invariant).

## Expected output
- Branch off latest `origin/main`; SSH-signed; CI green. The SQL exists (owner-run), the dead realtime subscription
  is removed (poll unaffected — test the order list still updates), the anon-probe FAILS if orders become
  anon-readable, and the invariant is documented. FEEDBACK: the exact SQL + the owner run-step + the probe command.

## Quality criteria
`orders` is explicitly deny-all-to-anon + out of the realtime publication; no dead anon realtime subscription; a
committed regression probe catches any future anon-readability of orders; the app's poll + #255 reads still work;
owner-run SQL documented; no contract/deploy change.
