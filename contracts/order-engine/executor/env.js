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
 *
 * [FIX-KEEPER-MULTICHAIN-INSTANCE-IDENTITY] WHICH file: `EXECUTOR_ENV_FILE` (relative to cwd, or
 * absolute), default `.env.executor`. Two keeper processes (Base + Arbitrum One) run from this
 * same directory under pm2, so each app names its own file in its pm2 `env` block — that is shell
 * env from this module's point of view, so it is already set when this body runs, and the file it
 * names is loaded before any later import evaluates (same guarantee as above; pinned by
 * env-order.test.mjs). The Base process sets nothing and keeps `.env.executor`, byte-for-byte.
 */

import { readFileSync } from "fs"
import { resolve } from "path"

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

// Use process.cwd() -- works with spaces in path. `resolve` (not `join`) so an absolute
// EXECUTOR_ENV_FILE is honoured as given.
export const ENV_FILE = resolve(process.cwd(), process.env.EXECUTOR_ENV_FILE || ".env.executor")
loadEnv(ENV_FILE)
