/**
 * Post-execution balance validation — P45.
 *
 * After a swap is confirmed on-chain, this module reads the TX receipt,
 * extracts actual token output (via Transfer event logs or balanceOf
 * fallback), and compares against the expected minimum.
 *
 * Severity levels:
 *   ok       — actual >= expected
 *   warning  — actual is 0–2% below expected
 *   critical — actual is >2% below expected (triggers P0 alert + auto-disable)
 *
 * Graceful degradation: RPC failures return status 'unknown' with the error
 * reason. The validator never throws — callers always get a result object.
 *
 * @internal — server-only module. Called by POST /api/monitor/validate-execution.
 */

import { createPublicClient, http, parseAbi, formatUnits, type PublicClient, type Log } from 'viem'
import { mainnet } from 'viem/chains'
import { kv } from '@vercel/kv'
import { emitTransitionAlert } from './alert-wrapper'
import { forceDisable } from './source-state-machine'

// ── Types ────────────────────────────────────────────────

export type ValidationSeverity = 'ok' | 'warning' | 'critical' | 'unknown'

export interface ExecutionValidation {
  txHash: string
  source: string
  severity: ValidationSeverity
  /** Actual output amount (raw token units as string), null if unknown */
  actualOutput: string | null
  /** Expected minimum output (raw token units as string) */
  expectedMinOutput: string
  /** Shortfall percentage (e.g. 0.015 = 1.5% below expected). 0 if ok, null if unknown */
  shortfallPercent: number | null
  /** Human-readable summary */
  reason: string
  /** Token address that was checked */
  tokenOut: string
  /** Token decimals (for display) */
  tokenOutDecimals: number
  /** Whether output was extracted from Transfer logs or balanceOf fallback */
  extractionMethod: 'transfer_logs' | 'balance_diff' | 'none'
  /** ISO 8601 timestamp of validation */
  validatedAt: string
}

export interface ValidateExecutionParams {
  txHash: string
  source: string
  /** Address of the user/recipient wallet */
  recipient: string
  /** Output token address */
  tokenOut: string
  /** Output token decimals */
  tokenOutDecimals: number
  /** Expected minimum output in raw token units */
  expectedMinOutput: string
  /** Optional: user's pre-swap balance of tokenOut (enables balance_diff fallback) */
  preSwapBalance?: string
}

// ── Constants ────────────────────────────────────────────

/** Shortfall below expected: 0–2% is warning, >2% is critical */
const WARNING_THRESHOLD = 0.02

/** KV audit trail key prefix and TTL */
const AUDIT_KEY_PREFIX = 'teraswap:execution-audit:'
const AUDIT_TTL_SECONDS = 7 * 24 * 60 * 60 // 7 days

// ── RPC client ───────────────────────────────────────────

function getServerClient(): PublicClient {
  const rpcUrl = process.env.RPC_URL
    || process.env.NEXT_PUBLIC_RPC_URL
    || 'https://eth.llamarpc.com'

  return createPublicClient({
    chain: mainnet,
    transport: http(rpcUrl),
  })
}

// ── Transfer log extraction ──────────────────────────────

/**
 * Sum all ERC-20 Transfer events to `recipient` for `tokenOut` in the receipt.
 * Returns null if no matching transfers found.
 */
function extractTransferAmount(
  logs: Log[],
  tokenOut: string,
  recipient: string,
): bigint | null {
  const tokenLower = tokenOut.toLowerCase()
  const recipientLower = recipient.toLowerCase()

  // Transfer topic0: keccak256("Transfer(address,address,uint256)")
  const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'

  let total = 0n
  let found = false

  for (const log of logs) {
    // Match token contract
    if (log.address.toLowerCase() !== tokenLower) continue
    // Match Transfer event
    if (!log.topics[0] || log.topics[0] !== TRANSFER_TOPIC) continue
    // topic[2] = 'to' address (padded to 32 bytes)
    const toTopic = log.topics[2]
    if (!toTopic) continue
    // Extract address from padded topic (last 40 hex chars)
    const toAddr = '0x' + toTopic.slice(-40)
    if (toAddr.toLowerCase() !== recipientLower) continue

    // Decode value from log data
    try {
      const value = BigInt(log.data)
      total += value
      found = true
    } catch {
      // Malformed log data — skip
    }
  }

  return found ? total : null
}

