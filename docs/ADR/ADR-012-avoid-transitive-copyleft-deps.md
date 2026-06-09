# ADR-012 — Avoid transitive copyleft (AGPL/GPL) dependencies

- **Status:** Accepted
- **Date:** 2026-06-09
- **Related:** SPRINT-9Z Part C (the `ua-parser-js` AGPL finding), INC-2026-06-09-001 (the `qr@0.6.0`
  connect-modal crash — sibling "loose transitive range" lesson), `FEEDBACK.md` (9Z + HOTFIX sections),
  ADR-008 (wagmi v3 deferral, the related upgrade-boundary decision)

## Context
TeraSwap is a **closed-source commercial dApp**. Its frontend bundle is shipped to users, so any
**copyleft** code (AGPL-3.0 / GPL) pulled into the dependency tree — even transitively — can create
source-disclosure obligations. SPRINT-9Z surfaced this concretely: bumping `@rainbow-me/rainbowkit` to
the latest **2.2.11** changes its `ua-parser-js` dependency from `^1.0.37` (MIT 1.0.41) to `^2.0.9`,
which resolves **`ua-parser-js@2.0.10` licensed AGPL-3.0-or-later** (ua-parser-js relicensed to AGPL at
2.0.0; the 1.x line stays MIT). The bump's headline changes were mobile fixes — the license shift was
invisible at the `package.json` level and only showed up by inspecting the resolved transitive tree.

The sibling incident **INC-2026-06-09-001** is the same class of failure from the other direction: a
transitive package (`cuer`) declared an over-loose range (`qr: "~0"`) that silently resolved a breaking
`qr@0.6.0` and crashed production. Both are **"what a version bump drags in transitively"** problems.

## Decision
1. **Do not ship transitive AGPL/GPL (or other strong-copyleft) dependencies.** MIT / Apache-2.0 /
   BSD / ISC are fine.
2. **`@rainbow-me/rainbowkit` is pinned to ≤ 2.2.10** until upstream offers an MIT-compatible
   `ua-parser-js` path (or the org accepts an explicit AGPL exception / commercial ua-parser-js
   licence). 2.2.10 ships all the 9Z mobile-critical fixes and keeps `ua-parser-js` on MIT 1.x.
3. **Every dependency bump must check the resolved transitive licence set**, not just the direct
   package. Use the Sonatype dependency-vetting gate (or `npm ls` + licence inspection) before merge;
   prefer `overrides` to pin a known-good transitive version over taking a riskier upgrade wholesale.
4. When a transitive dep is the risk surface, **pin it via `package.json overrides`** (the pattern
   already used for `@walletconnect/core` and `qr`) rather than abandoning the parent upgrade.

## Consequences
- **Positive:** no copyleft obligation reaches the shipped bundle; bumps are reviewed for the whole
  resolved tree, which also catches breaking transitive drift (the INC-2026-06-09-001 class).
- **Cost:** RainbowKit can lag its latest release while 2.2.11+ carries AGPL `ua-parser-js`; mobile
  fixes beyond 2.2.10 must be obtained another way (e.g. a pinned MIT `ua-parser-js` override, if it
  proves API-compatible) and re-verified.
- **Revisit when:** RainbowKit reverts the `ua-parser-js` major, ua-parser-js offers an MIT 2.x, or the
  org formally accepts the AGPL/commercial-licence trade-off.

## Cross-check
The 9Z FEEDBACK records the resolved-tree evidence (`ua-parser-js@2.0.10` `license: AGPL-3.0-or-later`
under `@rainbow-me/rainbowkit@2.2.11`, vs `1.0.41` MIT under 2.2.10). INC-2026-06-09-001 records the
`qr@0.6.0` transitive-range crash and the `qr: 0.5.5` override remediation.
