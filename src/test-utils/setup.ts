/**
 * [P115/M-01] Global vitest setup.
 *
 * Runs once per test process, before any test file. Two jobs:
 *   1. Wire @testing-library/jest-dom into vitest's `expect` so DOM
 *      matchers like toBeInTheDocument()/toHaveTextContent() exist.
 *      Without this, .tsx component tests have to fall back to raw
 *      DOM assertions.
 *   2. After each test, clear any rendered DOM so the next test starts
 *      from a clean state (jsdom env only — no-op for node-env tests).
 *
 * Kept thin. Anything heavier belongs in a per-file beforeEach so the
 * cost is opt-in rather than paid by every node-env test.
 */
import '@testing-library/jest-dom/vitest'
import { afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'

// `cleanup` is a no-op when there's nothing rendered (node-env tests).
afterEach(() => cleanup())
