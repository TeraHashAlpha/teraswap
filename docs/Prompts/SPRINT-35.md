# Sprint 35 — Wagmi v3 Migration Prep

> **Objective:** Prepare the codebase for the wagmi v2→v3 migration by resolving the changes that work in both versions, preinstalling future peer dependencies, and upgrading TypeScript. Full migration deferred until RainbowKit releases wagmi v3 support (see ADR-008).
>
> **Prerequisite:** Sprint 31B (Alchemy Discovery) merged to main.
>
> **ADR:** `docs/ADR/ADR-008-wagmi-v3-migration.md`

---

## P183 — TypeScript upgrade to 5.9.x

### Context

Wagmi v3 requires TypeScript ≥5.9.3. TeraSwap currently declares TypeScript 5.5 in its stack. The upgrade is non-breaking (TS 5.5→5.9 has no breaking changes affecting our patterns).

### Objective

Upgrade TypeScript to the latest 5.9.x release and verify the entire codebase still compiles.

### Requirements

1. Run `npm install typescript@~5.9 --save-dev`
2. Run `npm run typecheck` — fix any new errors (unlikely but possible from stricter inference in 5.9).
3. Run `npm run build` — verify build succeeds.
4. Run `npm test` — verify all 1132 tests pass.
5. Update `tsconfig.json` if needed (unlikely — our config is standard Next.js).

### Do NOT

- Change any source code unless TypeScript 5.9 introduces a type error that needs fixing.
- Upgrade any other dependencies in this prompt.

### Files affected

- `package.json` — EDIT (typescript version)
- `package-lock.json` — AUTO-UPDATED
- `tsconfig.json` — EDIT only if needed

### Expected output

- 1 commit: `chore: upgrade TypeScript to 5.9.x for wagmi v3 readiness [P183]`
- `npm run typecheck && npm run build && npm test` all pass.

---

## P184 — Preinstall wagmi v3 connector peer dependencies

### Context

Wagmi v3 moves wallet connector SDKs from bundled dependencies to optional peer deps. By installing them now as explicit dependencies, we prepare the dependency tree without any runtime changes. These packages are already installed transitively via wagmi v2 — we're just making them explicit.

### Objective

Add the connector SDKs that RainbowKit's `getDefaultConfig` uses as explicit dependencies.

### Requirements

1. Install:
   ```bash
   npm install @walletconnect/ethereum-provider @coinbase/wallet-sdk
   ```
   Note: Do NOT install `@metamask/connect-evm` yet — it's the v3-only MetaMask package that replaces `@metamask/sdk`. Installing it now alongside wagmi v2 could cause conflicts. We'll add it when we actually bump to wagmi v3.

2. Verify versions installed are compatible with current wagmi v2 (they should be — these are the same packages wagmi v2 uses internally).

3. Run `npm run build && npm test` — verify no regressions.

4. Run `npm audit` — verify no new high/critical vulnerabilities from the explicit installs.

### Do NOT

- Install `@metamask/connect-evm` (wagmi v3 only, conflicts with v2's `@metamask/sdk`).
- Upgrade wagmi or viem versions.
- Change any source code.

### Files affected

- `package.json` — EDIT (new explicit dependencies)
- `package-lock.json` — AUTO-UPDATED

### Expected output

- 1 commit: `chore: preinstall wallet connector deps for wagmi v3 readiness [P184]`
- No functional changes, all tests pass.

---

## P185 — Replace deprecated `useSwitchChain().chains` pattern

### Context

In wagmi v3, `useSwitchChain().chains` is removed — replaced by `useChains()`. This is the ONE breaking pattern in our codebase (SwapButton.tsx). The fix works in BOTH wagmi v2 and v3, so we can do it now.

### Objective

Replace `useSwitchChain().chains` with `useChains()` in SwapButton.tsx.

### Requirements

1. In `src/components/SwapButton.tsx`:
   - Add import: `useChains` from `'wagmi'`
   - Replace: `const { switchChain, chains } = useSwitchChain()` 
   - With: `const { switchChain } = useSwitchChain()` + `const chains = useChains()`
   - Or: `const switchChain = useSwitchChain()` + `const chains = useChains()` (if adopting v3 pattern early — use the approach that requires fewer changes to the rest of the file).

2. Verify the `chains` usage in SwapButton still works (it's likely used to check if the current chain is supported).

3. Run `npm run typecheck && npm test` — verify no regressions.

4. If `SwapButton.test.tsx` exists and tests the chain switching, verify those tests still pass.

### Do NOT

- Rename `useAccount` → `useConnection` in this prompt (that's a mass rename for the full v3 migration later).
- Change any other hooks or files.

### Files affected

- `src/components/SwapButton.tsx` — EDIT

### Expected output

- 1 commit: `refactor(SwapButton): use useChains() for wagmi v3 compat [P185]`
- All tests pass.

---

## P186 — Index ADR-008 in ARCHITECT-INDEX

### Context

ADR-008 documents the migration decision. This prompt ensures the ADR is indexed.

### Requirements

1. Verify `docs/ADR/ADR-008-wagmi-v3-migration.md` exists (created by the Architect — do NOT modify it).

2. Update `ARCHITECT-INDEX.md`:
   - Add ADR-008 to the ADR section: `| ADR-008 | Wagmi v3 Migration | Proposed | Defer until RainbowKit v3 compat |`

3. Run `npm test` — final verification all 1132+ tests pass.

### Do NOT

- Modify ADR-008 (Architect owns ADRs).
- Change any source code.

### Files affected

- `ARCHITECT-INDEX.md` — EDIT

### Expected output

- 1 commit: `docs: index ADR-008 wagmi v3 migration [P186]`

---

## Sprint 35 — Summary

| Prompt | Scope | Risk | Files |
|--------|-------|------|-------|
| P183 | TypeScript 5.5 → 5.9.x | Low | 1-2 |
| P184 | Preinstall connector peer deps | Low | 1 |
| P185 | Fix `useSwitchChain().chains` deprecation | Low | 1 |
| P186 | Index ADR-008 | None | 1 |

**Branch:** `chore/sprint-35-wagmi-v3-prep`

**Expected total tests after sprint:** 1132 (no new tests — prep sprint)

**What this sprint does NOT do:**
- Does NOT upgrade wagmi to v3 (blocked by RainbowKit)
- Does NOT rename `useAccount` → `useConnection` (deprecated but working)
- Does NOT rename mutate functions (deprecated but working)
- Does NOT install `@metamask/connect-evm` (v3 only)

**When to complete full migration (Sprint 35B):**
- RainbowKit releases wagmi v3 compatible version
- Monitor: https://github.com/rainbow-me/rainbowkit/discussions/2575

**Acceptance criteria:**
- TypeScript 5.9.x installed and all checks pass.
- Connector peer deps explicitly in package.json.
- Zero deprecated-pattern usage for the one hard break (useSwitchChain().chains).
- ADR-008 indexed.
- All 1132+ tests pass, build clean, typecheck clean.
