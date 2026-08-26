# Feedback — fix/rpc-chain-identity-guard

## Where the guard lives, and its cache / re-verify intervals

Two new modules, plus wiring at the two call sites named in the prompt.

| File | Role |
|---|---|
| `src/lib/rpc-chain-identity.ts` | The verdict logic, the cache, and a plain-`fetch` JSON-RPC probe. No viem import, so an API route can use it. |
| `src/lib/rpc-guarded-transport.ts` | `guardedHttp(url, chainId, config)` — a drop-in for viem's `http()` that runs the guard before the first read. |
| `src/app/api/rpc/route.ts` | Calls `assertChainIdentity` after `getRpcUrlForChain`, before the forward. Mismatch ⇒ HTTP **502**, JSON-RPC code **-32006**, nothing forwarded. |
| `src/lib/wagmiConfig.ts` | Every transport (mainnet browser `/api/rpc`, mainnet server primary + 2 fallbacks + llamarpc last resort, Base, Arbitrum ×2) is now `guardedHttp`, never bare `http`. |

It follows `contracts/order-engine/executor/chain-verify.js` rather than inventing a second dialect:
the same `eth_chainId`-vs-configured-id check, the same **injected probe port** (so verification is
tested by injection, not by mocking a transport), the same bounded timeout, the same
name-both-values refusal style. It deliberately does **not** copy the keeper's fail-closed-on-
everything stance — see "The one judgement call" below.

**Verify once per `(chainId, endpoint)` per process, then cache.** Concurrent callers share a single
in-flight probe, so a cold instance taking 30 simultaneous requests pays one round-trip, not 30.

