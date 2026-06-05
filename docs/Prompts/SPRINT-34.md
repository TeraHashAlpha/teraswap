# Sprint 34 — Digit Roller Animation (Matcha-Inspired)

**Sprint window:** 2026-05-28 → TBD  
**Sprint goal:** Add a slot-machine / odometer animation to the swap output amount. When a new quote arrives, each digit rolls vertically to its new value instead of snapping instantly. Inspired by Matcha Meta (meta.matcha.xyz) — reverse-engineered in Cowork session 2026-05-28.  
**Owner:** TeraHash (founder/architect) + code agent  
**Prerequisite:** Sprint 36 (Quote Rate Limit Relief) merged to main. All tests passing.  
**Branch:** Create new branch `feat/digit-roller` from `main`.

**IMPORTANT:** This sprint touches ONLY:
- 1 new component (`DigitRoller.tsx`)
- 1 existing component (`SwapBox.tsx` — output display only)
- 1 test file (new)

Do NOT touch any files in `src/hooks/`, `src/lib/`, `src/app/api/`, contracts, or blockchain code.

---

## Reference — Matcha Meta Implementation (Reverse-Engineered)

The Matcha Meta aggregator uses a **digit roller** animation on the buy output amount. Here is the exact DOM structure and animation mechanism captured via JS inspection:

### DOM Structure (per digit)

```
<div class="relative inline-block w-[1ch] overflow-x-visible overflow-y-clip leading-none tabular-nums">
  <!-- 11 children: 1 spacer + digits 0–9 -->
  <span>0</span>  <!-- invisible spacer, reserves line height -->
  <span class="absolute inset-0 flex items-center justify-center"
        style="transform: translateY(-24px); opacity: 1;">0</span>
  <span class="absolute inset-0 flex items-center justify-center"
        style="transform: none; opacity: 1;">1</span>  <!-- ← ACTIVE -->
  <span class="absolute inset-0 flex items-center justify-center"
        style="transform: translateY(24px); opacity: 1;">2</span>
  <!-- ... 3–9 at +48px, +72px, ... +192px -->
</div>
```

**Key observations:**
- Container: `w-[1ch]` (exactly 1 character wide), `overflow-y: clip` (only shows the active digit)
- 12 rollers total for a number like `1,975.655392` (digits + comma + dot)
- Active digit: `transform: none` — all others offset by `N × 24px` (line-height)
- Separators (`,` and `.`) are NOT rollers — they are static inline spans

### Animation Mechanism

- **NOT CSS transitions** — Matcha uses a `requestAnimationFrame` loop
- On value change: ~900 DOM style mutations over ~75 frames (~1.25s at 60fps)
- Each frame shifts every digit's `translateY` incrementally toward the target
- Settling: target digit reaches `transform: none`, animation ends

### TeraSwap Advantage

We already have **Framer Motion 12.36** in the stack. Instead of imperative rAF loops with DOM mutation, we can use declarative spring animation:

```tsx
<motion.span
  animate={{ y: targetDigitIndex * -LINE_HEIGHT }}
  transition={{ type: "spring", stiffness: 200, damping: 25 }}
/>
```

Benefits over Matcha's approach:
- **Declarative** — no manual rAF loop, no DOM mutation tracking
- **GPU-composited** — Framer uses `will-change: transform`, no layout thrashing
- **Spring physics** — natural deceleration instead of linear interpolation
- **~10× fewer DOM mutations** — Framer batches style updates internally

---

## P191 — DigitRoller Component

### Context

The swap output amount in `SwapBox.tsx` currently renders as a static text span:

```tsx
<span className="min-w-0 flex-1 text-2xl font-semibold text-cream-65">
  {quoteLoading ? <span className="inline-block animate-pulse text-cream-35">...</span> : `~${outputDisplay}`}
</span>
```

Where `outputDisplay` comes from `formatDisplay()` (e.g. `"1 975.6553"` — space-separated thousands, 4 decimal places).

When a new quote arrives, the number snaps instantly to the new value. We want each digit to **roll** to its new position like an odometer.

### Objective

Create a `DigitRoller` component that animates numeric value transitions digit-by-digit using Framer Motion spring physics. Replace the static output display in SwapBox with the roller.

### Requirements

#### 1. `DigitRoller.tsx` — new file at `src/components/DigitRoller.tsx`

