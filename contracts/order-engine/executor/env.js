/**
 * env.js — deterministic .env.executor loading. [KEEPER-ENV-ORDER]
 *
 * MUST be the FIRST import statement of every entrypoint in this directory
 * (executor.js, backfill-execution.mjs). Nothing here needs to be called:
 * the load happens as a side effect of this module's body.
 *
 * Why a dedicated module: ESM evaluates the whole import graph depth-first
 * BEFORE the importing module's body runs. executor.js used to call loadEnv in
 * its body, so every first-party module that reads process.env at module scope
 * (alert.js's CHAIN_ID, retry-policy's caps, deviation-guard's thresholds) was
 * evaluated BEFORE the file was loaded and silently kept its default — measured
 * in production as a CHAIN_ID=8453 keeper stamping Telegram alerts "Chain: 1".
 * Importing this module first makes the order deterministic: the file is in
 * process.env before any later import evaluates.
 *
 * Shell env always wins: loadEnv never overrides a variable that is already set.
 */

import { readFileSync } from "fs"
import { join } from "path"

// Exported for direct unit tests only (env-order.test.mjs) — no caller needs it.
export function loadEnv(filePath) {
  try {
    const content = readFileSync(filePath, "utf-8")
    for (const line of content.split("\n")) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith("#")) continue
      const eqIndex = trimmed.indexOf("=")
      if (eqIndex === -1) continue
      const key = trimmed.slice(0, eqIndex).trim()
      const value = trimmed.slice(eqIndex + 1).trim()
      if (!process.env[key]) {
        process.env[key] = value
      }
    }
  } catch (err) {
    console.warn(`WARNING: Could not load ${filePath}: ${err.message}`)
  }
}

// Use process.cwd() -- works with spaces in path
loadEnv(join(process.cwd(), ".env.executor"))
