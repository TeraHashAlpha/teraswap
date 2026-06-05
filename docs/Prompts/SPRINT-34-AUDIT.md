# Sprint 34 Audit — Digit Roller Animation

**Role:** You are a Senior Security Auditor reviewing Sprint 34 of the TeraSwap DEX aggregator. Your job is to verify correctness, accessibility, performance, and test coverage of all changes.

**Branch:** `feat/digit-roller-v2`  
**Base:** `main`  
**Commits:** 2 (P191 `f52d542`, P192 `6029f7b`)  
**Files changed:** 3 (`src/components/DigitRoller.tsx` NEW, `src/components/DigitRoller.test.tsx` NEW, `src/components/SwapBox.tsx` EDIT)  
**Test count:** 1151 → 1160 (reported by code agent; spec expected +14 = 1165 — auditor must verify actual count)

---

## Context

Sprint 34 adds a Matcha-inspired odometer animation to the swap output amount in SwapBox. When a new quote arrives, each digit rolls vertically to its new value using Framer Motion spring physics instead of snapping instantly. The change is purely visual — the data flow (`outputDisplay` from `formatDisplay()`) is untouched.

1. **P191 — DigitRoller component + SwapBox integration:** New `DigitRoller.tsx` with `DigitColumn` sub-component. Each digit is a clipped `w-[1ch]` column stacking 0–9; a `motion.div` animates `y` to roll the active digit into view. Separators (spaces, dots) are static. Wired into `SwapBox.tsx` output display: `<DigitRoller value={outputDisplay} prefix="≈" />`.

2. **P192 — Tests:** 12 unit tests + 2 SwapBox integration smoke tests = 14 new.

