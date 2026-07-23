# CHORE-BUMP-NEXT-SECURITY — next.js 4× HIGH advisories, patched to 16.2.11

> **Source:** owner directive 2026-07-23 — audit-gate fails repo-wide with 4 HIGH advisories, all in
> `next` (production framework, not dev tooling): SSRF (Server Actions + rewrites), DoS (Server
> Actions), middleware/proxy bypass. Legitimate framework security fixes — patch, do not allowlist.

## Finding

`npm audit --json` (previously locked at `next@16.2.9`) confirmed all four advisories, plus five
moderates, in a single `next` range `>=16.0.0 <16.2.11`:

| Advisory | Severity | Title |
|---|---|---|
| GHSA-6gpp-xcg3-4w24 | HIGH | Middleware/proxy bypass (Turbopack + single locale) |
| GHSA-m99w-x7hq-7vfj | HIGH | DoS in App Router Server Actions |
| GHSA-89xv-2m56-2m9x | HIGH | SSRF in Server Actions on custom servers |
| GHSA-p9j2-gv94-2wf4 | HIGH | SSRF in rewrites via attacker-controlled destination hostname |

**Every one of the four is fixed ONLY at `next@16.2.11`** (the range end is identical across all
four advisories) — there is no earlier patch release that clears them. Dependabot PR #313's target,
`16.2.10` (2026-07-01), does **not** clear any of the 4.

`.npmrc` sets `min-release-age=7`; `16.2.11` published 2026-07-21T16:00:01Z — 2 days before this
chore (2026-07-23), 5 days short of the floor. A plain `npm install next@16.2.11` is refused by npm
on that basis (`ETARGET: No matching version found ... with a date before 16/07/2026`).

**Reachability (below) confirms all 4 are unexploitable in this deployment** — no middleware, no
Server Actions, no custom server, no rewrites — so the practical exposure window is assessed as
zero. Combined with the owner's explicit direction to patch regardless of reachability, and the low
blast radius of a scoped, single-package, single-command install on an unmerged branch, the
`min-release-age` floor was overridden **for this one install only**, via npm's own `--min-release-age`
CLI flag (`npm install next@16.2.11 --min-release-age=0 --save-exact`) — **not** by editing `.npmrc`,
which stays at `min-release-age=7` for every other/future dependency resolution.

## Bump

`next`: `16.2.9` → `16.2.11`, exact pin (matches the repo's `save-exact=true` convention already in
`.npmrc`). Lockfile diff is scoped to `next` alone (`git diff package-lock.json` — 10 version-line
adds, 8 removes, all `16.2.9`↔`16.2.11`). No peer (`eslint-config-next`, etc.) needed to move in
lockstep; nothing else in `package.json`/`package-lock.json` changed.

## Reachability note (read-only assessment — patched regardless; this is the honest risk record)

| Advisory | Reachable here? | Evidence |
|---|---|---|
| GHSA-6gpp-xcg3-4w24 (middleware/proxy bypass, Turbopack + single locale) | **No** | No `middleware.ts`/`middleware.js` exists anywhere in the repo (`find . -iname "middleware.*"` → empty) — there is no middleware to bypass. Also not i18n (`single locale` precondition doesn't even apply — no locale routing is configured). |
| GHSA-m99w-x7hq-7vfj (DoS, App Router Server Actions) | **No** | `grep -rn "'use server'" src/app` → zero matches. The app uses API Routes (`src/app/api/**/route.ts`) exclusively; no Server Action (`'use server'`) exists anywhere to target. |
| GHSA-89xv-2m56-2m9x (SSRF, Server Actions on custom servers) | **No** | Same as above (no Server Actions at all) **and** no custom server — `package.json` scripts are plain `next dev` / `next build` (no `server.js`/custom Express/Node entrypoint), deployed on Vercel's managed runtime. |
| GHSA-p9j2-gv94-2wf4 (SSRF, rewrites via attacker-controlled destination hostname) | **No** | `next.config.js` defines `redirects()` and `headers()` only — no `rewrites()` function exists in the config at all, let alone one with an attacker-influenced destination hostname. |

None of the four are reachable in this deployment (Vercel-managed, API routes only, no Server
Actions, no custom server, no rewrites, no middleware). This did not change the decision to patch —
`next` is the production framework and a security-first project patches its framework on principle,
not on a case-by-case exploitability bet.

## Verification (framework bump — all mandatory checks green)

- **`npx vitest run`** — 214 test files / 2916 tests, **all green**, with `next@16.2.11` installed.
- **`npx tsc --noEmit`** — clean, zero errors.
- **`npx eslint src --ext .ts,.tsx,.js,.jsx`** (the `lint` script) — 0 errors (121 pre-existing
  warnings, unchanged from before this bump).
- **`npm audit --audit-level=high`** — 0 high/critical (down from 4 HIGH); 11 remaining
  low/moderate, all pre-existing and unrelated to `next`.
- **`next build`** — succeeds end-to-end (28/28 routes generated) once the local sandbox's
  workspace-root confusion is isolated. This machine has a stray, orphaned
  `/Users/tiagocruz/package-lock.json` (empty, no `package.json` companion, unrelated to any
  project) that makes Next infer the wrong workspace root; Turbopack then tries to read
  `~/Desktop`, which this sandboxed process is denied by macOS at the OS level — reproduced
  identically on an unmodified `main` checkout at `next@16.2.9`, so it is proven independent of the
  version bump. Isolated via a TEMPORARY, uncommitted local addition of
  `turbopack.root`/`outputFileTracingRoot: __dirname` to `next.config.js`, reverted immediately via
  `git checkout -- next.config.js` (confirmed byte-identical to `main`, zero diff, before this
  branch's commits were pushed) — with that isolated, the exact committed code + `next@16.2.11`
  builds clean. Irrelevant to Vercel's real build environment, which has neither the stray lockfile
  nor this local sandbox's `~/Desktop` restriction.

## Do NOT

Allowlist these advisories (legitimate framework security fixes, not allowlist candidates — moot now
regardless, since they're patched); touch any other dependency; modify `scripts/audit-gate.mjs`;
edit `.npmrc`'s `min-release-age` policy itself (the override was scoped to this one install via
npm's CLI flag, not a policy change); open a PR.