// ── Core validation ──────────────────────────────────────

export async function validateExecution(
  params: ValidateExecutionParams,
): Promise<ExecutionValidation> {
  const {
    txHash, source, recipient, tokenOut,
    tokenOutDecimals, expectedMinOutput, preSwapBalance,
  } = params

  const now = new Date().toISOString()
  const baseResult: Omit<ExecutionValidation, 'severity' | 'reason' | 'actualOutput' | 'shortfallPercent' | 'extractionMethod'> = {
    txHash,
    source,
    expectedMinOutput,
    tokenOut,
    tokenOutDecimals,
    validatedAt: now,
  }

  let client: PublicClient
  try {
    client = getServerClient()
  } catch (err) {
    const result: ExecutionValidation = {
      ...baseResult,
      severity: 'unknown',
      actualOutput: null,
      shortfallPercent: null,
      extractionMethod: 'none',
      reason: `RPC client init failed: ${err instanceof Error ? err.message : String(err)}`,
    }
    await writeAuditTrail(result)
    return result
  }

  // ── Step 1: Fetch TX receipt ──────────────────────────
  let receipt
  try {
    receipt = await client.getTransactionReceipt({
      hash: txHash as `0x${string}`,
    })
  } catch (err) {
    const result: ExecutionValidation = {
      ...baseResult,
      severity: 'unknown',
      actualOutput: null,
      shortfallPercent: null,
      extractionMethod: 'none',
      reason: `Failed to fetch receipt: ${err instanceof Error ? err.message : String(err)}`,
    }
    await writeAuditTrail(result)
    return result
  }

  if (!receipt) {
    const result: ExecutionValidation = {
      ...baseResult,
      severity: 'unknown',
      actualOutput: null,
      shortfallPercent: null,
      extractionMethod: 'none',
      reason: 'Transaction receipt not found (may not be mined yet)',
    }
    await writeAuditTrail(result)
    return result
  }

  // ── Step 1b: Check TX status ──────────────────────────
  if (receipt.status === 'reverted') {
    const result: ExecutionValidation = {
      ...baseResult,
      severity: 'critical',
      actualOutput: '0',
      shortfallPercent: 1, // 100% shortfall
      extractionMethod: 'none',
      reason: 'Transaction reverted on-chain — zero output',
    }
    await writeAuditTrail(result)
    await handleCritical(result)
    return result
  }

  // ── Step 2: Extract actual output from Transfer logs ──
  let actualOutput: bigint | null = null
  let extractionMethod: ExecutionValidation['extractionMethod'] = 'none'

  actualOutput = extractTransferAmount(receipt.logs as Log[], tokenOut, recipient)
  if (actualOutput !== null) {
    extractionMethod = 'transfer_logs'
  }

  // ── Step 3: Fallback to balance diff if Transfer logs didn't yield result ──
  if (actualOutput === null && preSwapBalance != null) {
    try {
      const postBalance = await client.readContract({
        address: tokenOut as `0x${string}`,
        abi: parseAbi(['function balanceOf(address) view returns (uint256)']),
        functionName: 'balanceOf',
        args: [recipient as `0x${string}`],
      })
      const pre = BigInt(preSwapBalance)
      if (postBalance > pre) {
        actualOutput = postBalance - pre
        extractionMethod = 'balance_diff'
      }
    } catch (err) {
      console.warn(`[P45] balanceOf fallback failed for ${tokenOut}:`, err instanceof Error ? err.message : err)
    }
  }

  // ── Step 4: If we still have no output data ───────────
  if (actualOutput === null) {
    const result: ExecutionValidation = {
      ...baseResult,
      severity: 'unknown',
      actualOutput: null,
      shortfallPercent: null,
      extractionMethod: 'none',
      reason: 'Could not extract output amount from receipt logs or balance query',
    }
    await writeAuditTrail(result)
    return result
  }

  // ── Step 5: Compare actual vs expected ────────────────
  const expected = BigInt(expectedMinOutput)
  const actual = actualOutput

  // Guard: if expected is 0, any output is fine
  if (expected === 0n) {
    const result: ExecutionValidation = {
      ...baseResult,
      severity: 'ok',
      actualOutput: actual.toString(),
      shortfallPercent: 0,
      extractionMethod,
      reason: 'Expected output is 0 — any output is acceptable',
    }
    await writeAuditTrail(result)
    return result
  }

  if (actual >= expected) {
    // ── OK: got at least what we expected
    const surplus = actual - expected
    const surplusPct = Number(surplus) / Number(expected)
    const actualFmt = formatUnits(actual, tokenOutDecimals)
    const result: ExecutionValidation = {
      ...baseResult,
      severity: 'ok',
      actualOutput: actual.toString(),
      shortfallPercent: 0,
      extractionMethod,
      reason: surplusPct > 0.001
        ? `Output ${actualFmt} exceeds minimum by ${(surplusPct * 100).toFixed(2)}%`
        : `Output ${actualFmt} meets expected minimum`,
    }
    await writeAuditTrail(result)
    return result
  }

  // ── Shortfall: actual < expected
  const shortfall = expected - actual
  const shortfallPct = Number(shortfall) / Number(expected)
  const actualFmt = formatUnits(actual, tokenOutDecimals)
  const expectedFmt = formatUnits(expected, tokenOutDecimals)

  if (shortfallPct <= WARNING_THRESHOLD) {
    // ── WARNING: 0–2% below expected
    const result: ExecutionValidation = {
      ...baseResult,
      severity: 'warning',
      actualOutput: actual.toString(),
      shortfallPercent: shortfallPct,
      extractionMethod,
      reason: `Output ${actualFmt} is ${(shortfallPct * 100).toFixed(2)}% below expected ${expectedFmt}`,
    }
    await writeAuditTrail(result)
    return result
  }

  // ── CRITICAL: >2% below expected
  const result: ExecutionValidation = {
    ...baseResult,
    severity: 'critical',
    actualOutput: actual.toString(),
    shortfallPercent: shortfallPct,
    extractionMethod,
    reason: `Output ${actualFmt} is ${(shortfallPct * 100).toFixed(2)}% below expected ${expectedFmt} — source may be returning bad quotes`,
  }
  await writeAuditTrail(result)
  await handleCritical(result)
  return result
}