**Code Agent deviations (from FEEDBACK.md):**
- Test file placed at `src/components/DigitRoller.test.tsx` (colocated) instead of `__tests__/components/DigitRoller.test.tsx` (spec'd path)
- Tests #7/#8 assert column counts instead of glyph absence (all 10 digits always in DOM via transform stack)
- Odometer-index `let`-reassignment refactored out of JSX map for React-compiler lint rule

---

## Audit Checklist

Review each item and classify findings as C (Critical), H (High), M (Medium), L (Low), or INFO.

### 1. P191 — DigitRoller Component

**Source file:** `src/components/DigitRoller.tsx`

#### 1.1 Architecture & Rendering

- [ ] **Character parsing:** Value string is split into an array. Digits (`0–9`) get `DigitColumn`, separators (` `, `.`, `,`) get static `<span>`. Verify no other characters are misclassified.
- [ ] **Prefix handling:** The `prefix` prop (e.g. `"≈"` or `"~"`) renders as static text BEFORE any digit columns. Verify it is not wrapped in a `DigitColumn`.
- [ ] **Dash fallback:** When `value === "—"` (safeBigInt failure), the component renders a static span with no motion wrappers. Verify no `DigitColumn` is instantiated.
- [ ] **Empty/undefined value:** When `value` is `""` or `undefined`, the component does not crash. Verify graceful empty render.
- [ ] **React.memo:** Outer `DigitRoller` is wrapped in `React.memo()`. Verify the memo boundary is at the correct level.

#### 1.2 DigitColumn Sub-Component

- [ ] **Container dimensions:** `w-[1ch]`, `overflow-y-clip`, `relative inline-block`. Verify the clip prevents digits above/below the active one from showing.
- [ ] **Digit stack:** Exactly 10 children (digits 0–9) inside a `motion.div`. Each child has `height: LINE_HEIGHT_PX`. Verify no extra or missing children.
- [ ] **Animation target:** `motion.div` animates `y` to `-digit * lineHeight`. Verify the calculation is correct for all digits 0–9.
- [ ] **Spring constants:** `type: "spring"`, with `stiffness`, `damping`, `mass` values. Verify they are hardcoded (not configurable via props, per spec).
- [ ] **Stagger effect:** Per-column delay based on index from the right. Verify the formula: `(totalDigits - columnIndex - 1) * STAGGER_MS`. Right-most digit should settle first.
- [ ] **initial={false}:** First render should NOT animate (value appears instantly). Verify `initial={false}` on the motion wrapper or equivalent.
- [ ] **tabular-nums:** The roller container has `tabular-nums` CSS class for consistent digit widths. Verify it is set on the correct element.

#### 1.3 Line Height Measurement

- [ ] **LINE_HEIGHT_PX export:** Default constant `32` is exported as a named export. Verify it is used as the fallback.
- [ ] **DOM measurement:** `useEffect` + `getComputedStyle` reads actual line height at mount. Verify the measurement only runs once (`[]` dependency array).
- [ ] **Fallback path:** If `getComputedStyle` returns `NaN` or `0` or empty string (JSDOM), falls back to `32`. Verify the guard condition.
- [ ] **lineHeight propagation:** The measured value is passed to each `DigitColumn`, not read from a global. Verify via props or context.

#### 1.4 AnimatePresence & Edge Cases

- [ ] **Value gets shorter:** Digit columns that disappear use `AnimatePresence` with an exit animation (e.g. `opacity: 0, y: -16`). Verify no orphaned DOM nodes after transition.
- [ ] **Value gets longer:** New digit columns enter with initial opacity 0 → 1. Verify they appear smoothly.
- [ ] **Key stability:** Each digit column has a stable, unique key. Verify the key strategy: spec suggests right-anchored keys for decimal-aligned grow/shrink. Confirm keys don't cause unnecessary unmount/remount when value changes length.
- [ ] **Identical value:** Re-render with same value triggers no animation (key stability). Verify no spring re-trigger.

#### 1.5 Accessibility & Reduced Motion

- [ ] **useReducedMotion:** Framer Motion's `useReducedMotion()` hook is called. When `true`, all spring animations are disabled (`duration: 0` or equivalent). Verify the digit still shows correctly — just without animation.
- [ ] **Screen reader:** The numeric value should be accessible to screen readers. Verify the component has appropriate `aria-label` or that the digit stack is readable when linearised. Check if `aria-hidden` is used on non-active digits.

#### 1.6 Performance

- [ ] **No rAF loops:** Component uses only Framer Motion declarative API. No `requestAnimationFrame`, no `setInterval`, no imperative DOM mutation.
- [ ] **No useLayoutEffect:** Per spec, only `useEffect` or motion props. Verify no `useLayoutEffect` usage.
- [ ] **Memo boundaries:** `DigitColumn` should only re-render when its `digit` prop changes. Verify memoisation (React.memo or useMemo on the column).

### 2. P191 — SwapBox Integration

**Source file:** `src/components/SwapBox.tsx`

- [ ] **Import added:** `import DigitRoller from '@/components/DigitRoller'` (or equivalent). Verify it is the only new import.
- [ ] **Output display replaced:** The static `~${outputDisplay}` span is replaced with `<DigitRoller value={outputDisplay} prefix="≈" />` (or `prefix="~"`). Verify the prefix matches the original `~` character.
- [ ] **Loading path preserved:** `quoteLoading` ternary still renders the `animate-pulse` span with `"..."`. The DigitRoller is only rendered when NOT loading. Verify the ternary structure is unchanged.
- [ ] **No other SwapBox changes:** Only the output display and import line changed. Verify no other modifications to SwapBox logic, styling, or state.
- [ ] **No scope creep:** No changes to `formatDisplay()`, `format.ts`, hooks, API routes, or any other file.

### 3. P192 — Test Coverage

**Test file:** `src/components/DigitRoller.test.tsx`

**Deviation note:** Spec called for `__tests__/components/DigitRoller.test.tsx`. Code agent placed at `src/components/DigitRoller.test.tsx` (colocated). Verify vitest config picks it up (check `include` pattern in `vitest.config.ts`).

#### 3.1 Unit Tests (12 expected)

- [ ] **T1 — Renders all digits:** `value="1 975.6553"` → all 8 unique digits present. Verify assertion method is sound (note: all 10 digits exist in each column's stack, so assertion must target the correct DOM level).
- [ ] **T2 — Renders prefix:** `prefix="~"` or `"≈"` appears before digit columns. Verify ordering assertion.
- [ ] **T3 — Static separators:** Spaces and dots are NOT inside motion wrappers. Verify the assertion distinguishes animated vs static elements.
- [ ] **T4 — Dash fallback:** `value="—"` renders static text, no DigitColumn wrappers. Verify assertion.
- [ ] **T5 — Empty string:** `value=""` renders without crash. Verify no error thrown.
- [ ] **T6 — Correct digit column count:** `value="1 234.56"` → exactly 6 digit columns. Verify count excludes separators.
- [ ] **T7 — Shorter value transition:** Rerender from long to short value. Assert new digits present. **Deviation:** Code agent asserts column count instead of glyph absence (all 10 digits always in DOM). Verify this is a valid approach.
- [ ] **T8 — Longer value transition:** Rerender from short to long value. Assert all new digits present. Same deviation as T7.
- [ ] **T9 — Identical value re-render:** Same value twice → no crash, stable output.
- [ ] **T10 — Reduced motion:** Mock `useReducedMotion` → `true`. Digits render correctly without animation. Verify mock scope is isolated (separate `describe` block).
- [ ] **T11 — LINE_HEIGHT_PX export:** Import and assert `=== 32`.
- [ ] **T12 — Snapshot stability:** Snapshot test for `value="1 234.56"` with `prefix="~"`. Verify snapshot file exists and is committed.

#### 3.2 Integration Smoke Tests (2 expected)

- [ ] **T13 — SwapBox renders DigitRoller:** Non-loading state → `tabular-nums` container present, prefix visible, digits rendered. Verify mock setup (wagmi, useQuote, etc.) does not bleed into other tests.
- [ ] **T14 — SwapBox loading pulse:** `quoteLoading: true` → `animate-pulse` span visible, NO DigitRoller rendered.

#### 3.3 Test Quality

- [ ] **No mock bleed:** Each test properly sets up and tears down mocks. Reduced-motion mock is scoped to its own describe block.
- [ ] **No snapshot fragility:** Snapshot does not include volatile data (timestamps, random IDs, etc.).
- [ ] **Test count:** Verify actual test count. Code agent reports 14 new tests and 1160 total suite. Sprint 37 ended at 1151. Expected: 1151 + 14 = 1165. If the count is 1160, investigate the discrepancy (5 tests missing — were existing tests removed or consolidated?).

### 4. FEEDBACK.md Deviations

- [ ] **Test path deviation:** Tests at `src/components/` instead of `__tests__/components/`. Assess whether this matches existing project conventions or introduces inconsistency. Check where other component tests live.
- [ ] **Column count vs glyph absence (T7/T8):** The code agent notes all 10 digits are always in DOM (stacked via transform). Asserting glyph absence is impossible. Verify this is architecturally correct — the clip approach means all digits ARE in DOM but only one is visible.
- [ ] **JSX map refactoring:** `let`-reassignment moved out of JSX map for React-compiler lint. Verify the refactored code produces identical output and the lint rule is genuine.

### 5. General

- [ ] **No scope creep:** Only `DigitRoller.tsx`, `DigitRoller.test.tsx`, and `SwapBox.tsx` changed. No other files touched.
- [ ] **No new dependencies:** No new npm packages added. Framer Motion already in `package.json`.
- [ ] **No changes to hooks/lib/api:** Verify zero diff in `src/hooks/`, `src/lib/`, `src/app/api/`, contracts.
- [ ] **TypeScript:** `npm run typecheck` must pass.
- [ ] **Lint:** `npm run lint` must pass.
- [ ] **All tests:** `npm run test` must pass with 0 failures. Report the actual test count.
- [ ] **GPG/SSH signatures:** Both commits must be signed.

---

## Expected Output

```markdown
## Sprint 34 Audit Verdict

**Branch:** feat/digit-roller-v2
**Commits reviewed:** f52d542, 6029f7b
**Tests:** {before} → {after}

### Verdict: {APPROVED | APPROVED WITH WARNINGS | REJECTED}

{0C / 0H / 0M / 0L / NI INFO}

### Findings

| ID | Severity | Component | Description |
|---|---|---|---|
| 34-{severity}-{NN} | {C/H/M/L/INFO} | {file} | {description} |

### FEEDBACK.md Triage

| # | Deviation | Auditor Assessment |
|---|---|---|
| 1 | Test path colocated vs __tests__ | {Accept / Flag / Fix required} |
| 2 | Column count assertion (T7/T8) | {Accept / Flag / Fix required} |
| 3 | JSX map let-reassignment refactor | {Accept / Flag / Fix required} |

### Recommendation

{Merge / Fix required / ...}
```

Run `npm run typecheck`, `npm run lint`, and `npm run test` before delivering the verdict. Report the actual test count and investigate the 1165 vs 1160 discrepancy.
