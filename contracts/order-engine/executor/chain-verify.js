/**
 * [FIX-KEEPER-BOOT-CHAIN-VERIFICATION] Boot-time chain/contract binding verification.
 *
 * PROBLEM. validateConfig() only asserts that ORDER_EXECUTOR_ADDRESS is PRESENT. It never asks the
 * chain whether that address is a real contract, nor whether the RPC the keeper is about to send
 * fund-moving transactions through is even the chain named by CHAIN_ID. The keeper runs one
 * instance per chain (CHAIN_ID) and has no per-chain executor table (unlike the app's
 * ORDER_EXECUTOR_V3_BY_CHAIN in src/lib/order-engine/config.ts), so a keeper started with
 * CHAIN_ID=42161 and a mainnet executor address passes every existing check and starts working.
 * The same deployer EOA at the same nonce lands on the SAME address on every EVM chain, so a
 * cross-chain address collision is not hypothetical — and the same address means different
 * bytecode (0xeFC3…f130 is the OrderExecutor on mainnet and a FeeCollector on Base; see the
 * comment at the top of src/lib/order-engine/config.ts). Config asserts what an address IS;
 * nobody asks the chain.
 *
 * WHAT THIS DOES, at boot, before any work:
 *   1. eth_chainId from the configured RPC must equal CHAIN_ID.
 *   2. eth_getCode(<executor>) must be non-empty.
 *   3. The contract must self-identify: ORDER_TYPEHASH() must equal the EIP-712 type hash of the
 *      exact Order struct this keeper encodes calldata for. This is the ADR-018
 *      (feed-self-identification) pattern applied to the executor: do not infer identity from an
 *      address, ask the deployed contract what it is and compare to what we expect.
 *
 * WHY ORDER_TYPEHASH IS THE RIGHT IDENTITY READ. It is a `bytes32 public constant` on both
 * TeraSwapOrderExecutor.sol (v2, line 107) and TeraSwapOrderExecutorV3.sol (v3, line 120) — a
 * cheap, view, argument-free getter with no storage read. Its pre-image is the SAME field list the
 * keeper's ORDER_EXECUTOR_ABI / ORDER_EXECUTOR_V3_ABI tuple encodes, so the check cannot be
 * over-strict: if the deployed contract's typehash disagrees with ours, this keeper's executeOrder
 * calldata is already malformed for that contract and refusing to boot is the correct outcome. It
 * also separates v2 from v3 by construction (v3 inserts `uint16 maxSlippageBps`), catching a v2/v3
 * address swap in the env.
 *
 * FAIL CLOSED. Every failure mode — mismatch, empty code, unreachable RPC, timeout, malformed
 * response, a client that cannot answer at all — refuses the boot. Retries are bounded and the
 * terminal state after they are exhausted is still refusal. There is no warn-and-continue path, no
 * default, and no assumption on error.
 *
 * DELIBERATELY NOT HERE: a per-chain executor address table. That would change the ops config
 * contract (today: one address env per keeper instance) and is a separate decision — see FEEDBACK.
 * This module verifies whatever address ops configured against whatever chain the RPC actually is.
 */

import { keccak256, stringToHex } from "viem"

// ── The identity read ────────────────────────────────────────────────────────────────────────
// Minimal ABI: the auto-generated getter for `bytes32 public constant ORDER_TYPEHASH`.
export const ORDER_TYPEHASH_ABI = [
  {
    name: "ORDER_TYPEHASH",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "bytes32" }],
  },
]

/**
 * EIP-712 Order type strings, verbatim from the deployed contracts' `ORDER_TYPEHASH` pre-image.
 * v2 → TeraSwapOrderExecutor.sol:107. v3 → TeraSwapOrderExecutorV3.sol:120 (adds maxSlippageBps).
 * Keep these byte-identical to the Solidity string literals; the expectations below are derived
 * from them, never hardcoded independently.
 */
