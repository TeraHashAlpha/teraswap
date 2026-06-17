# WC/Reown audit-gate failure — triage & remediation (2026-06-16)

**Branch:** `chore/wc-reown-advisory` · **Prompt:** `docs/Prompts/CHORE-WC-REOWN-ADVISORY.md`
**Status:** remediated — audit gate green. **Requires Architect sign-off before merge** (sensitive WC/wagmi stack; touches the CI audit gate + supply-chain policy boundary).

---

## TL;DR

`npm audit --audit-level=high` started failing on the **unchanged** root lockfile (newly-published
advisories), turning `main` red and blocking every PR (e.g. #194). The gate is now green via:

- **Override (preferred fix, fully applied):** `ws` → 7.5.11 / 8.21.0, `hono` → 4.12.25 — both patches are
  installable under `.npmrc min-release-age=7`.
- **Allowlist (spec fallback):** `form-data` (GHSA-hmw2-7cc7-3qxx) + `vite` (GHSA-fx2h-pf6j-xcff) — their
  patches are published but **<7 days old**, so they are blocked by our own `min-release-age=7` for a few more
  days. Allowlisted with dated TODOs to convert to overrides once they age in.

Hard constraints all held: wagmi stays 2.19.5, RainbowKit stays 2.2.10, `ua-parser-js` stays 1.0.41 (MIT, not
2.x AGPL), exactly **one** `@walletconnect/core@2.21.1`, no new copyleft transitive.

---

## ⚠️ Correction to the prompt's framing

The prompt states the 4 HIGH advisories are `@reown/appkit-*` (`<=1.8.9`) via `@wagmi/connectors`. **That is
not what the audit reports.** The 4 HIGH are `form-data`, `hono`, `vite`, `ws` (verified against the live CI
log of #194 and a fresh `npm audit`). The `@reown/appkit-*` / `@walletconnect/*` chain is the **moderate**
bulk (the "Depends on vulnerable versions of …" lines), not the highs. Totals: `34 → 19` (1 low, 16 moderate,
**2 high remaining**, both allowlisted). The remediation therefore targets the real high packages, not
`@reown/appkit`.

---

## The 4 HIGH advisories

| # | Package | Advisory | Vuln range | Fixed in | Pulled by | On TeraSwap runtime path? | Disposition |
|---|---------|----------|------------|----------|-----------|---------------------------|-------------|
| 1 | `ws` | [GHSA-96hv-2xvq-fx4p](https://github.com/advisories/GHSA-96hv-2xvq-fx4p) — memory-exhaustion DoS | `7.0.0-7.5.10 \|\| 8.0.0-8.20.1` | 7.5.11 / 8.21.0 | `@walletconnect/jsonrpc-ws-connection` (ws 7.x); `@walletconnect/utils`, `engine.io-client`, `isows` (ws 8.x) | **No** — the DoS is against a **ws server** receiving tiny fragments; TeraSwap is a ws **client**, and in the browser WalletConnect uses the **native** `WebSocket` (the `ws` package is the Node shim, not executed client-side). | **OVERRIDE** |
| 2 | `hono` | [GHSA-88fw-hqm2-52qc](https://github.com/advisories/GHSA-88fw-hqm2-52qc) — CORS mw reflects any Origin w/ credentials on wildcard | `<=4.12.24` | 4.12.25 | `porto@0.2.35` → `@wagmi/connectors` | **No** — `hono` is a server framework inside the Porto connector; the CORS-credential reflection needs a running Hono server with a wildcard-defaulted CORS config. Not instantiated on TeraSwap's path (we use the RainbowKit UI, not Porto's server). | **OVERRIDE** |
| 3 | `form-data` | [GHSA-hmw2-7cc7-3qxx](https://github.com/advisories/GHSA-hmw2-7cc7-3qxx) — CRLF injection via unescaped multipart field names | `4.0.0-4.0.5` | 4.0.6 | `axios@1.16.0` → `@coinbase/cdp-sdk` → `@base-org/account` → `@wagmi/connectors` | **No** — requires attacker-controlled multipart field names/filenames; TeraSwap drives no user-controlled multipart uploads through the Coinbase SDK. | **ALLOWLIST** (fix <7d old) |
| 4 | `vite` | [GHSA-fx2h-pf6j-xcff](https://github.com/advisories/GHSA-fx2h-pf6j-xcff) — `server.fs.deny` bypass on Windows | `8.0.0-8.0.15` | 8.0.16 | `vitest@4.1.8` (dev) | **No** — **dev-only** (test runner). `vite` is never in the production bundle (the app builds with Next.js). The vuln is a vite **dev-server** issue on Windows. | **ALLOWLIST** (fix <7d old) |

**Net runtime-path assessment:** none of the 4 highs is on TeraSwap's production runtime path. This is
consistent with the prior Dependabot baseline (the WC/Reown transitives were assessed zero-prod-risk because
the app ships the RainbowKit connector UI, and the WC/`@reown/appkit-*`/`engine.io`/`ws` code arrives only via
`@wagmi/connectors`' connector internals). **That assessment still holds.** The fixes are applied/queued anyway
— defence in depth on a fund-moving app.

---

## Why two of the four are allowlisted, not overridden

`.npmrc` sets **`min-release-age=7`** — `npm install` refuses any version published in the last 7 days (a
supply-chain guard against freshly-compromised releases; CI even asserts the directive is present). The patches
split on that line:

| Patch | Published | Installable now under min-release-age=7? | Path chosen |
|-------|-----------|------------------------------------------|-------------|
| `ws@8.21.0` / `7.5.11` | 2026-05-22 | ✅ aged-in | override |
| `hono@4.12.25` | 2026-06-09 | ✅ aged-in (8d) | override |
| `form-data@4.0.6` | 2026-06-12 | ❌ ages in ~2026-06-19 | allowlist → override later |
| `vite@8.0.16` | 2026-06-15 | ❌ ages in ~2026-06-22 | allowlist → override later |

Following the prompt's structure ("preferred: override; fallback: allowlist if no compatible patch is
available yet"), the two patches our own freshness policy currently blocks are allowlisted rather than pulled
by bypassing `min-release-age`. **No `min-release-age` bypass was performed and `.npmrc` is unchanged.**

> Alternative the Architect may prefer: pin all four via `overrides` and generate the lockfile with a one-time
> `min-release-age` exception (the lockfile records exact versions + integrity; CI installs via `npm ci`, which
> ignores `min-release-age`). That fully *fixes* all four now but deliberately pulls two `<7-day-old` packages.
> I chose the allowlist to respect the freshness policy; say the word and I'll switch to the all-override pin.

---

## Changes

### 1. `package.json` overrides (added)
```jsonc
"hono": "4.12.25",
"@walletconnect/jsonrpc-ws-connection": { "ws": "7.5.11" },  // keep WC's ws in its declared ^7.5.1 range
"ws": "8.21.0"                                                 // everything else → patched 8.x
```
`ws` is split so each consumer stays inside its **declared** range (minimal touch to the WC stack): the WC
connection keeps a 7.x ws (patched 7.5.11), while `@walletconnect/utils` / `engine.io-client` / `isows`
(declared `^8`) get 8.21.0. Both clear GHSA-96hv (high) **and** GHSA-58qx (the ws moderate).

### 2. Audit gate (CI) — allowlist-aware
- **`audit-allowlist.json`** — the two min-release-age-blocked highs, each with `fixedIn`, `ageInOn`, the
  runtime-path note, and a TODO to convert to an `overrides` pin.
- **`scripts/audit-gate.mjs`** — replaces bare `npm audit --audit-level=high`. **Fails on any high/critical NOT
  in the allowlist** (proven: de-allowlisting `vite` re-reds the gate). Warns (never fails) when an entry is
  stale or resolved, so the gate can't surprise-red `main` on a future date.
- Wired into both `ci.yml` and `security-audit.yml`.

### Lockfile (side effect, verified benign)
The override perturbs the `@wagmi/connectors` subtree, so `npm install` re-dedups it. Net version-set delta
(vs origin/main): `ws {7.5.10,8.18.0,8.18.3,8.20.0} → {7.5.11,8.21.0}`, `hono 4.12.23 → 4.12.25`, and a
within-range dedup of `@noble/hashes` (`@scure/bip32`/`bip39` declare `~1.7.1`; their dedicated `1.7.2` copy
collapsed onto the shared **1.7.1` — still in range, 1-patch). The ~224 lockfile deletions are removals of
**duplicate nested entries** that hoisted to existing root copies — **no package or platform was lost** (the
full `@next/swc-*` platform set is byte-identical). `lockfile-lint` passes.

---

## Verification

| Check | Result |
|-------|--------|
| `npm audit --audit-level` (via `scripts/audit-gate.mjs`) | **PASS** — 2 highs, both allowlisted, 0 blocking |
| Gate has teeth (de-allowlist `vite`) | FAILS exit 1 on `vite` ✅ |
| `@walletconnect/core` instances (P184) | **1** (`2.21.1`) |
| `ua-parser-js` (ADR-012 canary) | `1.0.41` (MIT, not 2.x AGPL) |
| AGPL/GPL transitive (ADR-012) | none |
| wagmi / RainbowKit (ADR-008 / ADR-012) | `2.19.5` / `2.2.10` (unchanged) |
| `tsc --noEmit` | clean |
| `eslint src` | 0 errors (108 pre-existing warnings) |
| `vitest` | **1701 / 1701** |
| `next build` | compiled successfully |
| forge — OrderExecutor / FeeCollector | **68 / 68** + **19 / 19** |
| `lockfile-lint` | ✔ no issues |

**Manual-verify step (not coverable in CI):** confirm the WalletConnect connect/pair flow in a browser
(QR + mobile deep-link) still works after the `ws` override — the override forces `@walletconnect/jsonrpc-
ws-connection` onto a different ws patch. Tests + build pass; a real pairing should be smoke-tested before/at
merge.

## Follow-ups (TODO)
1. **~2026-06-19** — `form-data@4.0.6` ages past min-release-age → replace its allowlist entry with `"form-data": "4.0.6"` override.
2. **~2026-06-22** — `vite@8.0.16` ages in → replace its allowlist entry with `"vite": "8.0.16"` override.
3. When both are converted, `audit-allowlist.json` is empty → the gate is back to "zero allowlisted highs".
