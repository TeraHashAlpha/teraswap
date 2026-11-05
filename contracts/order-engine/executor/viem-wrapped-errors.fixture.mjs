// viem-wrapped-errors.fixture.mjs — TEST-ONLY helper (not a test: node --test does not pick it up).
//
// [A73b S-7 / S-8] Builds the REAL viem error objects the keeper receives, exactly as viem wraps
// them, by driving viem's own clients (this directory's node_modules/viem) against a local JSON-RPC
// stub — never a bare inner error:
//
//   read  → publicClient.readContract(canExecute)    (executor.js "Check via contract")
//           ContractFunctionExecutionError → CallExecutionError → HttpRequestError | TimeoutError
//           ContractFunctionExecutionError → ContractFunctionRevertedError → … (a genuine revert)
//   write → walletClient.writeContract(executeOrder) (executor.js "TX sent")
//           ContractFunctionExecutionError → TransactionExecutionError → EstimateGasExecutionError → HttpRequestError | TimeoutError
//           ContractFunctionExecutionError → TransactionExecutionError → InsufficientFundsError → EstimateGasExecutionError → …
//           ContractFunctionExecutionError → TransactionExecutionError → NonceTooLowError → …
//
// The stub answers one JSON-RPC request per HTTP request (viem's http transport, no batching). The
// failing method is chosen per call: `eth_call` for the read site, `eth_estimateGas` (the default —
// the keeper passes no `gas`, so viem estimates before signing) or `eth_sendRawTransaction` for the
// write site. A hung request is a REAL open socket (torn down by stop()), never a handle-less promise
// (Node 20/22 cancel those — keeper-tests-ci-node-versions).

import { createServer } from "node:http"
import { once } from "node:events"
import { createPublicClient, createWalletClient, encodeErrorResult, http as httpTransport, zeroAddress } from "viem"
import { privateKeyToAccount } from "viem/accounts"

// The executor's V3 ABI for the two sites (executor.js ORDER_EXECUTOR_V3_ABI, verbatim).
const ORDER_COMPONENTS = [
  { name: "owner", type: "address" },
  { name: "tokenIn", type: "address" },
  { name: "tokenOut", type: "address" },
  { name: "amountIn", type: "uint256" },
  { name: "minAmountOut", type: "uint256" },
  { name: "maxSlippageBps", type: "uint16" },
  { name: "orderType", type: "uint8" },
  { name: "condition", type: "uint8" },
  { name: "targetPrice", type: "uint256" },
  { name: "priceFeed", type: "address" },
  { name: "expiry", type: "uint256" },
  { name: "nonce", type: "uint256" },
  { name: "router", type: "address" },
  { name: "routerDataHash", type: "bytes32" },
  { name: "dcaInterval", type: "uint256" },
  { name: "dcaTotal", type: "uint256" },
]
export const ORDER_EXECUTOR_V3_ABI = [
  {
    name: "canExecute",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "order", type: "tuple", components: ORDER_COMPONENTS },
      { name: "signature", type: "bytes" },
    ],
    outputs: [
      { name: "canExec", type: "bool" },
      { name: "reason", type: "string" },
    ],
  },
  {
    name: "executeOrder",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "order", type: "tuple", components: ORDER_COMPONENTS },
      { name: "signature", type: "bytes" },
      { name: "routerData", type: "bytes" },
    ],
    outputs: [],
  },
  // The executor's own custom error, so a coded revert decodes to a NAMED ContractFunctionRevertedError
  // (revert-decode.js does the same for the keeper).
  { name: "InsufficientOutput", type: "error", inputs: [] },
]

const EXECUTOR = "0x000000000000000000000000000000000000beef"
const ORDER_STRUCT = {
  owner: "0x00000000000000000000000000000000000000a1",
  tokenIn: "0x00000000000000000000000000000000000000b2",
  tokenOut: "0x00000000000000000000000000000000000000c3",
  amountIn: 1_000_000n,
  minAmountOut: 0n,
  maxSlippageBps: 50,
  orderType: 3,
  condition: 0,
  targetPrice: 0n,
  priceFeed: zeroAddress,
  expiry: 4_102_444_800n,
  nonce: 1n,
  router: "0x00000000000000000000000000000000000000d4",
  routerDataHash: `0x${"00".repeat(32)}`,
  dcaInterval: 3_600n,
  dcaTotal: 10n,
}
const SIGNATURE = `0x${"11".repeat(65)}`
const ROUTER_DATA = "0x12345678"
// A throwaway test key (never a literal 64-hex secret): 0x1111…11 is a valid secp256k1 scalar.
const TEST_KEY = `0x${"11".repeat(32)}`
const CHAIN = {
  id: 8453,
  name: "stub",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [] } },
}

// The 4-byte selector of InsufficientOutput() — revert data that decodes against the ABI above.
export const INSUFFICIENT_OUTPUT_DATA = "0xbb2875c3"
/** ABI-encoded `Error(string)` revert data — what a `require(…, reason)` revert carries. */
export function revertStringData(reason) {
  return encodeErrorResult({ abi: [{ type: "error", name: "Error", inputs: [{ type: "string", name: "reason" }] }], errorName: "Error", args: [reason] })
}

/**
 * What the stub answers for the failing method. One of:
 *   { http: 503, body?: string }                       — an HTTP error page from the provider
 *   { hang: true }                                     — never answers (viem's TimeoutError, transport timeout)
 *   { rpc: { code, message, data? } }                  — a JSON-RPC error body (the node's words)
 *   { http: 500, rpc: { code, message, data? } }       — the same body on a non-2xx response
 * Every other method gets a plumbing answer (chainId / nonce / gas / tx hash).
 */
