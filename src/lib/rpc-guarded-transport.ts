/**
 * [FIX-RPC-CHAIN-IDENTITY-GUARD] `http()`, but it proves the endpoint IS the chain first.
 *
 * `wagmiConfig.ts` is the second place that resolves an upstream (the first is `/api/rpc`), and
 * viem has no opinion about which chain answered — it forwards whatever hex comes back. During the
 * incident the Arbitrum transport was pointed at a Base endpoint and every browser read, the
 * Chainlink feed hook included, was answered by Base with a clean 200.
 *
 * `guardedHttp(url, chainId)` is a drop-in for `http(url)` that runs `eth_chainId` against that
 * endpoint ONCE (per process, per endpoint, cached — see rpc-chain-identity.ts) before the first
 * read is allowed through, and refuses every read on that endpoint while it is proven to be
 * serving another chain.
 *
 * NO RECURSION: the identity probe calls the INNER transport's `request` directly, so it never
 * re-enters this wrapper. Guarding `eth_chainId` itself is therefore safe, and deliberate — a lie
 * must not escape through the one method that would confirm it.
 *
 * INSIDE A `fallback([...])`. A refusal here is an ordinary transport error with no JSON-RPC
 * `code`, so viem's fallback advances to the next transport — which carries its own independent
 * guard. That is the intended behaviour, not a hole: the mismatching endpoint's response is never
 * passed through, the refusal is logged loudly, and the array can only ever serve an endpoint that
 * proved its identity, or fail outright when none can. On a genuinely misconfigured chain whose
 * every entry lies, the ladder ends in a thrown error rather than wrong data.
 */
import { http, type HttpTransportConfig, type Transport } from 'viem'
import {
  assertChainIdentity,
  ChainIdentityError,
  CHAIN_IDENTITY_PROBE_TIMEOUT_MS,
} from '@/lib/rpc-chain-identity'

type InstantiatedTransport = ReturnType<ReturnType<typeof http>>

export function guardedHttp(
  url: string,
  expectedChainId: number,
  config?: HttpTransportConfig,
): Transport {
  const inner = http(url, config)

  return ((params: Parameters<Transport>[0]) => {
    const transport = inner(params) as InstantiatedTransport

    // The port, in the keeper's shape: identity verification asks a function for a chain id and
    // knows nothing about how it is fetched. Here that function is the un-wrapped transport.
    const probe = () => transport.request({ method: 'eth_chainId' })

    const request = async (args: unknown, options?: unknown) => {
      const verdict = await assertChainIdentity({
        expectedChainId,
        endpoint: url,
        probe,
        timeoutMs: config?.timeout ?? CHAIN_IDENTITY_PROBE_TIMEOUT_MS,
      })

      // MISMATCH is the only verdict that blocks. `unverified` is an outage — it proves nothing
      // about identity, so it must not cost the user a read that would otherwise have worked.
      if (verdict.status === 'mismatch') {
        throw new ChainIdentityError(
          verdict.expectedChainId,
          verdict.reportedChainId,
          verdict.message,
        )
      }

      return (transport.request as (a: unknown, o?: unknown) => Promise<unknown>)(args, options)
    }

    return {
      ...transport,
      // viem types `request` as the EIP-1193 overload set; the wrapper is transparent to it
      // (same arguments, same resolved value) so the cast asserts only what it already is.
      request: request as unknown as InstantiatedTransport['request'],
    }
  }) as Transport
}