| Verdict | TTL | Why that number |
|---|---|---|
| `verified` | **30 min** | The only thing a TTL can catch is a provider silently re-pointing a URL — an ops env edit ships a new deployment, i.e. a new process, which re-verifies from cold anyway. 30 min bounds the exposure to minutes instead of the three **weeks** the incident ran, at a cost of one extra round-trip per chain per half hour on a warm instance. |
| `mismatch` | **60 s** | Shorter *on purpose*. While it stands we refuse from cache with no round-trip (a lying endpoint can't be turned into a request amplifier), but once ops corrects the endpoint the app recovers on its own within a minute. A sticky refusal would need a redeploy to clear — a second outage bolted onto the first. |
| `unverified` | **30 s** | This is the one verdict that lets traffic through unproven, so we want to be asking again soon. Not zero: re-probing every request during a provider outage would put exactly the per-request round-trip this module promises to avoid onto the hot path, at the worst possible moment. |

Probe timeout: **6 s** (`CHAIN_IDENTITY_PROBE_TIMEOUT_MS`), plus an `AbortController` on the fetch
probe so an accepted-then-silent endpoint is actually cancelled, not just abandoned.

## The verbatim mismatch error text

Asserted byte-for-byte by a test. For the production case (`expected 42161`, `reported 8453`):

```
RPC/chain mismatch — the RPC configured for chain 42161 reports chain 8453. Refusing to use it: an endpoint that answers for another chain returns wrong balances, wrong prices and wrong token metadata with no error at all. Point the chain-42161 RPC URL at chain 42161.
```

That exact string is: the `message` on the `mismatch` verdict; the `error.message` in the proxy's
502 body; and the message of the thrown `ChainIdentityError` (which also carries
`expectedChainId` / `reportedChainId` as fields). The `console.error` line is the same string
prefixed with `[chain-identity] `.

**The endpoint URL is deliberately absent from it.** RPC URLs routinely carry the provider key in
the path (`…/v2/<key>`) or the userinfo (`https://ops:<key>@host`), and this string reaches both a
server log and a client-facing JSON body. The two chain ids are the whole diagnosis. Pinned by
tests on both the proxy (`SUPERSECRETKEY` / host absent from the 502 body) and the transport.

## Acceptance results

1. **A test that FAILS when a chain's configured RPC reports a different chain id.** ✅ Four
   layers, each pointing one chain's URL at another chain's endpoint:
   - `src/lib/rpc-guarded-transport.test.ts` — the Arbitrum-configured URL answers `0x2105`; the
     read is refused, the error names 42161 and 8453, and `eth_getBalance` is *never sent*
     (`methodsSent` is exactly `['eth_chainId']`).
   - `src/lib/wagmiConfig.test.ts` — through the real wired `config.getClient({chainId})`.
   - `src/lib/wagmiConfig.server.test.ts` — the server-side mainnet ladder.
   - `src/app/api/rpc/route.test.ts` — `?chainId=42161` against a Base upstream ⇒ 502, both ids in
     the body, zero forwarded calls.
   Proof it isn't tautological: with the guard reverted to bare `http` on the mainnet transport,
   `wagmiConfig.server.test.ts` fails with `expected '0xdeadbeef' to contain 'chain 1'` and
   `expected [ 'eth_getBalance' ] to deeply equal [ 'eth_chainId' ]` — i.e. the incident itself.
2. **A test that an UNREACHABLE RPC still falls through and does NOT trip the guard.** ✅ Covered
   for transport reject, HTTP 5xx, JSON-RPC error envelope, malformed `eth_chainId`, and probe
   timeout — in the guard module, the transport, the wired wagmi config, and the proxy. In every
   case the read is still served and `console.error` is *not* called.
3. **A test that a read failure and a non-ERC-20 produce DIFFERENT messages.** ✅
   `src/hooks/useTokenImport.errors.test.ts`, including an explicit
   `expect(readFailure).not.toBe(notAToken)` and `expect(readFailure).not.toMatch(/not a valid/i)`.
4. **`/api/token-logo` serves 42161; lint + typecheck + touched suites pass.** ✅ 42161 resolves
   via CoinGecko's `arbitrum-one` list and falls back to the DefiLlama CDN; a registry-driven test
   asserts *every* `getSupportedChainIds()` chain is served. `npm run lint` exit 0 (94 warnings, at
   the existing `--max-warnings 94` ceiling — no new ones), `npm run typecheck` exit 0, and the
   **full** suite is **231 files / 3309 tests passing**.

## The one judgement call: what "malformed" means

The prompt names two outcomes — a different id (a lie) and no answer (an outage). A **malformed**
`eth_chainId` (`0x`, `"nope"`, an object) is neither: it proves the endpoint is unhealthy, not that
it is another chain, and a refusal that must "name both chain ids" cannot be issued when the second
value is garbage. It is therefore classified **`unverified`** (fall through, warn), not `mismatch`.
This is the one place the app guard diverges from the keeper's boot gate, which refuses on
malformed — correct there, because it is a one-shot gate for a fund-moving process with no fallback
ladder behind it. Flagging explicitly in case the Architect wants the stricter reading.

## Concern — there is a THIRD place that resolves an upstream, and it is still unguarded

`src/lib/chains/clients.ts` (`getPublicClientForChain`) builds `http(url)` / `fallback([http…])` per
chain straight from `registry.rpc.primary` + `rpc.fallbacks`, for every **non-mainnet** chain. It is
the server-side client behind quote simulation, portfolio and the on-chain monitor — so during the
incident window it had exactly the same exposure as the wagmi transports, from the same env var, and
it still does. It is outside this prompt's `Files` list so I did not touch it; the change is
mechanically a `http(` → `guardedHttp(` swap now that the module exists, but it sits on the quote
path, so it deserves its own scoped change and its own audit rather than riding along here.

Two smaller siblings, both mainnet-only and lower risk: `src/lib/rpc.ts` (`DIRECT_RPC_URL`, the
SSR/API-route direct path — the browser path goes through `/api/rpc`, which *is* guarded now) and
`src/lib/on-chain-monitor.ts`.

## Edge case — a mismatch inside a `fallback([...])` advances rather than hard-stopping

A `ChainIdentityError` carries no numeric JSON-RPC `code`, so viem's `fallback` does not treat it as
fatal and moves to the next transport — which carries its own independent guard. I believe this is
the right behaviour and have documented it in the module: the mismatching endpoint's response is
never passed through, the refusal is logged loudly, and the array can only ever serve an endpoint
that proved its identity or fail outright. Concretely, Arbitrum's ladder is
`[NEXT_PUBLIC_ARBITRUM_RPC_URL, arb1.arbitrum.io]` — during the incident the guard would have
refused entry 1 and served correct Arbitrum data from entry 2, loudly. Raising it here because
"advances to the next transport" could be *read* as degrading, and it is a deliberate choice, not an
oversight.

## Edge case — a JSON-RPC error is treated as "could not read", not "not a token"

In `useTokenImport`, an `error` envelope from `eth_call` counts as `unreadable`. A revert *can* mean
the contract lacks `symbol()`, so this over-reports "we could not read it" for genuinely broken
tokens. That is the intended bias and it follows the prompt's rule literally ("only a successful
read that fails the ERC-20 shape may call the token invalid"): over-reporting costs a retry,
under-reporting calls a user's token fake because our RPC was broken.

## Test gap left in place — `'Could not read token data'`

`useTokenImport` has a pre-existing third message for a read that *succeeded* but whose bytes would
not decode (empty symbol, `NaN` decimals). By the prompt's rule that is a successful read failing
the ERC-20 shape, so it arguably belongs under `TOKEN_NOT_ERC20_MESSAGE` — its current wording
("could not read") now points the finger at the transport, which is the mirror of the bug being
fixed. Left untouched as out of scope; the new transport message leads with "Network error —" so
the two are not confusable in the UI.

## Assumption corrected mid-implementation — the browser mainnet transport can't be tested in jsdom

`wagmiConfig.test.ts` runs under jsdom, where the mainnet transport is the relative `/api/rpc`.
viem builds a `new Request(url)` before fetching, and no non-browser runtime can construct one from
a relative path (`Failed to parse URL from /api/rpc`) — this is true with or without the guard.
Hence the new `src/lib/wagmiConfig.server.test.ts` (node env, absolute `NEXT_PUBLIC_RPC_URL`), which
covers the server ladder; the browser branch is covered structurally plus by the
`guardedHttp` unit tests.

## Test-surface facts worth knowing

- `vi.spyOn(console, 'error')` on an already-spied method returns the **same spy with its call
  history intact**. Without a `vi.restoreAllMocks()` first, a later case sees an earlier case's
  refusals — it cost one false failure here (`expected "error" to not be called at all, but
  actually been called 6 times`).
- `addCustomToken` appends to a **module-level array** in `lib/tokens`, which `localStorage.clear()`
  cannot reach. Hook tests that import a token must use a fresh address per case or
  `findChainToken` short-circuits the next one.
- `src/app/api/rpc/route.test.ts` now stubs `resolveProxyChainId` / `getRpcUrlForChain` through
  `vi.hoisted` so a case can choose the chain; upstream call assertions filter out the identity
  probe via `forwardedCalls()`.

## Not touched, per the prompt

No CSP host added (the guard's probe always uses the *same* URL as the transport it guards, so no
new origin is contacted). No RPC URL or env var changed. No `.sol`, keeper, or order-engine config.
No file deleted.
