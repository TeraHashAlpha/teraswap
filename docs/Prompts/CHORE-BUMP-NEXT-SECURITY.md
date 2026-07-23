# CHORE-BUMP-NEXT-SECURITY — next.js 4× HIGH advisories: patch blocked by min-release-age, STOP (not forced)

> **Source:** owner directive 2026-07-23 — audit-gate fails repo-wide with 4 HIGH advisories, all in
> `next` (production framework, not dev tooling): SSRF (Server Actions + rewrites), DoS (Server
> Actions), middleware/proxy bypass. Legitimate framework security fixes — patch, do not allowlist.

## Finding

`npm audit --json` (locked at `next@16.2.9`) confirms all four advisories, plus five moderates, in a
single `next` range `>=16.0.0 <16.2.11`:

| Advisory | Severity | Title |
|---|---|---|
| GHSA-6gpp-xcg3-4w24 | HIGH | Middleware/proxy bypass (Turbopack + single locale) |
| GHSA-m99w-x7hq-7vfj | HIGH | DoS in App Router Server Actions |
| GHSA-89xv-2m56-2m9x | HIGH | SSRF in Server Actions on custom servers |
| GHSA-p9j2-gv94-2wf4 | HIGH | SSRF in rewrites via attacker-controlled destination hostname |

**Every one of the four is fixed ONLY at `next@16.2.11`** (the range end is identical across all
four advisories) — there is no earlier patch release that clears them. `npm view next time`:

```
16.2.10   2026-07-01T20:13:14Z   (dependabot PR #313's target — does NOT clear any of the 4; still <16.2.11)
16.2.11   2026-07-21T16:00:01Z   (clears all 4 — published 2 days before this chore, today 2026-07-23)
```

`.npmrc` sets `min-release-age=7`. `npm install next@16.2.11 --dry-run` confirms npm itself refuses
the install on that basis:

```
npm error code ETARGET
npm error notarget No matching version found for next@16.2.11 with a date before 16/07/2026, 17:33:59.
```

**Per this chore's own instruction — "if the required patch is <7d, note it and STOP rather than
force" — this chore stops here.** `next` is NOT bumped; `package.json`/`package-lock.json` are
unchanged. `audit-allowlist.json` is also unchanged (not touched, per Do NOT — these are legitimate
fixes, not allowlist candidates). `audit-gate` will continue to report these 4 as blocking until
either (a) `16.2.11` ages past `min-release-age` — **2026-07-28T16:00:01Z** — or (b) the owner
explicitly authorizes a `min-release-age` override for this one install.

**Recommended next step:** re-run this exact chore on or after 2026-07-28 — at that point
`next@16.2.11` installs cleanly under the existing policy with zero override needed.

## Reachability note (read-only assessment — we patch regardless; this is the honest risk record)

| Advisory | Reachable here? | Evidence |
|---|---|---|
| GHSA-6gpp-xcg3-4w24 (middleware/proxy bypass, Turbopack + single locale) | **No** | No `middleware.ts`/`middleware.js` exists anywhere in the repo (`find . -iname "middleware.*"` → empty) — there is no middleware to bypass. Also not i18n (`single locale` precondition doesn't even apply — no locale routing is configured). |
| GHSA-m99w-x7hq-7vfj (DoS, App Router Server Actions) | **No** | `grep -rn "'use server'" src/app` → zero matches. The app uses API Routes (`src/app/api/**/route.ts`) exclusively; no Server Action (`'use server'`) exists anywhere to target. |
| GHSA-89xv-2m56-2m9x (SSRF, Server Actions on custom servers) | **No** | Same as above (no Server Actions at all) **and** no custom server — `package.json` scripts are plain `next dev` / `next build` (no `server.js`/custom Express/Node entrypoint), deployed on Vercel's managed runtime. |
| GHSA-p9j2-gv94-2wf4 (SSRF, rewrites via attacker-controlled destination hostname) | **No** | `next.config.js` defines `redirects()` and `headers()` only — no `rewrites()` function exists in the config at all, let alone one with an attacker-influenced destination hostname. |

None of the four are reachable in this deployment (Vercel-managed, API routes only, no Server
Actions, no custom server, no rewrites, no middleware). This does not change the decision to patch —
`next` is the production framework and a security-first project patches its framework on principle,
not on a case-by-case exploitability bet — it is recorded here only as the honest risk context for
why the practical exposure window between now and 2026-07-28 is assessed as effectively zero.

## Do NOT

Allowlist these advisories (legitimate framework security fixes, not allowlist candidates); touch any
other dependency; modify `scripts/audit-gate.mjs`; force past `min-release-age`; open a PR.