function answer(method, params, spec, failAt) {
  if (method === failAt) return spec
  switch (method) {
    case "eth_fillTransaction":
      // viem 2.47 probes it first; a geth-family node (Base / Arbitrum / mainnet providers) has no such
      // method, so viem falls back to eth_getTransactionCount + eth_estimateGas — the keeper's real path.
      return { rpc: { code: -32601, message: "the method eth_fillTransaction does not exist/is not available" } }
    case "eth_chainId":
      return { result: "0x2105" }
    case "eth_getTransactionCount":
      return { result: "0x1" }
    case "eth_estimateGas":
      return { result: "0x5208" }
    case "eth_sendRawTransaction":
      return { result: `0x${"ab".repeat(32)}` }
    case "eth_blockNumber":
      return { result: "0x10" }
    case "eth_getBlockByNumber":
      return { result: { number: "0x10", baseFeePerGas: "0x1", gasLimit: "0x1c9c380", transactions: [] } }
    case "eth_gasPrice":
    case "eth_maxPriorityFeePerGas":
      return { result: "0x1" }
    default:
      return { result: "0x" }
  }
}

/** Start the local JSON-RPC stub. `stop()` destroys every socket (hung requests included). */
export async function startRpcStub() {
  const sockets = new Set()
  const seen = []
  let current = { spec: { result: "0x" }, failAt: "" }
  const server = createServer((req, res) => {
    let body = ""
    req.on("data", (c) => {
      body += c
    })
    req.on("end", () => {
      let rpc = null
      try {
        rpc = JSON.parse(body)
      } catch {
        /* not JSON — the plumbing below answers "0x" */
      }
      const call = Array.isArray(rpc) ? rpc[0] : rpc
      const method = call?.method ?? ""
      seen.push(method)
      const r = answer(method, call?.params, current.spec, current.failAt) || {}
      if (r.hang) return // a REAL open socket; stop() destroys it
      if (r.http && r.rpc) {
        // A non-2xx response that still carries a valid JSON-RPC error body: viem returns it into the
        // normal RPC error pipeline (utils/rpc/http.js), so it surfaces as RpcRequestError — the HTTP
        // status never reaches the keeper.
        res.writeHead(r.http, { "content-type": "application/json" })
        res.end(JSON.stringify({ jsonrpc: "2.0", id: call?.id ?? 1, error: r.rpc }))
        return
      }
      if (r.http) {
        res.writeHead(r.http, { "content-type": "text/plain" })
        res.end(r.body ?? "")
        return
      }
      res.writeHead(200, { "content-type": "application/json" })
      const payload = r.rpc
        ? { jsonrpc: "2.0", id: call?.id ?? 1, error: r.rpc }
        : { jsonrpc: "2.0", id: call?.id ?? 1, result: r.result ?? "0x" }
      res.end(JSON.stringify(payload))
    })
  })
  server.on("connection", (s) => {
    sockets.add(s)
    s.on("close", () => sockets.delete(s))
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const url = `http://127.0.0.1:${server.address().port}`
  const transport = (timeout) => httpTransport(url, { retryCount: 0, timeout })
  const publicClient = (timeout) => createPublicClient({ chain: CHAIN, transport: transport(timeout) })
  const walletClient = (timeout) =>
    createWalletClient({ account: privateKeyToAccount(TEST_KEY), chain: CHAIN, transport: transport(timeout) })

  return {
    url,
    seen,
    /**
     * The error thrown by publicClient.readContract(canExecute) when `eth_call` answers `spec`.
     * (executor.js: `const [canExec, reason] = await publicClient.readContract({ … functionName: "canExecute" … })`)
     */
    async readError(spec) {
      current = { spec, failAt: "eth_call" }
      const timeout = spec.hang ? 40 : 5_000
      try {
        await publicClient(timeout).readContract({ address: EXECUTOR, abi: ORDER_EXECUTOR_V3_ABI, functionName: "canExecute", args: [ORDER_STRUCT, SIGNATURE] })
      } catch (err) {
        return err
      }
      throw new Error("readContract did not throw")
    },
    /**
     * The error thrown by walletClient.writeContract(executeOrder) when `failAt` answers `spec`
     * (`eth_estimateGas` by default — the keeper passes no `gas`; or `eth_sendRawTransaction`).
     * (executor.js: `const txHash = await txWalletClient.writeContract({ … functionName: "executeOrder", … maxFeePerGas, maxPriorityFeePerGas })`)
     */
    async writeError(spec, { failAt = "eth_estimateGas" } = {}) {
      current = { spec, failAt }
      const timeout = spec.hang ? 40 : 5_000
      try {
        await walletClient(timeout).writeContract({
          address: EXECUTOR,
          abi: ORDER_EXECUTOR_V3_ABI,
          functionName: "executeOrder",
          args: [ORDER_STRUCT, SIGNATURE, ROUTER_DATA],
          maxFeePerGas: 1_000_000_000n,
          maxPriorityFeePerGas: 1_000_000n,
        })
      } catch (err) {
        return err
      }
      throw new Error("writeContract did not throw")
    },
    async stop() {
      for (const s of sockets) s.destroy()
      server.close()
      await once(server, "close")
    },
  }
}

/**
 * The error's `cause` chain, outermost first, as viem's own BaseError.walk visits it. The innermost
 * node of a JSON-RPC error is the node's raw `{ code, message }` body (no name) — shown as `<rpc body>`.
 */
export function chainNames(err) {
  const names = []
  const label = (e) => (e && typeof e === "object" ? (typeof e.name === "string" ? e.name : "<rpc body>") : typeof e)
  if (err && typeof err.walk === "function") {
    err.walk((e) => {
      names.push(label(e))
      return false
    })
  } else {
    for (let e = err, i = 0; e && i < 10; e = e.cause, i++) names.push(label(e))
  }
  return names
}
