/**
 * [fix/user-ip-privacy] A local JSON-RPC upstream for the third-party-host capture.
 *
 * The capture lets the browser's `/api/rpc` calls reach the real route handler, so the proxy needs an
 * upstream. This is it: `http://127.0.0.1:<port>/<chainId>` answers as that chain, from this machine.
 * RPC_URL_1 / RPC_URL_8453 / RPC_URL_42161 point here (playwright.config.ts), so the Next server never
 * dials a provider during the run.
 *
 *   node e2e/third-party-hosts/rpc-stub.mjs [port]      # GET / answers 200 (the readiness probe)
 */
import { createServer } from 'node:http'

const port = Number(process.argv[2] ?? process.env.RPC_STUB_PORT ?? 3930)
const hex = (n) => `0x${n.toString(16)}`

function answer(chainId, rpc) {
  switch (rpc?.method) {
    case 'eth_chainId':
      return hex(chainId)
    case 'net_version':
      return String(chainId)
    case 'eth_blockNumber':
      return hex(23_541_870)
    case 'eth_getBalance':
    case 'eth_gasPrice':
    case 'eth_maxPriorityFeePerGas':
    case 'eth_estimateGas':
    case 'eth_getTransactionCount':
      return '0x0'
    case 'eth_getBlockByNumber':
      return { number: hex(23_541_870), timestamp: hex(Math.floor(Date.now() / 1000)), baseFeePerGas: '0x1', transactions: [] }
    default:
      return '0x' // eth_call & co: "nothing here" — reads decode to empty, which is all the capture needs
  }
}

createServer((req, res) => {
  if (req.method !== 'POST') {
    res.writeHead(200, { 'content-type': 'text/plain' }).end('rpc-stub ok')
    return
  }
  const chainId = Number(req.url?.split('/')[1]) || 1
  let raw = ''
  req.on('data', (c) => (raw += c))
  req.on('end', () => {
    let body
    try {
      body = JSON.parse(raw)
    } catch {
      res.writeHead(400).end()
      return
    }
    const one = (r) => ({ jsonrpc: '2.0', id: r?.id ?? null, result: answer(chainId, r) })
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(Array.isArray(body) ? body.map(one) : one(body)))
  })
}).listen(port, '127.0.0.1', () => console.log(`rpc-stub listening on http://127.0.0.1:${port}`))