**Props interface:**
```typescript
interface DigitRollerProps {
  /** Formatted value string, e.g. "1 975.6553" or "0.0012" */
  value: string
  /** Prefix to render before the roller (e.g. "~") */
  prefix?: string
  /** CSS class for the outer wrapper */
  className?: string
}
```

**Component architecture:**

A. **Parse the value string** into an array of characters. Each character is either:
   - A **digit** (`0–9`) → renders a `<DigitColumn>` (animated roller)
   - A **separator** (` `, `.`, `,`) → renders a static `<span>`

B. **`DigitColumn` sub-component** — the core roller for a single digit position:
   - Container: `relative inline-block overflow-y-clip` with height = 1 line-height
   - Width: `w-[1ch]` for digit columns (monospace alignment with `tabular-nums`)
   - Contains 10 absolutely-positioned spans (digits `0`–`9`), stacked vertically
   - A hidden spacer element (first child, `visibility: hidden`) to reserve the correct line-height — this is NOT animated, just ensures the container has the right intrinsic size
   - Active digit determined by the `digit` prop (0–9)
   - **Animation:** Use `motion.div` wrapping the digit stack. Animate the `y` property:
     ```tsx
     const LINE_HEIGHT_PX = 32  // Match text-2xl line-height
     
     <motion.div
       animate={{ y: -digit * LINE_HEIGHT_PX }}
       transition={{ type: "spring", stiffness: 180, damping: 22, mass: 0.8 }}
     >
       {[0,1,2,3,4,5,6,7,8,9].map(d => (
         <div key={d} style={{ height: LINE_HEIGHT_PX }} className="flex items-center justify-center">
           {d}
         </div>
       ))}
     </motion.div>
     ```
   - This approach animates ONE wrapper div instead of 10 individual spans — much simpler and more performant than Matcha's approach.

C. **Stagger effect:** When the value changes, right-most digits should settle slightly before left-most digits (like a real odometer). Add a per-column `transition.delay` based on the column's index from the right:
   ```tsx
   const delay = (totalDigits - columnIndex - 1) * 0.02  // 20ms stagger per digit
   ```

D. **Loading state:** When `value` is empty string or `undefined`, show a pulsing placeholder (same as current `animate-pulse` behaviour).

E. **Reduce motion:** Respect `prefers-reduced-motion`. When the media query matches, skip spring animation and set `transition.duration = 0` so values snap instantly. Use Framer Motion's `useReducedMotion()` hook.

F. **Memoisation:** `React.memo()` the outer component. The `DigitColumn` should only re-render when its `digit` prop changes.

G. **LINE_HEIGHT_PX robustness:** Instead of a hardcoded `32`, derive the line height from the actual DOM at mount time using a ref measurement. Fallback to `32` if the ref is not yet available (SSR / first paint):
   ```tsx
   const containerRef = useRef<HTMLSpanElement>(null)
   const [lineHeight, setLineHeight] = useState(32)

   useEffect(() => {
     if (containerRef.current) {
       const computed = parseFloat(
         getComputedStyle(containerRef.current).lineHeight
       )
       if (!isNaN(computed) && computed > 0) setLineHeight(computed)
     }
   }, [])
   ```
   Pass `lineHeight` to each `DigitColumn` instead of using the constant directly. This ensures the animation stays aligned if `text-2xl` is ever customised in the Tailwind config or if browser rendering differs.

   Export the default `LINE_HEIGHT_PX = 32` as a named constant for tests.

#### 2. Integration in `SwapBox.tsx`

Replace the static output display with:
```tsx
<span className="min-w-0 flex-1 text-2xl font-semibold text-cream-65">
  {quoteLoading
    ? <span className="inline-block animate-pulse text-cream-35">...</span>
    : <DigitRoller value={outputDisplay} prefix="~" />
  }
</span>
```

**Import:** Add `import DigitRoller from '@/components/DigitRoller'` to SwapBox imports.

**No other changes to SwapBox.** The `outputDisplay` variable already produces the formatted string. The roller consumes it as-is.

#### 3. Styling constraints

- Font must inherit from parent: `text-2xl font-semibold text-cream-65` — do NOT set font size inside DigitRoller, let it inherit
- Use `tabular-nums` on the roller container (consistent digit widths)
- Separators (spaces, dots) should NOT animate — they appear/disappear instantly
- The `~` prefix should be static, not rolled

