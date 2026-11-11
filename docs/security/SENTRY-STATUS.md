# Sentry status — not initialised (verified 2026-11-06, `fix/user-ip-privacy`)

**Sentry sends nothing from production today: not from the browser, not from the server.** This file states that
on purpose, because the repository looks as if it did (`@sentry/nextjs` is a dependency, three `sentry.*.config.ts`
files exist, `NEXT_PUBLIC_SENTRY_DSN` is documented) and the privacy copy depends on which is true.

## Why nothing is initialised

| Runtime | What would initialise it | State |
|---|---|---|
| Browser | `instrumentation-client.ts` (the only client hook Turbopack honours) — or webpack's injection of `sentry.client.config.ts` | No `instrumentation-client.ts` exists. `next build` uses Turbopack, which never injects `sentry.client.config.ts`. |
| Server / Edge | `instrumentation.ts` with a `register()` that imports `sentry.server.config.ts` / `sentry.edge.config.ts` | No `instrumentation.ts` exists, so neither file is ever loaded. |

`src/app/global-error.tsx` calls `Sentry.captureException`; with no client that call is a no-op.

## How it was measured

Production build with `NEXT_PUBLIC_SENTRY_DSN` set to a dummy DSN, then a search of the build output for that DSN:
0 files under `.next/static` (client) and 0 under `.next/server`, on `origin/main` (`fabaa30`) and on this branch.
The recon's headless capture saw no request to `*.ingest.sentry.io` either. Not verified: the Sentry project's own
inbox (owner: confirm no events arrive).

## What keeps it that way

- `src/lib/sentry-not-initialised.test.ts` fails if an `instrumentation*.ts` file appears, if a `sentry.*.config.ts`
  is imported from `src/`, or if `next.config.js` gains a `tunnelRoute`.
- The CSP (`csp-policy.js`) has no Sentry ingest host, so a browser SDK could not send even if it were initialised.
- The CI capture (`e2e/third-party-hosts`) fails on any third-party host.

## If Sentry is wanted later

That is a product decision with a privacy cost (error events carry the visitor's IP, user agent and URL to a third
party unless they are tunnelled through our own origin). It needs: `instrumentation-client.ts` + `instrumentation.ts`,
a same-origin `tunnelRoute`, IP scrubbing, an updated Privacy Policy §8, and an update to the three guards above.
**Do not enable it as a side effect of another change.**