// ── Critical severity handler ────────────────────────────

async function handleCritical(result: ExecutionValidation): Promise<void> {
  const { source, txHash, reason } = result

  // Auto-disable the source
  try {
    await forceDisable(source, `execution-validation-critical: ${reason.slice(0, 200)}`)
  } catch (err) {
    console.error(`[P45] Failed to auto-disable ${source}:`, err instanceof Error ? err.message : err)
  }

  // Emit P0 alert
  try {
    await emitTransitionAlert(
      source,
      'active', // from (best guess — alert-wrapper handles dedup)
      'disabled',
      `execution-validation-critical: tx=${txHash} — ${reason.slice(0, 200)}`,
    )
  } catch (err) {
    console.error(`[P45] Alert emission failed for ${source}:`, err instanceof Error ? err.message : err)
  }
}

// ── KV audit trail ───────────────────────────────────────

async function writeAuditTrail(result: ExecutionValidation): Promise<void> {
  const key = `${AUDIT_KEY_PREFIX}${result.txHash}`
  try {
    await kv.set(key, result, { ex: AUDIT_TTL_SECONDS })
  } catch (err) {
    // Never throw on audit write failure — log and continue
    console.warn(`[P45] Audit trail write failed for ${result.txHash}:`, err instanceof Error ? err.message : err)
  }
}

// ── Read audit trail (for debugging/admin) ───────────────

export async function getAuditTrail(txHash: string): Promise<ExecutionValidation | null> {
  try {
    return await kv.get<ExecutionValidation>(`${AUDIT_KEY_PREFIX}${txHash}`)
  } catch {
    return null
  }
}