#### 4. Edge cases

- **Value gets shorter** (e.g. "1 975.6553" → "0.0012"): digit columns that disappear should use `AnimatePresence` with `exit={{ opacity: 0, y: -16 }}` for a clean fade-up-out
- **Value gets longer** (e.g. "0.5" → "1 234.5"): new digit columns should enter with `initial={{ opacity: 0, y: 16 }}` → `animate={{ opacity: 1, y: 0 }}`
- **First render**: no animation — use `initial={false}` on the motion wrapper so the first value appears instantly
- **Identical value**: re-quote returns same number — no animation triggered (React key stability)
- **"—" fallback**: if value is `"—"` (safeBigInt failure), render it as a static span, no roller

### Do NOT

1. Do NOT use `requestAnimationFrame` loops — use Framer Motion declaratively
2. Do NOT use CSS `@keyframes` animations — spring physics from Framer Motion only
3. Do NOT modify `formatDisplay()` or `format.ts` — consume the existing output as-is
4. Do NOT add the roller to QuoteBreakdown or any component other than SwapBox output
5. Do NOT add any new npm dependencies — Framer Motion is already installed
6. Do NOT use `useLayoutEffect` — `useEffect` or motion props only
7. Do NOT make the animation duration configurable via props — hardcode the spring constants

### Files affected

| File | Action |
|------|--------|
| `src/components/DigitRoller.tsx` | **CREATE** — new component |
| `src/components/SwapBox.tsx` | **EDIT** — output display span, add import |

### Expected output

- 1 commit: `feat(swap): add digit roller animation to output amount [P191]`

### Quality criteria

1. When typing a sell amount, the output roller animates smoothly as new quotes arrive
2. Each digit rolls independently — if only the last decimal changes, only that column moves
3. Spring animation feels natural: fast initial movement, gentle settle (no bounce or overshoot)
4. `prefers-reduced-motion: reduce` disables all animation
5. No layout shift during animation — container width is stable with `tabular-nums`
6. Performance: < 1ms per frame on mid-range hardware (Framer Motion GPU compositing)
7. `AnimatePresence` handles value length changes without visual glitch
8. Loading state (`...`) still shows when `quoteLoading` is true
9. All existing SwapBox tests pass without modification

---

## P192 — DigitRoller Tests

### Context

P191 created the `DigitRoller` component. This prompt adds comprehensive test coverage — both unit tests for the component in isolation and an integration smoke test verifying SwapBox renders the roller correctly.

### Objective

Write tests that verify the DigitRoller renders correctly, handles all edge cases, respects accessibility, and integrates with SwapBox.

### Requirements

Create `__tests__/components/DigitRoller.test.tsx`:

#### Unit tests — DigitRoller component

1. **Renders all digits in formatted value** — pass `value="1 975.6553"` and assert each digit (`1`, `9`, `7`, `5`, `6`, `5`, `5`, `3`) is present in the DOM at least once (they appear in the digit stack and as the active value).

2. **Renders prefix before digits** — pass `prefix="~"` and assert the `~` character appears in the DOM and is rendered before any digit column. Use `container.textContent` to verify ordering.

3. **Static separators are not animated** — render `value="1 975.65"`, query all elements. Spaces and the dot should be inside static `<span>` elements, NOT wrapped in a `motion.div`. Verify by checking that separator containers do not have a `style` attribute with `transform`.

4. **Dash fallback renders as static text** — pass `value="—"` and assert:
   - The dash character is present in the DOM
   - No `DigitColumn` / motion wrappers are rendered (use `queryByTestId` or check motion element count is 0)

5. **Empty string does not crash** — pass `value=""` and assert the component renders without throwing. The container should be present but empty (no digit columns, no separators).

6. **Correct digit column count** — pass `value="1 234.56"` and verify that exactly **6** digit columns are rendered (digits `1`, `2`, `3`, `4`, `5`, `6`). Separators (space and dot) should NOT be counted.

7. **Value transition: shorter value** — render with `value="1 975.6553"`, then rerender with `value="0.01"`. Assert:
   - The new digits (`0`, `0`, `1`) are present
   - The old digits that no longer exist are NOT present (AnimatePresence should remove them)
   - No crash or React key warning

8. **Value transition: longer value** — render with `value="0.5"`, then rerender with `value="12 345.6789"`. Assert all new digits are present in the DOM.

