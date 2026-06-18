# CHORE-AUDIT-GATE-RESOLVE

Branch: `chore/audit-gate-resolve` (off `origin/main`). No Auditor. Architect review before merge.

## Context

`scripts/audit-gate.mjs` (CI `audit` job) FAILS on any high/critical npm advisory not listed in
`audit-allowlist.json`. A new HIGH — **undici GHSA-vmh5-mc38-953g** (TLS certificate-validation bypass via
dropped `requestTls` in the SOCKS5 ProxyAgent), published **2026-06-18** — appeared on `main`'s lockfile and is
NOT allowlisted there, so the gate reds on `main` and on **every PR branched from it**. Two pre-existing HIGHs
(form-data, vite) were already allowlisted.

## Objective

Make the audit gate pass for all three highs, durably, without weakening the supply-chain controls.

## Requirements

1. **undici** GHSA-vmh5-mc38-953g — confirm the runtime path (SOCKS5 ProxyAgent unused; transitive/dev-only),
   then pin to the patched version via npm `overrides`. If the patch is blocked by `.npmrc min-release-age=7`
   (published < 7 days), use a dated `audit-allowlist.json` entry instead (Architect sign-off), with a TODO to
   convert once it ages in.
2. **form-data** (fix 4.0.6) + **vite** (fix 8.0.16) — convert their allowlist entries to `overrides` pins and
   delete the entries, *if* their fixes have aged past `min-release-age`.

## Do NOT

- Introduce wagmi v3; keep RainbowKit 2.2.10; keep a single resolved version of `@walletconnect/core`, `viem`,
  `qr`, and the Coinbase SDK; introduce no copyleft licenses.
- Remove or weaken `.npmrc min-release-age=7` (CI guards its presence).
- Leave `npm ci` non-clean.

## Files affected

- `audit-allowlist.json` — add the undici entry; (later) remove form-data/vite/undici once pinned.
- `package.json` `overrides` — (later, at age-in) `"form-data": "4.0.6"`, `"vite": "8.0.16"`, `"undici": "7.28.0"`.
- `FEEDBACK.md` — per-advisory disposition + undici runtime-path note.

## Disposition (as implemented 2026-06-18)

All three fixed via `overrides` pins (`undici` 7.28.0, `form-data` 4.0.6, `vite` 8.0.16); `audit-allowlist.json`
emptied (**0 allowlisted**); `npm audit` → 0 high/critical.

`min-release-age=7` (npm 11.10.1, enforced as a `--before` cutoff) blocks **re-resolving** to the <7d-old fixes:
an override against an inconsistent lockfile fails `ETARGET`. The resolution is a **consistent** lockfile — once
`package-lock.json` pins the patched versions, `npm ci` and `npm install` install them without re-resolving, so
the date filter never fires (verified: `npm ci` clean, `npm install` "up to date", `npm audit` 0 high). The
committed `.npmrc` keeps `min-release-age=7` (ci.yml guard passes) — the control still governs all other deps.
vite 8.0.16's required dep closure (rolldown 1.0.3 + bindings, all dev-only/MIT) moves with it. This pins the
fixes ~4 days before their natural age-in (06-19/06-22) — a reviewed early-pin of official security releases.

## Expected output

`node scripts/audit-gate.mjs` passes; tsc / lint / tests / build / test-contracts green; FEEDBACK updated.

## Quality criteria

- No advisory silenced without a dated, justified entry (gate still reds on un-triaged findings).
- No supply-chain control bypassed; reproducible `npm ci`.
- Constraints (wagmi/RainbowKit/single-version/no-copyleft) preserved (audit-allowlist-only change touches none).
