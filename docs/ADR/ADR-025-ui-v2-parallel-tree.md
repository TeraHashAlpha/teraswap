# ADR-025 — UI v2 ships as a parallel tree behind one server-side switch

- **Status:** Proposed
- **Date:** 2026-10-25
- **Implemented by:** `feat/ui-v2-foundation` (switch, tokens, primitives, dev kit — no pages yet)
- **Related:** ADR-012 (no new copyleft deps), `docs/feedback/feat-ui-v2-foundation.md` (measurements)
- **Fund-flow:** none. No contract, API-quote or wallet change; v1 renders byte-for-byte as before.

## Context
The Round 2 redesign replaces every page, not a few components. Editing v1 components in place would leave
`main` half-redesigned for weeks, and a long-lived redesign branch would rot against `main`. A build per UI
(two Vercel projects / deployments) would double CI minutes and split env + domains.

## Decision
1. **Parallel tree.** All v2 code lives under `src/ui/v2/**` (tokens, fonts, primitives, later pages) and v2
   routes under `src/app/v2/**`. Nothing in `src/lib`, `src/hooks`, wallet or v1 components is edited for v2;
   v2 imports the same logic, it does not fork it. `isolation.test.ts` fails if v1 source imports `ui/v2`.
2. **One switch, server-side only, in `src/proxy.ts`.** `v2` iff
   - `process.env.UI_V2_ENABLED === 'true'` (never `NEXT_PUBLIC_`, so it cannot be flipped from the client), or
   - cookie `ts_ui` carries `hex(HMAC-SHA256('v2'))` under the server secret `UI_V2_COOKIE_SECRET`, compared
     in constant time. A missing secret disables the cookie path (fail closed to v1).
   Anything else — absent, malformed, forged, wrong-secret — is `v1`. The rule is one pure function
   (`resolveUiVersion`) shared by the proxy, the admin route and `getUiVersion()`.
3. **v2 is a separate route, reached by rewrite.** For `v2`, the proxy rewrites `/` → `/v2` (URL unchanged).
   For `v1` it does nothing, so `app/page.tsx` stays byte-identical and `/` stays statically rendered. Direct
   requests to `/v2/*` without the env flag or a valid cookie get a **real HTTP 404** (the proxy rewrites to a
   path that does not exist); the `/v2` page also calls `notFound()` as defence in depth.
4. **Owner-only visibility.** `POST /api/admin/ui-version {version}` (Bearer `UI_V2_ADMIN_SECRET`, the same
   `verifyBearerToken` gate as the other admin routes) sets or clears the signed cookie
   (`HttpOnly; Secure; SameSite=Lax; Max-Age=30d`). Call it from the browser (same-origin `fetch`) so the
   `Set-Cookie` lands in that browser. `UI_V2_ENABLED=true` is set on Vercel **Preview only**.
5. **All-or-nothing launch.** v2 goes live for everyone by setting `UI_V2_ENABLED=true` on Production once every
   page is ready; there is no per-page or percentage rollout. Rollback = unset the variable.
6. **No extra builds.** One Next.js app, one Vercel project, one build; v1 and v2 are two trees in it.

## Rejected: switching inside `app/page.tsx` with `next/dynamic`
The first design (and the original brief) had `page.tsx` choose the tree with `next/dynamic`, so v2 chunks
"never ship to v1 visitors". Measured on the built app (Next 16.4.2 / Turbopack) this is false:
- With `next/dynamic` **and** with a conditional server-side `await import()`, the v1 HTML contained a
  `<script src>` for the `HomeV2` chunk and listed it in the flight payload.
- The client references for `HomeV1` and `HomeV2` carried the **same chunk list**: Turbopack bundles every
  client module reachable from a page's server graph into that page's client chunks, whichever branch renders.
- Reading the cookie in `page.tsx` also made `/` dynamic (`○` → `ƒ`, `Cache-Control: no-store`) once
  `UI_V2_COOKIE_SECRET` was set — a cost for every v1 visitor.
Only a separate route entry keeps v2 out of the v1 chunk set, hence the proxy rewrite. Numbers: FEEDBACK.

## Consequences
- **Positive:** `main` stays shippable; v1 is untouched until launch (page, chunks, static rendering); the owner
  can review v2 on production data with a cookie while visitors see v1.
- **Cost:** the proxy runs on `/` and `/v2/*` (Routing Middleware, before the cache). Direct `/v2` is a second
  URL for the same v2 home once the switch is on (launch clean-up: promote v2 to `/` when v1 is deleted).
  Each v2 page later needs a matching rewrite (`/swap` → `/v2/swap`, …) in the same proxy.
- The cookie value is deterministic per secret (a visibility toggle, not an identity). Rotating
  `UI_V2_COOKIE_SECRET` invalidates every issued cookie.
- **Revisit when:** v2 launches (delete v1 + the switch) or the switch needs per-user targeting.