9. **Identical value re-render does not crash** — render with `value="1.23"`, rerender with the same `value="1.23"`. Assert the component is stable (no error, same digit count).

10. **Reduced motion: animation disabled** — mock `useReducedMotion` from `framer-motion` to return `true`. Render with `value="1.23"`. Verify:
    - The component still renders all digits correctly
    - The motion wrapper uses `transition.duration = 0` or equivalent (check that `animate` prop is still set but transition is instant)

    ```tsx
    // Mock at the top of the test file:
    vi.mock('framer-motion', async () => {
      const actual = await vi.importActual('framer-motion')
      return { ...actual, useReducedMotion: () => true }
    })
    ```
    Run this test in a separate `describe('reduced motion')` block with its own mock scope.

11. **LINE_HEIGHT_PX export** — import `LINE_HEIGHT_PX` from `@/components/DigitRoller` and assert it equals `32`. This guards against accidental changes to the default constant.

12. **Snapshot stability** — snapshot test to catch unintended structural changes. Render `value="1 234.56"` with `prefix="~"` and match against a stored snapshot.

#### Integration smoke test — SwapBox

13. **SwapBox renders DigitRoller when not loading** — render `SwapBox` with a mocked quote result (non-loading state). Assert that:
    - A `DigitRoller` component (or its container with `tabular-nums` class) is present in the DOM
    - The `~` prefix is visible
    - The output amount digits are rendered

    Use the same SwapBox test setup patterns from existing `__tests__/components/SwapBox.test.tsx` (mock wagmi hooks, mock useQuote, etc.). If the existing mocks are complex, wrap this in a try/catch and skip gracefully with `test.todo` if the mock setup fails — document why in a comment.

14. **SwapBox shows loading pulse when quoteLoading=true** — render SwapBox with `quoteLoading: true` in the mocked hook. Assert that the `animate-pulse` span with `...` is visible and NO `DigitRoller` is rendered.

### Do NOT

1. Do NOT test the spring animation timing or physics (non-deterministic in JSDOM)
2. Do NOT import Framer Motion test utilities — they are unnecessary
3. Do NOT modify any existing test files
4. Do NOT mock `getComputedStyle` for the line-height measurement — JSDOM returns `""` for computed styles, which is why the component falls back to the `LINE_HEIGHT_PX` constant. The tests exercise the fallback path, which is correct.

### Files affected

| File | Action |
|------|--------|
| `__tests__/components/DigitRoller.test.tsx` | **CREATE** — new test file |

### Expected output

- 1 commit: `test(swap): add DigitRoller component and integration tests [P192]`

### Quality criteria

1. All 14 test cases pass (12 unit + 2 integration smoke)
2. No mocking of Framer Motion required except for `useReducedMotion` in test #10
3. Tests run in < 3s
4. Snapshot test prevents silent structural regressions
5. Integration tests verify the roller is actually wired into SwapBox (not just tested in isolation)

---

## Sprint Summary

| Prompt | Scope | Files | Tests |
|--------|-------|-------|-------|
| P191 | DigitRoller component + SwapBox integration | 1 new + 1 edit | — |
| P192 | DigitRoller unit + integration tests | 1 new | ~14 new |

**Total estimated scope:** 2 commits, 2 new files, 1 edit, ~14 new tests.

**Prompt numbering note:** This sprint was originally drafted with P183/P184 but those IDs were claimed by Sprint 35 (wagmi v3 prep). Renumbered to P191/P192 to avoid collision. The sequence is: Sprint 35 (P183–P186), Sprint 36 (P187–P190), Sprint 34 (P191–P192).

**Risk assessment:** LOW. The change is purely visual (animation layer on existing data flow). The `outputDisplay` string is untouched — the roller consumes it as a formatted string. Worst case failure mode: animation doesn't work → static number still shows (Framer Motion gracefully degrades with `initial={false}`).

**Mobile performance note:** Framer Motion uses GPU-composited transforms (`will-change: transform`), so mobile performance should be fine. However, the Code Agent should verify in Chrome DevTools mobile emulation that animating 12 simultaneous digit columns does not cause frame drops. If it does, reduce the stagger to 0 (all digits animate together = fewer repaints) or reduce spring `stiffness` to shorten animation duration. Document any such adjustment in FEEDBACK.md.