export const ORDER_TYPEHASH_V2_SIGNATURE =
  "Order(address owner,address tokenIn,address tokenOut,uint256 amountIn," +
  "uint256 minAmountOut,uint8 orderType,uint8 condition,uint256 targetPrice," +
  "address priceFeed,uint256 expiry,uint256 nonce,address router," +
  "bytes32 routerDataHash,uint256 dcaInterval,uint256 dcaTotal)"

export const ORDER_TYPEHASH_V3_SIGNATURE =
  "Order(address owner,address tokenIn,address tokenOut,uint256 amountIn," +
  "uint256 minAmountOut,uint16 maxSlippageBps,uint8 orderType,uint8 condition," +
  "uint256 targetPrice,address priceFeed,uint256 expiry,uint256 nonce,address router," +
  "bytes32 routerDataHash,uint256 dcaInterval,uint256 dcaTotal)"

/**
 * v2 expectation: 0x4c8bd2ee0e4c450f7c9ded5a85150c64e0e4bb10b1961d80fa93e463f11c9be5 — confirmed
 * by eth_call against BOTH live v2 deployments while writing this module (mainnet
 * 0xeFC31ADb5d10c51Ac4383bB770E2fdC65780f130 and Base 0x135B339902Ea4E0fB4CF059961dc8856bA1D2598).
 * Pinned by chain-verify.test.mjs so a source edit to the type string cannot silently move it.
 */
export const EXPECTED_ORDER_TYPEHASH_V2 = keccak256(stringToHex(ORDER_TYPEHASH_V2_SIGNATURE))

/**
 * v3 expectation. Derived from the audited v3 source (ADR-013 §1, SHA 954c415); no live v3 address
 * is committed to this repo (it is env-only), so unlike v2 this value was not re-read on-chain
 * here — see FEEDBACK. It is only ever asserted when ORDER_EXECUTOR_V3_ADDRESS is set.
 */
export const EXPECTED_ORDER_TYPEHASH_V3 = keccak256(stringToHex(ORDER_TYPEHASH_V3_SIGNATURE))

// ── Bounded-retry knobs ──────────────────────────────────────────────────────────────────────
// A transient RPC hiccup should not need an ops restart, but the terminal state after ATTEMPTS
// failures is refusal, never a downgrade to "assume it's fine".
export const DEFAULT_ATTEMPTS = 3
export const DEFAULT_RETRY_DELAY_MS = 1_000
export const DEFAULT_TIMEOUT_MS = 10_000

/** Thrown for every refusal. `check` / `chainId` / `value` are for tests + structured logging. */
export class ChainVerificationError extends Error {
  constructor(message, { check, chainId, value = null } = {}) {
    super(message)
    this.name = "ChainVerificationError"
    this.check = check
    this.chainId = chainId
    this.value = value
  }
}

// NOTE — these timers are deliberately NOT .unref()'d. An earlier revision unref'd both, which
// looked harmless and was a FAIL-OPEN: when the gate is the only thing on the event loop (it runs
// before the health server, the monitor and the poll interval exist) and the RPC accepts the
// connection then goes silent, an unref'd timeout means Node drains the loop and the process dies
// with a bare "unsettled top-level await" — exit without ever printing the refusal. A boot gate
// must reach a verdict, so it holds the loop open until it does. Pinned by the subprocess test in
// chain-verify.test.mjs, which runs the gate with nothing else alive.
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Reject if `run()` has not settled within timeoutMs. An RPC that accepts the connection and then
 * never answers is the failure mode a plain await cannot survive: without this the keeper hangs at
 * boot forever, which is neither "running" nor "refused".
 */
function withTimeout(run, timeoutMs) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return Promise.resolve().then(run)
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs)
  })
  return Promise.race([Promise.resolve().then(run), timeout]).finally(() => clearTimeout(timer))
}

/** Bounded retry around a single RPC call. Throws the LAST error once attempts are exhausted. */
async function callWithRetry(run, { attempts, retryDelayMs, timeoutMs, sleep }) {
  let lastErr
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await withTimeout(run, timeoutMs)
    } catch (err) {
      lastErr = err
      if (attempt < attempts) await sleep(retryDelayMs)
    }
  }
  throw lastErr
}

