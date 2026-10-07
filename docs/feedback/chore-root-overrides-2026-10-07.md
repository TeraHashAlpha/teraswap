# Feedback — chore/root-overrides-2026-10-07

Goal: root-manifest overrides for Dependabot alerts whose patch is >= 7d old (min-release-age=7 kept), react/react-dom together, drop obsolete source-map-js allowlist entry. Root only; nothing under contracts/.

## Task checklist
- [x] C1 evidence
- [ ] C2 overrides + react bump
- [ ] C3 allowlist cleanup
- [ ] Verify + evidence 2-5

## Evidence 1 — per-package (measured 2026-10-07)
| pkg | path | prod/dev | from → to | patch published (age) |
|---|---|---|---|---|
| hono | wagmi → @wagmi/connectors → porto | prod | 4.12.27 → 4.13.7 (existing override pin) | 2026-09-04 (32d) |
| brace-expansion 5.x | minimatch@10.2.5 (@capacitor/cli→rimraf→glob; typescript-estree) | prod | 5.0.11 → 5.0.12 (nested override) | 2026-09-14 (22d) |
| brace-expansion 1.x | minimatch@3.1.5 (@eslint/eslintrc) | dev | 1.1.20 → 1.1.21 (nested override) | 2026-09-14 (22d) |
| js-yaml | @eslint/eslintrc | dev | 5.2.2 → 5.4.1 (override `^5.2.1` → exact) | 2026-08-26 (41d) |
| decode-uri-component | wagmi → connectors → WC ethereum-provider → utils → query-string@7.1.3 | prod | 0.2.2 → 0.5.0 (new override) | 2026-06-29 (99d) |
| react / react-dom | direct deps | prod | 18.3.0 → 18.3.1 | 2024-04-26 (893d) |

All targets >= 7d, so none is blocked by min-release-age.

## Deliberately skipped
postcss-selector-parser (tailwind 3 needs ^6), uuid (cross-major), elliptic (no patch).