/**
 * A refusal line is the text an operator pastes into a ticket, and RPC_URL routinely carries the
 * provider API key in its path (…/v2/<key>). Transport errors quote the URL they failed on, so
 * every string that reaches a message goes through here first. Redaction is EXPLICIT — relying on
 * viem populating `shortMessage` (which omits the URL) is not a control: a plain Error, an
 * AggregateError, a proxy/undici failure or a future viem version all fall through to `.message`,
 * which does carry it.
 */
const URL_LIKE = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>)\],]+/gi

export function redactUrls(text) {
  return String(text).replace(URL_LIKE, "<redacted-url>")
}

const errText = (err) => redactUrls((err && err.shortMessage) || (err && err.message) || String(err))

/**
 * Render an unexpected RPC answer for an error message. Deliberately NOT bare JSON.stringify:
 * a BigInt throws there, which would turn a refusal into a confusing TypeError from inside the
 * very code path whose job is to refuse clearly. Redacted for the same reason as errText — a
 * malformed answer can itself be a URL string.
 */
function describeValue(value) {
  if (typeof value === "bigint") return `${value}n`
  try {
    const json = JSON.stringify(value)
    return redactUrls(json === undefined ? String(value) : json)
  } catch {
    return redactUrls(String(value))
  }
}

/** Only a positive, safe-integer chain id is acceptable. Anything else is malformed ⇒ refusal. */
function normalizeChainId(raw) {
  if (typeof raw === "bigint") {
    return raw > 0n && raw <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(raw) : null
  }
  if (typeof raw === "number" && Number.isSafeInteger(raw) && raw > 0) return raw
  return null
}

const HEX_BODY = /^0x([0-9a-fA-F]{2})*$/
const BYTES32 = /^0x[0-9a-fA-F]{64}$/

/**
 * Adapt a viem PublicClient (or anything client-shaped) to the 3-method port this module needs.
 * The port is what makes the verification testable by INJECTION rather than by mocking `viem`:
 * tests hand `verifyChainBinding` a plain object, and if the production call site ever stops
 * routing through the port the injected double stops being reachable loudly (a wrong argument),
 * not silently.
 *
 * getCode vs getBytecode: viem renamed the action in 2.22; the keeper's own package.json pins
 * 2.47.10 while the repo root has 2.55.2. Both expose getCode, but preferring it with a
 * getBytecode fallback keeps this working on either. This is a method-NAME shim, not a
 * verification fallback — a client that exposes neither is refused, not assumed good.
 */
export function createRpcProbe(client) {
  if (!client || typeof client !== "object") {
    throw new ChainVerificationError(
      "FATAL: cannot verify the chain binding — no RPC client was provided to createRpcProbe",
      { check: "probe" },
    )
  }
  const readCode =
    typeof client.getCode === "function"
      ? (args) => client.getCode(args)
      : typeof client.getBytecode === "function"
        ? (args) => client.getBytecode(args)
        : null
  if (typeof client.getChainId !== "function" || !readCode || typeof client.readContract !== "function") {
    throw new ChainVerificationError(
      "FATAL: cannot verify the chain binding — the RPC client exposes neither the required " +
        "getChainId / getCode (or getBytecode) / readContract actions",
      { check: "probe" },
    )
  }
  return {
    getChainId: () => client.getChainId(),
    getCode: (args) => readCode(args),
    readContract: (args) => client.readContract(args),
  }
}

/**
 * Verify, against the live chain, that this keeper is pointed where its config claims.
 *
 * @param {object}   opts
 * @param {object}   opts.provider   { getChainId(), getCode({address}), readContract({...}) }
 * @param {number}   opts.chainId    the configured CHAIN_ID
 * @param {Array<{label: string, address: string, expectedOrderTypehash?: string}>} opts.contracts
 * @returns {Promise<{chainId: number, contracts: Array<object>}>} resolves ONLY when every check passed
 * @throws  {ChainVerificationError} on any failure — the boot must not continue
 */
export async function verifyChainBinding({
  provider,
  chainId,
  contracts,
  attempts = DEFAULT_ATTEMPTS,
  retryDelayMs = DEFAULT_RETRY_DELAY_MS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  sleep = defaultSleep,
  log = () => {},
} = {}) {
  // ── Argument sanity. A malformed call is itself a refusal, never a skip. ──
  if (
    !provider ||
    typeof provider.getChainId !== "function" ||
    typeof provider.getCode !== "function" ||
    typeof provider.readContract !== "function"
  ) {
    throw new ChainVerificationError(
      `FATAL: cannot verify the chain binding for CHAIN_ID=${chainId} — no usable RPC provider ` +
        "(getChainId / getCode / readContract) was supplied",
      { check: "provider", chainId, value: null },
    )
  }
  const expectedChainId = normalizeChainId(chainId)
  if (expectedChainId === null) {
    throw new ChainVerificationError(
      `FATAL: CHAIN_ID is not a valid chain id (received ${describeValue(chainId)}) — refusing to boot`,
      { check: "config", chainId, value: chainId },
    )
  }
  if (!Array.isArray(contracts) || contracts.length === 0) {
    throw new ChainVerificationError(
      `FATAL: no executor address to verify on chain ${expectedChainId} — refusing to boot`,
      { check: "config", chainId: expectedChainId, value: contracts ?? null },
    )
  }
  // Every entry must be FULLY specified before the network is touched. `expectedOrderTypehash` is
  // REQUIRED, not optional: an entry without one would quietly degrade to "there is some code at
  // this address", which is precisely the assurance level this module exists to replace — and the
  // degradation would be invisible, because the happy path still resolves.
  for (const entry of contracts) {
    const label = (entry && entry.label) || "executor"
    const address = entry && entry.address
    if (typeof address !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
      throw new ChainVerificationError(
        `FATAL: ${label} is not a valid address (${describeValue(address ?? null)}) on chain ` +
          `${expectedChainId} — refusing to boot`,
        { check: "address", chainId: expectedChainId, value: address ?? null },
      )
    }
    const expected = entry.expectedOrderTypehash
    if (typeof expected !== "string" || !BYTES32.test(expected)) {
      throw new ChainVerificationError(
        `FATAL: ${label} ${address} on chain ${expectedChainId} has no usable ` +
          `expectedOrderTypehash (${describeValue(expected ?? null)}) — identity verification is ` +
          `mandatory, a contract that is never asked what it is cannot be verified. Refusing to boot.`,
        { check: "config", chainId: expectedChainId, value: expected ?? null },
      )
    }
  }
  const retry = { attempts: Math.max(1, attempts), retryDelayMs, timeoutMs, sleep }

  // ── Check 1: the RPC must BE the chain we were configured for ──
  let rawChainId
  try {
    rawChainId = await callWithRetry(() => provider.getChainId(), retry)
  } catch (err) {
    throw new ChainVerificationError(
      `FATAL: could not read eth_chainId from the configured RPC while verifying CHAIN_ID=` +
        `${expectedChainId} after ${retry.attempts} attempt(s): ${errText(err)} — refusing to boot`,
      { check: "chainId", chainId: expectedChainId, value: null },
    )
  }
  const reportedChainId = normalizeChainId(rawChainId)
  if (reportedChainId === null) {
    throw new ChainVerificationError(
      `FATAL: the configured RPC returned a malformed eth_chainId (${describeValue(rawChainId)}) ` +
        `while verifying CHAIN_ID=${expectedChainId} — refusing to boot`,
      { check: "chainId", chainId: expectedChainId, value: rawChainId },
    )
  }
  if (reportedChainId !== expectedChainId) {
    throw new ChainVerificationError(
      `FATAL: RPC/chain mismatch — the configured RPC reports chain ${reportedChainId} but this ` +
        `keeper is configured for CHAIN_ID=${expectedChainId}. Point RPC_URL at chain ` +
        `${expectedChainId} or correct CHAIN_ID — refusing to boot.`,
      { check: "chainId", chainId: expectedChainId, value: reportedChainId },
    )
  }
  log(`[chain-verify] eth_chainId = ${reportedChainId} — matches CHAIN_ID`)

  // ── Checks 2 + 3, per configured executor ──
  const verified = []
  for (const entry of contracts) {
    const label = entry.label || "executor"
    const address = entry.address

    // Check 2: there must be a contract there, on THIS chain.
    let code
    try {
      code = await callWithRetry(() => provider.getCode({ address }), retry)
    } catch (err) {
      throw new ChainVerificationError(
        `FATAL: could not read eth_getCode for ${label} ${address} on chain ${expectedChainId} ` +
          `after ${retry.attempts} attempt(s): ${errText(err)} — refusing to boot`,
        { check: "code", chainId: expectedChainId, value: address },
      )
    }
    if (code === undefined || code === null || code === "0x" || code === "") {
      throw new ChainVerificationError(
        `FATAL: no contract code at ${label} ${address} on chain ${expectedChainId} — that address ` +
          `is an EOA or is undeployed HERE (the same address is a different contract, or none, on ` +
          `another chain). Refusing to boot.`,
        { check: "code", chainId: expectedChainId, value: address },
      )
    }
    if (typeof code !== "string" || !HEX_BODY.test(code)) {
      throw new ChainVerificationError(
        `FATAL: malformed eth_getCode response for ${label} ${address} on chain ${expectedChainId} ` +
          `(${describeValue(code)}) — refusing to boot`,
        { check: "code", chainId: expectedChainId, value: code },
      )
    }
    const codeSize = (code.length - 2) / 2
    log(`[chain-verify] ${label} ${address} — ${codeSize} bytes of code on chain ${expectedChainId}`)

    // Check 3: the contract must say what it is, and it must be what we expect. Unconditional —
    // `expectedOrderTypehash` was already proven present by the upfront entry validation, so there
    // is no branch here in which an entry gets away with code-existence only.
    const expectedTypehash = entry.expectedOrderTypehash
    let typehash
    try {
      typehash = await callWithRetry(
        () =>
          provider.readContract({
            address,
            abi: ORDER_TYPEHASH_ABI,
            functionName: "ORDER_TYPEHASH",
          }),
        retry,
      )
    } catch (err) {
      throw new ChainVerificationError(
        `FATAL: could not read ORDER_TYPEHASH() from ${label} ${address} on chain ` +
          `${expectedChainId} after ${retry.attempts} attempt(s): ${errText(err)} — the address ` +
          `may not be a TeraSwapOrderExecutor at all. Refusing to boot.`,
        { check: "identity", chainId: expectedChainId, value: address },
      )
    }
    if (typeof typehash !== "string" || !BYTES32.test(typehash)) {
      throw new ChainVerificationError(
        `FATAL: ${label} ${address} on chain ${expectedChainId} returned a malformed ` +
          `ORDER_TYPEHASH (${describeValue(typehash)}) — refusing to boot`,
        { check: "identity", chainId: expectedChainId, value: typehash },
      )
    }
    if (typehash.toLowerCase() !== expectedTypehash.toLowerCase()) {
      throw new ChainVerificationError(
        `FATAL: contract identity mismatch — ${label} ${address} on chain ${expectedChainId} ` +
          `reports ORDER_TYPEHASH ${typehash}, expected ${expectedTypehash}. The configured ` +
          `address is not the executor whose Order struct this keeper encodes calldata for. ` +
          `Refusing to boot.`,
        { check: "identity", chainId: expectedChainId, value: typehash },
      )
    }
    log(`[chain-verify] ${label} ${address} — ORDER_TYPEHASH ${typehash} matches`)
    verified.push({ label, address, codeSize, orderTypehash: typehash })
  }

  return { chainId: expectedChainId, contracts: verified }
}
